/**
 * GraphQL Admin API client: cost-aware throttling, jittered backoff, cursor
 * pagination, and mutation chunking — the single entry point every tool and
 * test goes through.
 *
 * Requests are plain fetch() POSTs to
 * `https://<storeDomain>/admin/api/<apiVersion>/graphql.json`, with the API
 * version pinned quarterly (default 2026-04) from `ShopifyConfig.apiVersion`.
 *
 * Cost-aware throttling: Shopify reports cost-budget state per response in
 * `extensions.cost.throttleStatus`. The client tracks `currentlyAvailable`
 * and `restoreRate` between requests and, when the next request's estimated
 * cost (an explicit `op.cost`, else the previous response's
 * `requestedQueryCost`) exceeds the available budget, sleeps until enough
 * budget restores before sending.
 *
 * Retries: a request is retried with full-jitter exponential backoff
 * (`baseDelayMs * 2^attempt`, random in [0,1], capped at `maxDelayMs`,
 * honoring a `Retry-After` header) on HTTP 429, HTTP 5xx, network errors,
 * and GraphQL responses whose errors mention throttling. After `maxRetries`
 * attempts the client throws a structured `ShopifyApiError` with code
 * SHOPIFY_THROTTLED or SHOPIFY_API_ERROR and a `hint`.
 */
import type { ShopifyConfig } from "../config.js";

export type GraphQLClientErrorCode = "SHOPIFY_THROTTLED" | "SHOPIFY_API_ERROR";

export interface GraphQLCost {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: {
    maximumAvailable: number;
    currentlyAvailable: number;
    restoreRate: number;
  };
}

export interface GraphQLErrorShape {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

export interface GraphQLResponse<T> {
  data: T | null;
  errors?: GraphQLErrorShape[];
  extensions?: { cost?: GraphQLCost };
}

export interface GraphqlOperation {
  query: string;
  variables?: Record<string, unknown>;
  /**
   * Estimated cost of this query in API cost points. When provided (or
   * carried over from the previous response's `requestedQueryCost`), the
   * client waits for budget to restore before sending.
   */
  cost?: number;
}

export interface AdminClientOptions {
  /** fetch implementation; defaults to globalThis.fetch. Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  /** Async sleep used for every backoff/budget wait. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Max retries for throttled/5xx/network failures. Default 5. */
  maxRetries?: number;
  /** Base backoff delay in ms for the first retry. Default 100. */
  baseDelayMs?: number;
  /** Upper cap on any single backoff delay in ms. Default 10_000. */
  maxDelayMs?: number;
}

interface ThrottleBudget {
  requestedQueryCost: number | null;
  currentlyAvailable: number | null;
  restoreRate: number | null;
}

/**
 * Structured Admin API error. `code` is machine-actionable, `message` is
 * human-readable, `hint` tells the caller what to do next — the same
 * convention as safe-write-mcp-core's PlanError and sw-postgres-mcp's
 * ToolFailure.
 */
export class ShopifyApiError extends Error {
  readonly code: GraphQLClientErrorCode;
  readonly hint: string;
  /** HTTP status of the failing response, or null for network failures. */
  readonly status: number | null;
  /** Number of retries already attempted before the failure was surfaced. */
  readonly retries: number;

  constructor(
    code: GraphQLClientErrorCode,
    message: string,
    hint: string,
    options: { status?: number | null; retries?: number } = {},
  ) {
    super(message);
    this.name = "ShopifyApiError";
    this.code = code;
    this.hint = hint;
    this.status = options.status ?? null;
    this.retries = options.retries ?? 0;
  }

  toJSON(): { code: GraphQLClientErrorCode; message: string; hint: string } {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

function hintForStatus(status: number): string {
  switch (status) {
    case 400:
      return "The request was malformed; check the GraphQL query and variables.";
    case 401:
    case 403:
      return "Check SHOPIFY_ADMIN_TOKEN: the token is missing, invalid, or lacks the scopes this query needs.";
    case 404:
      return "Check storeDomain and apiVersion in the config — the Admin API URL appears wrong.";
    default:
      return "Retry the request; if it persists, contact Shopify support with the HTTP status.";
  }
}

function hasThrottleError<T>(body: GraphQLResponse<T>): boolean {
  return body.errors?.some((e) => /throttl/i.test(e.message)) ?? false;
}

export class AdminClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private budget: ThrottleBudget = {
    requestedQueryCost: null,
    currentlyAvailable: null,
    restoreRate: null,
  };

  constructor(config: ShopifyConfig, options: AdminClientOptions = {}) {
    this.baseUrl = `https://${config.storeDomain}/admin/api/${config.apiVersion}/graphql.json`;
    this.token = config.adminToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleepImpl =
      options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 100;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
  }

  /** Runs one GraphQL query or mutation and returns its `data` object. */
  graphql<TData = Record<string, unknown>>(op: GraphqlOperation): Promise<TData> {
    return this.request<TData>(op);
  }

  private async request<TData>(op: GraphqlOperation): Promise<TData> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.waitForBudget(op);

      let response: Response;
      try {
        response = await this.fetchImpl(this.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Shopify-Access-Token": this.token,
          },
          body: JSON.stringify({ query: op.query, variables: op.variables ?? {} }),
        });
      } catch (err) {
        if (attempt === this.maxRetries) {
          throw new ShopifyApiError(
            "SHOPIFY_API_ERROR",
            `Network error talking to the Shopify Admin API: ${err instanceof Error ? err.message : String(err)}`,
            "Check network connectivity and that the store domain is reachable, then retry.",
            { retries: attempt },
          );
        }
        await this.backoff(attempt, null);
        continue;
      }

      const status = response.status;
      const body = this.parseBody<TData>(await response.text());

      const throttled = status === 429 || (body !== null && hasThrottleError(body));
      if (throttled) {
        this.budget.currentlyAvailable = 0;
        if (attempt === this.maxRetries) {
          throw new ShopifyApiError(
            "SHOPIFY_THROTTLED",
            `Shopify throttled this request even after ${this.maxRetries} retries.`,
            "Retry later, or split the operation into smaller queries and raise the delay between them.",
            { status, retries: attempt },
          );
        }
        await this.backoff(attempt, response.headers.get("retry-after"));
        continue;
      }

      if (status >= 500 && status < 600) {
        if (attempt === this.maxRetries) {
          throw new ShopifyApiError(
            "SHOPIFY_API_ERROR",
            `Shopify Admin API returned HTTP ${status} after ${this.maxRetries} retries.`,
            "Shopify is likely having an outage; retry later.",
            { status, retries: attempt },
          );
        }
        await this.backoff(attempt, response.headers.get("retry-after"));
        continue;
      }

      this.recordCost(body);

      if (!response.ok) {
        throw new ShopifyApiError(
          "SHOPIFY_API_ERROR",
          `Shopify Admin API returned HTTP ${status}.`,
          hintForStatus(status),
          { status, retries: attempt },
        );
      }

      if (body === null) {
        throw new ShopifyApiError(
          "SHOPIFY_API_ERROR",
          "Shopify Admin API returned an unparseable or empty response.",
          "Retry the request; if it persists, check the query and variables.",
          { status, retries: attempt },
        );
      }

      if (body.errors !== undefined && body.errors.length > 0) {
        throw new ShopifyApiError(
          "SHOPIFY_API_ERROR",
          body.errors[0]!.message,
          "Fix the GraphQL query per the error above, or check that the access token has the required scopes.",
          { status, retries: attempt },
        );
      }

      if (body.data === null || body.data === undefined) {
        throw new ShopifyApiError(
          "SHOPIFY_API_ERROR",
          "Shopify Admin API returned a response with no data.",
          "Retry the request; a missing data object may indicate a transient failure.",
          { status, retries: attempt },
        );
      }

      return body.data;
    }
    throw new ShopifyApiError(
      "SHOPIFY_API_ERROR",
      "Unexpected client state: the retry loop exited without a result.",
      "Report this as a bug in shopify-operations-mcp.",
    );
  }

  private async waitForBudget(op: GraphqlOperation): Promise<void> {
    if (this.budget.currentlyAvailable === null || this.budget.restoreRate === null) {
      return;
    }
    const cost = op.cost ?? this.budget.requestedQueryCost ?? 0;
    if (cost <= 0) return;
    const shortage = cost - this.budget.currentlyAvailable;
    if (shortage <= 0) return;
    const delayMs = (shortage / this.budget.restoreRate) * 1000;
    await this.sleepImpl(this.jitter(delayMs));
  }

  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    let delay = this.jitter(exponential);
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        delay = Math.min(this.maxDelayMs, seconds * 1000);
      }
    }
    await this.sleepImpl(delay);
  }

  private jitter(baseMs: number): number {
    return Math.random() * baseMs;
  }

  private parseBody<TData>(text: string): GraphQLResponse<TData> | null {
    if (text.trim() === "") return null;
    try {
      return JSON.parse(text) as GraphQLResponse<TData>;
    } catch {
      return null;
    }
  }

  private recordCost(body: GraphQLResponse<unknown> | null): void {
    const cost = body?.extensions?.cost;
    if (cost === undefined) return;
    if (cost.throttleStatus !== undefined) {
      this.budget.currentlyAvailable = cost.throttleStatus.currentlyAvailable;
      this.budget.restoreRate = cost.throttleStatus.restoreRate;
    }
    if (cost.requestedQueryCost !== undefined) {
      this.budget.requestedQueryCost = cost.requestedQueryCost;
    }
  }
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ConnectionLike<TNode> {
  edges: Array<{ node: TNode; cursor?: string }>;
  pageInfo: PageInfo;
}

export interface PaginateOptions<TNode> {
  /**
   * Query string. Must take `$first: Int` and `$cursor: String` and select
   * the connection's `edges { node }` and `pageInfo { hasNextPage endCursor }`
   * at `path`.
   */
  query: string;
  /** Extra variables merged under the reserved `$first`/`$cursor`. */
  variables?: Record<string, unknown>;
  /** Page size passed as `$first`. Default 250. */
  first?: number;
  /** Dot-separated path from the response `data` root to the connection
   * object, e.g. "products" or ["products"]. */
  path: string | readonly string[];
  /** Safety cap on the number of pages fetched. Default 1000. */
  maxPages?: number;
}

function resolvePath(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Fetches every node of a cursor-paginated connection by walking
 * `pageInfo.endCursor` until `hasNextPage` is false. Uses the reserved
 * `$first`/`$cursor` variables, so the query must be written against them
 * (see PaginateOptions.query).
 */
export async function paginateConnection<TNode>(
  client: AdminClient,
  opts: PaginateOptions<TNode>,
): Promise<TNode[]> {
  const path = typeof opts.path === "string" ? opts.path.split(".") : opts.path;
  const first = opts.first ?? 250;
  const maxPages = opts.maxPages ?? 1000;
  const nodes: TNode[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const data = await client.graphql<Record<string, unknown>>({
      query: opts.query,
      variables: { ...opts.variables, first, cursor },
    });
    const connection = resolvePath(data, path);
    if (connection === null || typeof connection !== "object") {
      throw new ShopifyApiError(
        "SHOPIFY_API_ERROR",
        `Pagination path "${path.join(".")}" not found in the response data.`,
        "Check that the query selects the connection at the given path with edges/node/pageInfo fields.",
      );
    }
    const conn = connection as unknown as ConnectionLike<TNode>;
    if (!Array.isArray(conn.edges)) {
      throw new ShopifyApiError(
        "SHOPIFY_API_ERROR",
        `Pagination path "${path.join(".")}" has no edges array.`,
        "The query must select edges { node } on the connection.",
      );
    }
    for (const edge of conn.edges) {
      if (edge !== null && typeof edge === "object") nodes.push(edge.node);
    }
    const pageInfo = conn.pageInfo as PageInfo | undefined;
    if (pageInfo === undefined || pageInfo.hasNextPage !== true || !pageInfo.endCursor) {
      break;
    }
    cursor = pageInfo.endCursor;
  }
  return nodes;
}

/** Conservative batch size for Shopify mutations. */
export const DEFAULT_CHUNK_SIZE = 50;

/**
 * Splits `items` into consecutive batches of at most `maxSize` items. The
 * default batch size (DEFAULT_CHUNK_SIZE) is deliberately conservative for
 * Shopify mutations so a single failing batch is cheap to re-run.
 */
export function chunk<T>(items: readonly T[], maxSize: number = DEFAULT_CHUNK_SIZE): T[][] {
  if (maxSize <= 0) throw new RangeError("chunk maxSize must be >= 1");
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += maxSize) {
    batches.push(items.slice(i, i + maxSize));
  }
  return batches;
}