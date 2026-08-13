/**
 * Order cancellation: an always-approval, irreversible write tool.
 *
 * Cancellation is permanent — an order cannot be uncancelled, and the payment
 * cannot be "unwired" by rolling back a `before` value. This is why:
 *
 * - **Unconditional approval gating**: `alwaysRequireApproval: true` is passed
 *   to `PlanStore.create()` so every cancel plan — regardless of item count —
 *   lands in `awaiting_approval` status. Approval thresholds are never
 *   consulted for this tool.
 *
 * - **Zero snapshot store**: unlike reversible write tools (prices, inventory),
 *   this tool does not call `snapshotStore.capture()` at preview time, so the
 *   rollback window is never opened. Attempting to roll back a cancel_order
 *   plan token is refused with `ROLLBACK_UNSUPPORTED` by the RollbackPlan
 *   module (see rollbackPlan.ts and its tests).
 *
 * - **Preview mutation**: `orderCancelOrder` is a zero-write preview that
 *   returns refund implication and flagged line items — the same data the
 *   human approval surface renders before granting or denying.
 *
 * - **Execute mutation**: `orderCancel` applies the cancellation with the
 *   `restock` and `notifyCustomer` flags the agent supplied.
 */
import { PlanStore } from "safe-write-mcp-core";
import type { AuditEvent, AuditSink, PlanMeta } from "safe-write-mcp-core";
import type { Manifest, ManifestBuilder, ManifestItem, StateReader } from "../plans/manifest.js";
import type { Executor, ItemOutcome } from "../plans/executor.js";
import { runLedger } from "../plans/executor.js";

import type { AdminClient } from "../graphql/adminClient.js";

/** The tool name registered in the plan store and audit rows. */
export const TOOL_CANCEL_ORDER = "cancel_order";

/** Cancellation reason codes Shopify accepts. */
export const CANCEL_REASONS = [
  "customer",
  "inventory",
  "fraud",
  "other",
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * Arguments the agent supplies to cancel one order.
 */
export interface CancelOrderArgs {
  /** The order `id` (GID format, e.g. `gid://shopify/Order/123`). */
  orderId: string;
  /**
   * Why the order is being cancelled. Recorded in the audit row and passed
   * to the Shopify `orderCancel` mutation.
   */
  reason: CancelReason;
  /**
   * Whether to return items to inventory. When `true`, each line item's
   * inventory is restored. Passed to the Shopify `orderCancel` mutation as
   * `restockLineItems`.
   */
  restock: boolean;
  /**
   * Whether to send an email notification to the customer. Passed to the
   * Shopify `orderCancel` mutation as `notifyCustomer`.
   */
  notifyCustomer: boolean;
}

/**
 * What the preview `orderCancelOrder` mutation returns: the refund implication
 * and any flags the human should see before approving.
 */
export interface CancelOrderPreview {
  orderId: string;
  orderName: string;
  totalPrice: string;
  refundedAmount: string;
  restockedLineItems: string[];
  flags: string[];
}

/**
 * The before/after shape for a cancel plan: both are the order's current
 * state (cancellation changes status but the ref stays the same). The payload
 * carries the cancellation parameters the executor needs.
 */
export interface CancelOrderManifestItem
  extends ManifestItem<CancelOrderPreview, CancelOrderPreview, Omit<CancelOrderArgs, "orderId">> {
  ref: string;
  before: CancelOrderPreview;
  after: CancelOrderPreview;
  payload: Omit<CancelOrderArgs, "orderId">;
}

interface CancelOrderPreviewResponse {
  orderCancelOrder: {
    order: {
      id: string;
      name: string;
      totalPrice: string;
      refundedSettlements: { amount: string }[];
      lineItems: { edges: { node: { id: string; title: string; quantity: number } }[] };
    };
    userErrors: { field: string; message: string }[];
  };
}

interface CancelOrderResponse {
  orderCancel: {
    order: {
      id: string;
      name: string;
      cancelCode: string;
    };
    userErrors: { field: string; message: string }[];
  };
}

const ORDER_CANCEL_PREVIEW_QUERY = `
  query CancelOrderPreview($id: ID!) {
    orderCancelOrder(id: $id) {
      order {
        id
        name
        totalPrice
        refundedSettlements(first: 10) {
          amount
        }
        lineItems(first: 250) {
          edges {
            node {
              id
              title
              quantity
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_CANCEL_MUTATION = `
  mutation OrderCancel($id: ID!, $reason: OrderCancelReason!, $restockLineItems: Boolean!, $notifyCustomer: Boolean!) {
    orderCancel(id: $id, cancelReason: $reason, restockLineItems: $restockLineItems, notifyCustomer: $notifyCustomer) {
      order {
        id
        name
        cancelCode
      }
      userErrors {
        field
        message
      }
    }
  }
`;

class CancelOrderManifestBuilder implements ManifestBuilder<CancelOrderManifestItem> {
  constructor(
    private client: AdminClient,
    private args: CancelOrderArgs,
  ) {}

  async build(): Promise<Manifest<CancelOrderManifestItem>> {
    const data = await this.client.graphql<CancelOrderPreviewResponse>({
      query: ORDER_CANCEL_PREVIEW_QUERY,
      variables: { id: this.args.orderId },
      cost: 10,
    });

    const result = data.orderCancelOrder;
    if (result.userErrors.length > 0) {
      throw new Error(`Preview error: ${result.userErrors[0]!.message}`);
    }

    const order = result.order;
    const refundedAmount = order.refundedSettlements
      .map((s: { amount: string }) => s.amount)
      .join(", ");
    const restockedLineItems = order.lineItems.edges
      .filter((e: { node: { quantity: number } }) => this.args.restock && e.node.quantity > 0)
      .map((e: { node: { title: string } }) => e.node.title);

    const flags: string[] = [];
    if (this.args.restock) flags.push("will_restock");
    if (this.args.notifyCustomer) flags.push("will_notify_customer");
    if (refundedAmount) flags.push(`refund:${refundedAmount}`);

    const before: CancelOrderPreview = {
      orderId: order.id,
      orderName: order.name,
      totalPrice: order.totalPrice,
      refundedAmount: refundedAmount || "(none)",
      restockedLineItems,
      flags,
    };

    const after: CancelOrderPreview = {
      ...before,
      flags: [...flags, "cancelled"],
    };

    return {
      items: [
        {
          ref: this.args.orderId,
          before,
          after,
          payload: {
            reason: this.args.reason,
            restock: this.args.restock,
            notifyCustomer: this.args.notifyCustomer,
          },
        },
      ],
      digest: "",
      beforeDigest: "",
    };
  }
}

class CancelOrderStateReader implements StateReader<CancelOrderPreview> {
  constructor(
    private client: AdminClient,
    private args: CancelOrderArgs,
  ) {}

  async readCurrent(refs: readonly string[]): Promise<Readonly<Record<string, CancelOrderPreview>>> {
    if (refs.length === 0) return {};
    const data = await this.client.graphql<CancelOrderPreviewResponse>({
      query: ORDER_CANCEL_PREVIEW_QUERY,
      variables: { id: this.args.orderId },
      cost: 10,
    });
    const order = data.orderCancelOrder.order;
    return {
      [this.args.orderId]: {
        orderId: order.id,
        orderName: order.name,
        totalPrice: order.totalPrice,
        refundedAmount: "(unknown at execute time)",
        restockedLineItems: [],
        flags: [],
      },
    };
  }
}

class CancelOrderExecutor implements Executor<CancelOrderManifestItem, void> {
  constructor(
    private client: AdminClient,
    private args: CancelOrderArgs,
  ) {}

  async execute(item: CancelOrderManifestItem): Promise<ItemOutcome<void>> {
    try {
      const data = await this.client.graphql<CancelOrderResponse>({
        query: ORDER_CANCEL_MUTATION,
        variables: {
          id: this.args.orderId,
          reason: this.args.reason,
          restockLineItems: this.args.restock,
          notifyCustomer: this.args.notifyCustomer,
        },
        cost: 10,
      });

      const result = data.orderCancel;
      if (result.userErrors.length > 0) {
        return {
          ref: item.ref,
          ok: false,
          error: {
            code: "CANCEL_ERROR",
            message: result.userErrors[0]!.message,
          },
        };
      }

      return { ref: item.ref, ok: true };
    } catch (err) {
      return {
        ref: item.ref,
        ok: false,
        error: {
          code: "CANCEL_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

export interface CancelOrderResult {
  status: "executed";
  orderId: string;
  orderName: string;
  succeededCount: number;
  failedCount: number;
}

/**
 * Full cancel_order flow: preview (zero writes) → token → human approval →
 * execute (orderCancel mutation).
 *
 * Always requires approval regardless of plan size. Never captures a
 * snapshot. RollbackPlan refuses cancel_order tokens with ROLLBACK_UNSUPPORTED.
 */
export async function cancelOrder(
  client: AdminClient,
  planStore: PlanStore<Manifest<CancelOrderManifestItem>>,
  audit: AuditSink,
  args: CancelOrderArgs,
  callerId: string = "unknown",
): Promise<{ preview: Manifest<CancelOrderManifestItem>; planToken: string; status: "awaiting_approval" }> {
  const startedAt = Date.now();
  const tool = TOOL_CANCEL_ORDER;

  const builder = new CancelOrderManifestBuilder(client, args);
  const manifest = await builder.build();

  const created = planStore.create(manifest, {
    tool,
    reason: `cancel order ${args.orderId} reason=${args.reason} restock=${args.restock} notify=${args.notifyCustomer}`,
    callerId,
    previewCount: manifest.items.length,
    dataDigest: null,
    extra: {
      orderId: args.orderId,
      orderName: manifest.items[0]!.before.orderName,
      flags: manifest.items[0]!.before.flags,
    },
    alwaysRequireApproval: true,
    approvalRequired: false,
  });

  const meta: PlanMeta = {
    tool,
    reason: `cancel order ${args.orderId} reason=${args.reason} restock=${args.restock} notify=${args.notifyCustomer}`,
    callerId,
    previewCount: manifest.items.length,
    dataDigest: null,
    extra: {
      orderId: args.orderId,
      orderName: manifest.items[0]!.before.orderName,
      flags: manifest.items[0]!.before.flags,
    },
  };

  emitPreviewAudit(audit, startedAt, created.planToken, meta, manifest);

  return {
    preview: manifest,
    planToken: created.planToken,
    status: created.status as "awaiting_approval",
  };
}

export async function executeCancelOrder(
  client: AdminClient,
  planStore: PlanStore<Manifest<CancelOrderManifestItem>>,
  audit: AuditSink,
  planToken: string,
  manifest: Manifest<CancelOrderManifestItem>,
  args: CancelOrderArgs,
  callerId: string = "unknown",
): Promise<CancelOrderResult> {
  const startedAt = Date.now();
  const tool = TOOL_CANCEL_ORDER;

  const consumed = planStore.consume(planToken, manifest);
  if (!consumed.ok) {
    throw consumed.error;
  }
  const meta = consumed.meta!;

  const stateReader = new CancelOrderStateReader(client, args);
  const executor = new CancelOrderExecutor(client, args);

  const ledger = await runLedger(manifest.items, executor);

  const succeededCount = ledger.succeeded.length;
  const failedCount = ledger.failed.length;

  emitExecuteAudit(audit, startedAt, planToken, meta, ledger);

  return {
    status: "executed",
    orderId: args.orderId,
    orderName: manifest.items[0]?.before.orderName ?? args.orderId,
    succeededCount,
    failedCount,
  };
}

function emitPreviewAudit(
  audit: AuditSink,
  startedAt: number,
  planToken: string,
  meta: PlanMeta,
  manifest: Manifest<CancelOrderManifestItem>,
): void {
  const item = manifest.items[0];
  const event: AuditEvent = {
    ts: Date.now(),
    tool: TOOL_CANCEL_ORDER,
    reason: meta.reason,
    planToken,
    status: "awaiting_approval",
    previewCount: manifest.items.length,
    callerId: meta.callerId,
    durationMs: Date.now() - startedAt,
    detail: item
      ? `order=${item.before.orderName} flags=${JSON.stringify(item.before.flags)}`
      : null,
  };
  try {
    audit.record(event);
  } catch (err) {
    process.stderr.write(`audit sink failed: ${String(err)}\n`);
  }
}

function emitExecuteAudit(
  audit: AuditSink,
  startedAt: number,
  planToken: string,
  meta: PlanMeta,
  ledger: { succeeded: readonly { ref: string }[]; failed: readonly { ref: string; error?: { code: string; message: string } }[] },
): void {
  const detail = JSON.stringify({
    succeeded: ledger.succeeded.length,
    failed: ledger.failed.length,
    failures: ledger.failed.map((o) => ({
      ref: o.ref,
      code: o.error?.code ?? null,
      message: o.error?.message ?? null,
    })),
  });

  const event: AuditEvent = {
    ts: Date.now(),
    tool: TOOL_CANCEL_ORDER,
    reason: meta.reason,
    planToken,
    status: "executed",
    previewCount: meta.previewCount,
    callerId: meta.callerId,
    durationMs: Date.now() - startedAt,
    detail,
  };
  try {
    audit.record(event);
  } catch (err) {
    process.stderr.write(`audit sink failed: ${String(err)}\n`);
  }
}
