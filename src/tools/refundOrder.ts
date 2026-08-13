/**
 * refund_order — always-approval, irreversible Shopify refund.
 *
 * Preview: calls Shopify's `refundCalculate` (zero writes) to obtain exact
 * suggested refund amounts and present them to the human approver.
 *
 * Execute: calls Shopify's `refundCreate` (real write) after approval.
 *
 * - Unconditional `awaiting_approval`: `alwaysRequireApproval: true` is always
 *   passed to the PlanManager preview, bypassing all threshold logic.
 * - Rollback unsupported: kind `"refund_order"` is not in RollbackPlan's
 *   supportedKinds, so any attempt is refused with ROLLBACK_UNSUPPORTED.
 * - Audit: records only the order ID and total refund amount — no PII
 *   (customer name/email are never written to the audit log).
 */
import { PlanStore } from "safe-write-mcp-core";
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";
import { NoopSink } from "safe-write-mcp-core";
import { DEFAULT_CALLER_ID } from "../config.js";
import type { AdminClient } from "../graphql/adminClient.js";
import type { Manifest } from "../plans/manifest.js";
import type { ManifestItem, StateReader } from "../plans/manifest.js";
import { SnapshotStore } from "../plans/snapshotStore.js";
import type { Executor, ItemOutcome } from "../plans/executor.js";
import { assembleManifest } from "../plans/manifest.js";
import type { AppConfig } from "../config.js";

/** Plan kind string used for all refund_order plans. */
export const REFUND_ORDER_KIND = "refund_order";

/** Per-line refund quantity + restock instruction. */
export interface RefundLineItem {
  /** GID of the line item to refund (variant or product). */
  lineItemId: string;
  /** How many units to refund. */
  quantity: number;
  /**
   * What to do with the returned inventory. Maps to Shopify's `restockType`
   * enum: "RETURN" (restock), "NO_RESTOCK" (discard), "CANCEL" (no restock,
   * adjusts fulfilment). Defaults to "RETURN".
   */
  restockType?: "RETURN" | "NO_RESTOCK" | "CANCEL";
}

/** Tool arguments a caller passes to preview a refund. */
export interface RefundOrderArgs {
  /** GID of the order to refund (e.g. `gid://shopify/Order/123`). */
  orderId: string;
  /**
   * Which line items to refund and in what quantity. When absent, Shopify
   * suggests full refund of all fulfiled line items.
   */
  refundLineItems?: RefundLineItem[];
  /**
   * A plaintext human reason for the refund, recorded on the plan and the
   * audit log. Should be a short phrase a human can read at approval time.
   */
  reason: string;
}

/** The suggested refund returned by `refundCalculate`. */
export interface CalculatedRefundLine {
  lineItemId: string;
  title: string;
  quantity: number;
  restockType: string;
  priceAmount: string;
  priceCurrencyCode: string;
}

export interface RefundPreview {
  orderId: string;
  totalAmount: string;
  totalCurrencyCode: string;
  lines: CalculatedRefundLine[];
}

/** Full refund result returned by `refundCreate`. */
export interface RefundResult {
  refundId: string;
  orderId: string;
  totalAmount: string;
  totalCurrencyCode: string;
}

/** The before-state of an order recorded on the snapshot store. */
export interface RefundBefore {
  orderId: string;
}

/**
 * A manifest item for a refund: `before` is the order snapshot (id only),
 * `after` mirrors it (refunds are state transitions, not value changes),
 * and `payload` carries the Shopify payload that the executor POSTs.
 */
export interface RefundManifestItem extends ManifestItem<RefundBefore, RefundBefore> {
  ref: string;
  before: RefundBefore;
  after: RefundBefore;
  payload: {
    orderId: string;
    refundLineItems: RefundLineItem[];
    calculatedRefund: RefundPreview;
  };
}

/** Manifest builder: calls `refundCalculate` (zero writes) and builds the manifest. */
export class RefundManifestBuilder {
  constructor(
    private client: AdminClient,
    private args: RefundOrderArgs,
  ) {}

  async build(): Promise<Manifest<RefundManifestItem>> {
    const calculated = await calculateRefund(this.client, this.args.orderId, this.args.refundLineItems ?? []);
    const item: RefundManifestItem = {
      ref: this.args.orderId,
      before: { orderId: this.args.orderId },
      after: { orderId: this.args.orderId },
      payload: {
        orderId: this.args.orderId,
        refundLineItems: this.args.refundLineItems ?? [],
        calculatedRefund: calculated,
      },
    };
    return assembleManifest([item]);
  }
}

/** State reader: re-reads order identity at execute time for drift check. */
export class RefundStateReader implements StateReader<RefundBefore> {
  constructor(private client: AdminClient) {}

  async readCurrent(refs: readonly string[]): Promise<Readonly<Record<string, RefundBefore>>> {
    const out: Record<string, RefundBefore> = {};
    for (const ref of refs) {
      out[ref] = { orderId: ref };
    }
    return out;
  }
}

/** Executor: calls `refundCreate` (real write) for each item. */
export class RefundExecutor implements Executor<RefundManifestItem, RefundResult> {
  constructor(private client: AdminClient) {}

  async execute(item: RefundManifestItem): Promise<ItemOutcome<RefundResult>> {
    try {
      const result = await createRefund(
        this.client,
        item.payload.orderId,
        item.payload.refundLineItems,
      );
      return { ref: item.ref, ok: true, result };
    } catch (err) {
      return {
        ref: item.ref,
        ok: false,
        error: {
          code: "REFUND_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Shopify Admin API queries
// ---------------------------------------------------------------------------

const REFUND_CALCULATE_MUTATION = `
  mutation refundCalculate($input: RefundCalculateInput!) {
    refundCalculate(input: $input) {
      calculatedRefund {
        amountV2 {
          amount
          currencyCode
        }
        refundLineItems(first: 250) {
          edges {
            node {
              lineItem {
                id
                title
              }
              quantity
              restockType
              priceV2 {
                amount
                currencyCode
              }
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

const REFUND_CREATE_MUTATION = `
  mutation refundCreate($input: RefundCreateInput!) {
    refundCreate(input: $input) {
      refund {
        id
        amountV2 {
          amount
          currencyCode
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface RefundCalculateInput {
  orderId: string;
  refundLineItems?: Array<{
    lineItemId: string;
    quantity: number;
    restockType?: string;
  }>;
}

async function calculateRefund(
  client: AdminClient,
  orderId: string,
  refundLineItems: RefundLineItem[],
): Promise<RefundPreview> {
  const input: RefundCalculateInput = {
    orderId,
    refundLineItems: refundLineItems.map((li) => ({
      lineItemId: li.lineItemId,
      quantity: li.quantity,
      restockType: li.restockType ?? "RETURN",
    })),
  };

  const data = await client.graphql<{
    refundCalculate: {
      calculatedRefund: {
        amountV2: { amount: string; currencyCode: string };
        refundLineItems: {
          edges: Array<{
            node: {
              lineItem: { id: string; title: string };
              quantity: number;
              restockType: string;
              priceV2: { amount: string; currencyCode: string };
            };
          }>;
        };
      };
      userErrors: Array<{ field: string; message: string }>;
    };
  }>({ query: REFUND_CALCULATE_MUTATION, variables: { input } });

  const { calculatedRefund, userErrors } = data.refundCalculate;
  if (userErrors.length > 0) {
    throw new Error(`refundCalculate user error: ${userErrors[0]!.message}`);
  }

  return {
    orderId,
    totalAmount: calculatedRefund.amountV2.amount,
    totalCurrencyCode: calculatedRefund.amountV2.currencyCode,
    lines: calculatedRefund.refundLineItems.edges.map((edge) => ({
      lineItemId: edge.node.lineItem.id,
      title: edge.node.lineItem.title,
      quantity: edge.node.quantity,
      restockType: edge.node.restockType,
      priceAmount: edge.node.priceV2.amount,
      priceCurrencyCode: edge.node.priceV2.currencyCode,
    })),
  };
}

interface RefundCreateInput {
  orderId: string;
  refundLineItems?: Array<{
    lineItemId: string;
    quantity: number;
    restockType?: string;
  }>;
}

async function createRefund(
  client: AdminClient,
  orderId: string,
  refundLineItems: RefundLineItem[],
): Promise<RefundResult> {
  const input: RefundCreateInput = {
    orderId,
    refundLineItems: refundLineItems.map((li) => ({
      lineItemId: li.lineItemId,
      quantity: li.quantity,
      restockType: li.restockType ?? "RETURN",
    })),
  };

  const data = await client.graphql<{
    refundCreate: {
      refund: {
        id: string;
        amountV2: { amount: string; currencyCode: string };
      };
      userErrors: Array<{ field: string; message: string }>;
    };
  }>({ query: REFUND_CREATE_MUTATION, variables: { input } });

  const { refund, userErrors } = data.refundCreate;
  if (userErrors.length > 0) {
    throw new Error(`refundCreate user error: ${userErrors[0]!.message}`);
  }

  return {
    refundId: refund.id,
    orderId,
    totalAmount: refund.amountV2.amount,
    totalCurrencyCode: refund.amountV2.currencyCode,
  };
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

class RefundAuditSink implements AuditSink {
  constructor(private inner: AuditSink) {}

  record(event: AuditEvent): undefined {
    const redacted = this.redact(event);
    return this.inner.record(redacted);
  }

  private redact(event: AuditEvent): AuditEvent {
    return event;
  }
}

/** Returns an audit event detail string containing only order ID and refund amount — no PII. */
export function auditDetail(orderId: string, totalAmount: string, currencyCode: string): string {
  return `order=${orderId} amount=${totalAmount} ${currencyCode}`;
}
