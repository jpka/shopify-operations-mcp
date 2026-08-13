import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShopifyConfig } from "../src/config.js";
import {
  AdminClient,
  DEFAULT_CHUNK_SIZE,
  ShopifyApiError,
  chunk,
  paginateConnection,
} from "../src/graphql/adminClient.js";
import type {
  AdminClientOptions,
  GraphQLResponse,
} from "../src/graphql/adminClient.js";

type FetchLike = NonNullable<AdminClientOptions["fetch"]>;

function shopifyConfig(overrides: Partial<ShopifyConfig> = {}): ShopifyConfig {
  return {
    storeDomain: "test.myshopify.com",
    apiVersion: "2026-04",
    adminToken: "shpat_testtoken123",
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function throttledResponse(status = 429): Response {
  return jsonResponse({ errors: [{ message: "Throttled" }] }, status);
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: { query: string; variables?: Record<string, unknown> };
}

/** Fake fetch that returns the queued responses/errors in order. */
function seqFetcher(
  responses: Array<Response | Error>,
): { fetch: FetchLike; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const initSafe = init ?? {};
    calls.push({
      url: String(input),
      init: initSafe,
      body: JSON.parse(String(initSafe.body ?? "{}")) as CapturedRequest["body"],
    });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("fake fetch ran out of responses");
    return next;
  };
  return { fetch: fetchImpl, calls };
}

function buildClient(
  fetchImpl: FetchLike,
  options: AdminClientOptions = {},
): { client: AdminClient; sleeps: number[] } {
  const sleeps: number[] = [];
  const client = new AdminClient(shopifyConfig(), {
    fetch: fetchImpl,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    baseDelayMs: 100,
    maxDelayMs: 400,
    maxRetries: 3,
    ...options,
  });
  return { client, sleeps };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminClient request (ticket #5)", () => {
  it("POSTs the query and variables to the pinned Admin API URL with the token header", async () => {
    const { fetch, calls } = seqFetcher([jsonResponse({ data: { ok: true } })]);
    const { client } = buildClient(fetch);

    const result = await client.graphql<{ ok: boolean }>({
      query: "{ ok }",
      variables: { id: "1" },
    });

    expect(result).toEqual({ ok: true });
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://test.myshopify.com/admin/api/2026-04/graphql.json");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": "shpat_testtoken123",
    });
    expect(call.body).toEqual({ query: "{ ok }", variables: { id: "1" } });
  });

  it("honors the configured storeDomain and apiVersion", async () => {
    const { fetch, calls } = seqFetcher([jsonResponse({ data: { ok: true } })]);
    const client = new AdminClient(
      shopifyConfig({ storeDomain: "other.myshopify.com", apiVersion: "2025-10" }),
      { fetch },
    );
    await client.graphql({ query: "{ ok }" });
    expect(calls[0]!.url).toBe("https://other.myshopify.com/admin/api/2025-10/graphql.json");
  });

  it("throws SHOPIFY_API_ERROR immediately on GraphQL-level errors (no retry)", async () => {
    const { fetch, calls } = seqFetcher([
      jsonResponse({ errors: [{ message: "Field 'foo' doesn't exist on type 'QueryRoot'" }] }),
    ]);
    const { client, sleeps } = buildClient(fetch);

    await expect(client.graphql({ query: "{ foo }" })).rejects.toMatchObject({
      name: "ShopifyApiError",
      code: "SHOPIFY_API_ERROR",
      hint: expect.stringContaining("query"),
    });
    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("throws SHOPIFY_API_ERROR immediately on non-retryable HTTP errors like 401", async () => {
    const { fetch, calls } = seqFetcher([
      jsonResponse({ errors: [{ message: "Invalid API key" }] }, 401),
    ]);
    const { client, sleeps } = buildClient(fetch);

    await expect(client.graphql({ query: "{ ok }" })).rejects.toMatchObject({
      code: "SHOPIFY_API_ERROR",
      status: 401,
      hint: expect.stringContaining("SHOPIFY_ADMIN_TOKEN"),
    });
    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("throws a JSON-serializable structured error", async () => {
    const { fetch } = seqFetcher([jsonResponse({}, 401)]);
    const { client } = buildClient(fetch);
    try {
      await client.graphql({ query: "{ ok }" });
      expect.unreachable("should have thrown");
    } catch (err) {
      const json = JSON.parse(JSON.stringify(err));
      expect(json).toEqual({
        code: "SHOPIFY_API_ERROR",
        message: expect.stringContaining("HTTP 401"),
        hint: expect.any(String),
      });
    }
  });
});

describe("AdminClient backoff (ticket #5)", () => {
  it("retries a 429 honoring Retry-After, then succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const throttled = new Response(JSON.stringify({ errors: [{ message: "Throttled" }] }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "2" },
    });
    const { fetch, calls } = seqFetcher([throttled, jsonResponse({ data: { ok: true } })]);
    const { client, sleeps } = buildClient(fetch, { maxDelayMs: 10_000 });

    const result = await client.graphql({ query: "{ ok }" });
    expect(result).toEqual({ ok: true });
    expect(calls.length).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it("retries a throttling error reported on HTTP 200, then succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const throttled = () => jsonResponse({ errors: [{ message: "Throttled: slow down" }] });
    const { fetch, calls } = seqFetcher([throttled(), throttled(), jsonResponse({ data: { ok: true } })]);
    const { client, sleeps } = buildClient(fetch);

    const result = await client.graphql({ query: "{ ok }" });
    expect(result).toEqual({ ok: true });
    expect(calls.length).toBe(3);
    expect(sleeps).toEqual([50, 100]);
  });

  it("backs off with full jitter before retrying 5xx responses", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { fetch, calls } = seqFetcher([
      jsonResponse({}, 500),
      jsonResponse({}, 503),
      jsonResponse({ data: { ok: true } }),
    ]);
    const { client, sleeps } = buildClient(fetch);

    const result = await client.graphql({ query: "{ ok }" });
    expect(result).toEqual({ ok: true });
    expect(calls.length).toBe(3);
    // full jitter with random()=0.5: 0.5 * min(maxDelay, 100*2^attempt)
    expect(sleeps).toEqual([50, 100]);
  });

  it("throws SHOPIFY_THROTTLED with a hint after exhausting retries on 429", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { fetch, calls } = seqFetcher([
      throttledResponse(),
      throttledResponse(),
      throttledResponse(),
      throttledResponse(),
    ]);
    const { client, sleeps } = buildClient(fetch);

    await expect(client.graphql({ query: "{ ok }" })).rejects.toMatchObject({
      code: "SHOPIFY_THROTTLED",
      status: 429,
      retries: 3,
      hint: expect.stringContaining("split the operation"),
    });
    expect(calls.length).toBe(4);
    expect(sleeps.length).toBe(3);
  });

  it("throws SHOPIFY_API_ERROR after exhausting retries on 5xx", async () => {
    const { fetch } = seqFetcher([
      jsonResponse({}, 500),
      jsonResponse({}, 502),
      jsonResponse({}, 503),
      jsonResponse({}, 504),
    ]);
    const { client } = buildClient(fetch);

    await expect(client.graphql({ query: "{ ok }" })).rejects.toMatchObject({
      code: "SHOPIFY_API_ERROR",
      status: 504,
      retries: 3,
    });
  });

  it("retries network errors with backoff, then throws SHOPIFY_API_ERROR", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { fetch, calls } = seqFetcher([
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
    ]);
    const { client, sleeps } = buildClient(fetch);

    await expect(client.graphql({ query: "{ ok }" })).rejects.toMatchObject({
      code: "SHOPIFY_API_ERROR",
      hint: expect.stringContaining("network"),
    });
    expect(calls.length).toBe(4);
    expect(sleeps.length).toBe(3);
  });
});

describe("AdminClient cost-aware throttling (ticket #5)", () => {
  function costResponse(currentlyAvailable: number): GraphQLResponse<{ ok: boolean }> {
    return {
      data: { ok: true },
      extensions: {
        cost: {
          requestedQueryCost: 10,
          throttleStatus: {
            maximumAvailable: 100,
            currentlyAvailable,
            restoreRate: 1,
          },
        },
      },
    };
  }

  it("waits for budget to restore before sending when the estimated cost exceeds availability", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { fetch, calls } = seqFetcher([
      jsonResponse(costResponse(5)),
      jsonResponse({ data: { ok: true } }),
    ]);
    const { client, sleeps } = buildClient(fetch);

    await client.graphql({ query: "{ ok }" });
    const result = await client.graphql({ query: "{ ok }" });
    expect(result).toEqual({ ok: true });
    expect(calls.length).toBe(2);
    // cost carries over from the first response's requestedQueryCost (10);
    // shortage 10 - 5 = 5 at 1 point/s => 5s.
    expect(sleeps).toEqual([5000]);
  });

  it("uses an explicit op.cost and waits for full restore when the budget is exhausted", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const exhausted: GraphQLResponse<{ ok: boolean }> = {
      data: { ok: true },
      extensions: {
        cost: {
          requestedQueryCost: 10,
          throttleStatus: {
            maximumAvailable: 100,
            currentlyAvailable: 0,
            restoreRate: 10,
          },
        },
      },
    };
    const { fetch, calls } = seqFetcher([
      jsonResponse(exhausted),
      jsonResponse({ data: { ok: true } }),
    ]);
    const { client, sleeps } = buildClient(fetch);

    await client.graphql({ query: "{ ok }" });
    await client.graphql({ query: "{ ok }", cost: 50 });
    // shortage 50 - 0 = 50 points at 10 points/s => 5s.
    expect(sleeps).toEqual([5000]);
    expect(calls.length).toBe(2);
  });

  it("does not wait when the budget is unknown or sufficient", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { fetch, calls } = seqFetcher([
      jsonResponse({ data: { ok: true } }),
      jsonResponse(costResponse(50)),
      jsonResponse({ data: { ok: true } }),
    ]);
    const { client, sleeps } = buildClient(fetch);

    await client.graphql({ query: "{ ok }" });
    await client.graphql({ query: "{ ok }" });
    await client.graphql({ query: "{ ok }" });
    expect(calls.length).toBe(3);
    expect(sleeps).toEqual([]);
  });
});

describe("paginateConnection (ticket #5)", () => {
  const QUERY =
    "query($first: Int!, $cursor: String) { products(first: $first, after: $cursor) { edges { node { id } } pageInfo { hasNextPage endCursor } } }";

  it("walks cursors until hasNextPage is false and returns every node", async () => {
    const pages = [
      { cursor: null, ids: [1, 2, 3], hasNext: true, endCursor: "c3" },
      { cursor: "c3", ids: [4, 5], hasNext: true, endCursor: "c5" },
      { cursor: "c5", ids: [6], hasNext: false, endCursor: null },
    ];
    const calls: Array<Record<string, unknown> | undefined> = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      const raw = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: Record<string, unknown>;
      };
      const variables = raw.variables ?? {};
      calls.push(variables);
      const page = pages.find((p) => p.cursor === (variables.cursor ?? null)) ?? pages.at(-1)!;
      return jsonResponse({
        data: {
          products: {
            edges: page.ids.map((id) => ({ node: { id: `gid://shopify/Product/${id}` } })),
            pageInfo: { hasNextPage: page.hasNext, endCursor: page.endCursor },
          },
        },
      });
    };
    const { client } = buildClient(fetchImpl);

    const nodes = await paginateConnection<{ id: string }>(client, {
      query: QUERY,
      first: 3,
      path: "products",
    });

    expect(nodes.map((n) => n.id)).toEqual([
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
      "gid://shopify/Product/3",
      "gid://shopify/Product/4",
      "gid://shopify/Product/5",
      "gid://shopify/Product/6",
    ]);
    expect(calls.length).toBe(3);
    expect(calls[0]).toMatchObject({ first: 3, cursor: null });
    expect(calls[1]).toMatchObject({ cursor: "c3" });
    expect(calls[2]).toMatchObject({ cursor: "c5" });
  });

  it("supports a dot-separated string path and merges caller variables", async () => {
    const { fetch, calls } = seqFetcher([
      jsonResponse({
        data: {
          orders: {
            edges: [{ node: { id: "gid://shopify/Order/1" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    ]);
    const { client } = buildClient(fetch);

    const nodes = await paginateConnection<{ id: string }>(client, {
      query: "query($first: Int!, $cursor: String) { orders(first: $first, after: $cursor, query: $filter) { edges { node { id } } pageInfo { hasNextPage endCursor } } }",
      variables: { filter: "status:OPEN" },
      first: 5,
      path: ["orders"],
    });

    expect(nodes.length).toBe(1);
    expect(calls[0]!.body.variables).toMatchObject({ first: 5, cursor: null, filter: "status:OPEN" });
  });

  it("throws SHOPIFY_API_ERROR when the connection path is missing from the response", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ data: { other: { edges: [] } } });
    const { client } = buildClient(fetchImpl);

    await expect(
      paginateConnection(client, { query: QUERY, path: "products" }),
    ).rejects.toMatchObject({
      code: "SHOPIFY_API_ERROR",
      message: expect.stringContaining('"products"'),
    });
  });
});

describe("chunk (ticket #5)", () => {
  it("splits items into consecutive batches of at most the given size", () => {
    expect(chunk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10],
    ]);
  });

  it("uses a conservative default batch size", () => {
    const items = Array.from({ length: DEFAULT_CHUNK_SIZE * 2 + 1 }, (_, i) => i);
    const batches = chunk(items);
    expect(batches.length).toBe(3);
    expect(batches[0]!.length).toBe(DEFAULT_CHUNK_SIZE);
    expect(batches[1]!.length).toBe(DEFAULT_CHUNK_SIZE);
    expect(batches[2]!.length).toBe(1);
  });

  it("returns an empty array for empty input and rejects a non-positive size", () => {
    expect(chunk([], 5)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});