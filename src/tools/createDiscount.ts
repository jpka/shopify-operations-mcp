import type { AuditSink, PlanStore } from "safe-write-mcp-core";
import type { AdminClient } from "../graphql/adminClient.js";
import { ShopifyApiError } from "../graphql/adminClient.js";
import type { Executor, ItemOutcome } from "../plans/executor.js";
import type {
  Manifest,
  ManifestBuilder,
  ManifestItem,
  StateReader,
} from "../plans/manifest.js";
import { assembleManifest } from "../plans/manifest.js";
import {
  PlanManager,
  type ExecuteResult,
  type PreviewOptions,
  type PreviewResult,
} from "../plans/planManager.js";
import type { SnapshotStore } from "../plans/snapshotStore.js";

/**
 * Discount creation is a reversible operation: a created discount can be
 * deactivated (or deleted), so it lives under the snapshot-store rollback
 * contract. A create plan's `before` state is `null` — the code did not exist
 * at preview time — and the snapshot store keeps exactly that, so a rollback
 * applies the inverse mutation (deactivate the created discount) to restore
 * the previewed "no discount" state. Normal item-count thresholds apply:
 * a plan touching at least `approvalRequiredAboveItems` discounts requires
 * human approval, and one touching more than `hardMaxItems` is refused.
 */

/** How a discount reduces the price: a percentage off, or a fixed amount in shop currency. */
export type DiscountValueType = "PERCENTAGE" | "FIXED_AMOUNT";

/**
 * Agent-supplied arguments for one discount to create. `value` is a
 * percentage (0 < value <= 100) for PERCENTAGE, or a fixed amount in shop
 * currency (> 0) for FIXED_AMOUNT. `usageLimit` and `appliesOncePerCustomer`
 * are optional usage constraints; `startsAt`/`endsAt` default to Shopify's
 * own defaults (start immediately, no end).
 */
export interface CreateDiscountInput {
  /** The discount code (e.g. "SUMMER20"); must be unique per store. */
  code: string;
  /** PERCENTAGE or FIXED_AMOUNT. */
  valueType: DiscountValueType;
  /** Percentage points (e.g. 20 = 20% off) or the fixed amount in shop currency. */
  value: number;
  /** Optional cap on how many times the code may be redeemed. */
  usageLimit?: number;
  /** Optional: apply the discount at most once per customer. Default false. */
  appliesOncePerCustomer?: boolean;
  /** Optional ISO-8601 start time. Defaults to Shopify's "now". */
  startsAt?: string;
  /** Optional ISO-8601 end time. Defaults to no end. */
  endsAt?: string;
}

/**
 * An existing discount code's state as read from the store. A create plan's
 * `before` state is deliberately `null` — the code did not exist at preview
 * time — so the snapshot store restores "no discount" by deactivating (or
 * deleting) the created discount on rollback.
 */
export interface ExistingDiscount {
  /** The discount node's global id (e.g. gid://shopify/DiscountCodeNode/1). */
  id: string;
  code: string;
  title: string;
  valueType: DiscountValueType;
  value: number;
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
  /** True while the discount is active (not deactivated). */
  active: boolean;
}

/**
 * The would-be discount a create plan describes: everything the code will
 * carry once created, minus the server-assigned id and lifecycle flags that
 * only materialize at execute time. Serves as the manifest's `after` for the
 * approval surface; the drift reference is `before` (null), never `after`.
 */
export interface CreateDiscountDraft {
  code: string;
  title: string;
  valueType: DiscountValueType;
  value: number;
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

/** One planned discount creation; `before` is null because the code is free to create. */
export interface CreateDiscountManifestItem
  extends ManifestItem<
    ExistingDiscount | null,
    CreateDiscountDraft,
    CreateDiscountInput
  > {
  ref: string;
  before: ExistingDiscount | null;
  after: CreateDiscountDraft;
  payload: CreateDiscountInput;
}

/**
 * The read/write boundary every discount operation crosses: find an existing
 * discount by code (the preview read and the execute-time drift re-read), and
 * create/deactivate discounts. The real implementation speaks Admin API
 * GraphQL through `AdminClient`; tests supply an in-memory toy API behind the
 * same interface (or, for the GraphQL contracts, a fake fetch serving one).
 */
export interface DiscountGateway {
  /** The discount carrying `code`, or null when the code is free to create. */
  findByCode(code: string): Promise<ExistingDiscount | null>;
  /** Creates a discount per `input`; returns the created discount with its id. */
  create(input: CreateDiscountInput): Promise<ExistingDiscount>;
  /** Deactivates a discount by id — the inverse mutation a rollback applies. */
  deactivate(id: string): Promise<void>;
}

interface DiscountUserError {
  field?: string[] | null;
  code?: string | null;
  message: string;
}

/** The nested node shape the Admin API returns for a DiscountCodeBasic. */
interface DiscountCodeBasicNode {
  id: string;
  status: string;
  codeDiscount: {
    title: string;
    startsAt?: string | null;
    endsAt?: string | null;
    usageLimit?: number | null;
    appliesOncePerCustomer?: boolean;
    customerGets: {
      value: {
        __typename: "DiscountPercentage" | "DiscountAmount";
        percentage?: number;
        amount?: number;
      };
    };
    codes: {
      edges: Array<{ node: { code: string } }>;
    };
  } | null;
}

const FIND_BY_CODE_QUERY = `
query discountByCode($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    id
    status
    codeDiscount {
      ... on DiscountCodeBasic {
        title
        startsAt
        endsAt
        usageLimit
        appliesOncePerCustomer
        customerGets {
          value {
            __typename
            ... on DiscountPercentage { percentage }
            ... on DiscountAmount { amount }
          }
        }
        codes(first: 1) {
          edges { node { code } }
        }
      }
    }
  }
}`;

const CREATE_MUTATION = `
mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode {
      id
      status
      codeDiscount {
        ... on DiscountCodeBasic {
          title
          startsAt
          endsAt
          usageLimit
          appliesOncePerCustomer
          customerGets {
            value {
              __typename
              ... on DiscountPercentage { percentage }
              ... on DiscountAmount { amount }
            }
          }
          codes(first: 1) {
            edges { node { code } }
          }
        }
      }
    }
    userErrors {
      field
      code
      message
    }
  }
}`;

const DEACTIVATE_MUTATION = `
mutation discountDeactivate($id: ID!) {
  discountDeactivate(id: $id) {
    codeDiscountNode { id }
    userErrors {
      field
      code
      message
    }
  }
}`;

/** Maps a DiscountCodeBasic node (read or freshly created) to the host shape. */
function existingDiscountFromNode(node: DiscountCodeBasicNode): ExistingDiscount {
  const discount = node.codeDiscount!;
  const value = discount.customerGets.value;
  const isPercentage = value.__typename === "DiscountPercentage";
  return {
    id: node.id,
    code: discount.codes.edges[0]?.node.code ?? "",
    title: discount.title,
    valueType: isPercentage ? "PERCENTAGE" : "FIXED_AMOUNT",
    value: isPercentage ? (value.percentage ?? 0) : (value.amount ?? 0),
    usageLimit: discount.usageLimit ?? null,
    appliesOncePerCustomer: discount.appliesOncePerCustomer ?? false,
    active: node.status === "ACTIVE",
  };
}

/** Builds the DiscountCodeBasicInput a create mutation sends. */
function createInput(input: CreateDiscountInput): Record<string, unknown> {
  const value =
    input.valueType === "PERCENTAGE"
      ? { percentage: input.value }
      : { amount: input.value };
  return {
    title: input.code,
    code: input.code,
    startsAt: input.startsAt ?? new Date().toISOString(),
    endsAt: input.endsAt ?? null,
    usageLimit: input.usageLimit ?? null,
    appliesOncePerCustomer: input.appliesOncePerCustomer ?? false,
    customerSelection: { all: true },
    customerGets: { value },
  };
}

/**
 * The real gateway: every call is one GraphQL operation through the shared
 * `AdminClient`, which owns throttling, backoff and structured errors.
 * `findByCode` and `create` parse the DiscountCodeBasic node shape; the
 * create mutation's `userErrors` (e.g. a duplicate code) surface as
 * `ShopifyApiError` for the executor to record on the ledger.
 */
export class ShopifyDiscountGateway implements DiscountGateway {
  constructor(private client: AdminClient) {}

  async findByCode(code: string): Promise<ExistingDiscount | null> {
    const data = await this.client.graphql<{
      codeDiscountNodeByCode: DiscountCodeBasicNode | null;
    }>({ query: FIND_BY_CODE_QUERY, variables: { code } });
    const node = data.codeDiscountNodeByCode;
    if (node === null || node.codeDiscount === null) return null;
    return existingDiscountFromNode(node);
  }

  async create(input: CreateDiscountInput): Promise<ExistingDiscount> {
    const data = await this.client.graphql<{
      discountCodeBasicCreate: {
        codeDiscountNode: DiscountCodeBasicNode | null;
        userErrors: DiscountUserError[];
      };
    }>({
      query: CREATE_MUTATION,
      variables: { basicCodeDiscount: createInput(input) },
    });
    const result = data.discountCodeBasicCreate;
    if (result.userErrors.length > 0) {
      const error = result.userErrors[0]!;
      throw new ShopifyApiError(
        "SHOPIFY_API_ERROR",
        error.message,
        `The Admin API refused to create discount code ${input.code} (${error.code ?? "user error"} on ${error.field ?? "unknown field"}).`,
      );
    }
    if (result.codeDiscountNode === null) {
      throw new ShopifyApiError(
        "SHOPIFY_API_ERROR",
        "The Admin API returned no created discount node.",
        "Retry the request; a missing node may indicate a transient failure.",
      );
    }
    return existingDiscountFromNode(result.codeDiscountNode);
  }

  async deactivate(id: string): Promise<void> {
    const data = await this.client.graphql<{
      discountDeactivate: {
        codeDiscountNode: { id: string } | null;
        userErrors: DiscountUserError[];
      };
    }>({ query: DEACTIVATE_MUTATION, variables: { id } });
    const result = data.discountDeactivate;
    if (result.userErrors.length > 0) {
      const error = result.userErrors[0]!;
      throw new ShopifyApiError(
        "SHOPIFY_API_ERROR",
        error.message,
        "The Admin API refused to deactivate the discount.",
      );
    }
  }
}

/** Validates one discount input; throws a preview-time error on invalid values. */
function validateCreateDiscountInput(input: CreateDiscountInput): void {
  const code = input.code.trim();
  if (code === "") {
    throw new Error("create_discount: discount code must be a non-empty string");
  }
  if (input.valueType !== "PERCENTAGE" && input.valueType !== "FIXED_AMOUNT") {
    throw new Error(
      `create_discount: valueType must be PERCENTAGE or FIXED_AMOUNT, got ${String(input.valueType)}`,
    );
  }
  if (!Number.isFinite(input.value)) {
    throw new Error("create_discount: value must be a finite number");
  }
  if (input.valueType === "PERCENTAGE" && !(input.value > 0 && input.value <= 100)) {
    throw new Error(
      `create_discount: PERCENTAGE value must be in (0, 100], got ${input.value}`,
    );
  }
  if (input.valueType === "FIXED_AMOUNT" && !(input.value > 0)) {
    throw new Error(
      `create_discount: FIXED_AMOUNT value must be > 0, got ${input.value}`,
    );
  }
  if (input.usageLimit !== undefined) {
    if (!Number.isInteger(input.usageLimit) || input.usageLimit <= 0) {
      throw new Error(
        `create_discount: usageLimit must be a positive integer, got ${String(input.usageLimit)}`,
      );
    }
  }
  if (
    input.appliesOncePerCustomer !== undefined &&
    typeof input.appliesOncePerCustomer !== "boolean"
  ) {
    throw new Error(
      `create_discount: appliesOncePerCustomer must be a boolean, got ${String(input.appliesOncePerCustomer)}`,
    );
  }
  for (const field of ["startsAt", "endsAt"] as const) {
    const value = input[field];
    if (value !== undefined) {
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        throw new Error(
          `create_discount: ${field} must be an ISO-8601 date string, got ${String(value)}`,
        );
      }
    }
  }
}

/** The manifest `after` for a create: the draft of the code that will exist. */
function draftOf(input: CreateDiscountInput): CreateDiscountDraft {
  return {
    code: input.code,
    title: input.code,
    valueType: input.valueType,
    value: input.value,
    usageLimit: input.usageLimit ?? null,
    appliesOncePerCustomer: input.appliesOncePerCustomer ?? false,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
  };
}

/**
 * Builds a create manifest from agent targets. Pure reads only: each target's
 * code is checked for existence and `before` is recorded as null, so the
 * manifest is the drift reference and the snapshot store's rollback target.
 * A duplicate code within the plan, or one that already exists, refuses the
 * preview — creating it could not honor the plan.
 */
export class CreateDiscountManifestBuilder
  implements ManifestBuilder<CreateDiscountManifestItem>
{
  constructor(
    private gateway: DiscountGateway,
    private inputs: readonly CreateDiscountInput[],
  ) {}

  async build(): Promise<Manifest<CreateDiscountManifestItem>> {
    const items: CreateDiscountManifestItem[] = [];
    const seen = new Set<string>();
    for (const raw of this.inputs) {
      validateCreateDiscountInput(raw);
      const code = raw.code.trim();
      if (seen.has(code)) {
        throw new Error(
          `create_discount: code ${code} appears more than once in this plan`,
        );
      }
      seen.add(code);
      const existing = await this.gateway.findByCode(code);
      if (existing) {
        throw new Error(
          `create_discount: discount code ${code} already exists (id ${existing.id}); pick a unique code`,
        );
      }
      const input: CreateDiscountInput = { ...raw, code };
      items.push({
        ref: code,
        before: null,
        after: draftOf(input),
        payload: input,
      });
    }
    return assembleManifest(items);
  }
}

/**
 * Re-reads current discount state at execute time for the STATE_CHANGED
 * drift check. Absent codes are returned as explicit null — matching the
 * preview's `before` — so a code that was free at preview and exists by
 * execute time reads as a non-null discount and the digest differs.
 */
export class DiscountStateReader implements StateReader<ExistingDiscount | null> {
  constructor(private gateway: DiscountGateway) {}

  async readCurrent(
    refs: readonly string[],
  ): Promise<Readonly<Record<string, ExistingDiscount | null>>> {
    const out: Record<string, ExistingDiscount | null> = {};
    for (const ref of refs) {
      out[ref] = await this.gateway.findByCode(ref);
    }
    return out;
  }
}

/**
 * The write half: one `discountCodeBasicCreate` per item. Gateway failures
 * (duplicate code races, invalid values, throttling exhausted) are recorded
 * as per-item outcomes, never thrown as internal errors, so a partial
 * failure surfaces on the ledger instead of aborting the plan.
 */
export class CreateDiscountExecutor
  implements Executor<CreateDiscountManifestItem, ExistingDiscount>
{
  constructor(private gateway: DiscountGateway) {}

  async execute(
    item: CreateDiscountManifestItem,
  ): Promise<ItemOutcome<ExistingDiscount>> {
    try {
      const created = await this.gateway.create(item.payload);
      return { ref: item.ref, ok: true, result: created };
    } catch (err) {
      const apiError = err instanceof ShopifyApiError ? err : null;
      return {
        ref: item.ref,
        ok: false,
        error: {
          code: apiError?.code ?? "DISCOUNT_CREATE_FAILED",
          message: err instanceof Error ? err.message : String(err),
          hint: apiError?.hint,
        },
      };
    }
  }
}

export interface CreateDiscountToolOptions {
  /** The Admin API client every read and write goes through. */
  client: AdminClient;
  /** Core plan store that owns the token lifecycle. */
  store: PlanStore<Manifest<CreateDiscountManifestItem>>;
  /** Gateway override (tests use a toy API); defaults to the GraphQL gateway. */
  gateway?: DiscountGateway;
  /** Per-plan before-state store for rollback. Defaults to one on `planTtlMs`. */
  snapshotStore?: SnapshotStore<ExistingDiscount | null>;
  /** Audit sink for host-emitted transitions. Defaults to the core's NoopSink. */
  audit?: AuditSink;
  /** Identity recorded as callerId when a preview call omits one. Default "unknown". */
  callerId?: string;
  /** Snapshot TTL and PlanStore TTL must agree; used for the default snapshot store. Default 60_000. */
  planTtlMs?: number;
  /** A plan touching at least this many discounts requires human approval. Default 25. */
  approvalRequiredAboveItems?: number;
  /** A plan touching more than this many discounts is refused — no token issued. Default 250. */
  hardMaxItems?: number;
}

/**
 * The create_discount two-phase tool: `preview` builds a manifest of pure
 * reads (each code checked for existence, `before` = null), then `execute`
 * consumes the token, re-reads for drift, and creates each discount through
 * the gateway with a per-item ledger. Reversible: the snapshot's `before`
 * nulls mean rollback deactivates the created discounts.
 */
export class CreateDiscountTool {
  readonly gateway: DiscountGateway;
  private manager: PlanManager<
    CreateDiscountManifestItem,
    ExistingDiscount | null,
    ExistingDiscount
  >;

  constructor(opts: CreateDiscountToolOptions) {
    this.gateway = opts.gateway ?? new ShopifyDiscountGateway(opts.client);
    this.manager = new PlanManager<
      CreateDiscountManifestItem,
      ExistingDiscount | null,
      ExistingDiscount
    >({
      store: opts.store,
      executor: new CreateDiscountExecutor(this.gateway),
      stateReader: new DiscountStateReader(this.gateway),
      snapshotStore: opts.snapshotStore,
      audit: opts.audit,
      callerId: opts.callerId,
      planTtlMs: opts.planTtlMs,
      approvalRequiredAboveItems: opts.approvalRequiredAboveItems,
      hardMaxItems: opts.hardMaxItems,
    });
  }

  /** Previews the discount creations: pure reads, zero mutation calls. */
  async preview(
    inputs: readonly CreateDiscountInput[],
    options: PreviewOptions,
  ): Promise<PreviewResult<CreateDiscountManifestItem>> {
    return this.manager.preview(
      new CreateDiscountManifestBuilder(this.gateway, inputs),
      options,
    );
  }

  /** Executes a previewed plan: drift check, then one create per item. */
  async execute(
    planToken: string,
    manifest: Manifest<CreateDiscountManifestItem>,
  ): Promise<ExecuteResult<CreateDiscountManifestItem, ExistingDiscount>> {
    return this.manager.executePlan(planToken, manifest);
  }
}