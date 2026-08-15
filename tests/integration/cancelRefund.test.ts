/**
 * Live integration suite: the irreversible write flows — cancel_order and
 * refund_order — against the real Admin API and seeded dev store.
 *
 * *** DESTRUCTIVE *** — these tests issue real, irreversible mutations:
 * one order is cancelled and one order is refunded. They are the point of the
 * ticket (proof against the live store) but are deliberately minimal: exactly
 * one cancel and one refund per run, targeting paid+unfulfilled seeded orders
 * discovered at runtime via list_orders (never hardcoded GIDs). Re-seed
 * (`npm run seed`) before re-running so fresh candidates exist.
 *
 * Env-gated: skipped entirely unless both SHOPIFY_STORE_DOMAIN and
 * SHOPIFY_ADMIN_TOKEN are set, so `npm test` and `npm run test:integration`
 * pass as a no-op without credentials.
 */
import { PlanStore } from "safe-write-mcp-core";
import { beforeAll, describe, expect, it } from "vitest";
import type { Manifest } from "../../src/plans/manifest.js";
import { PlanManager } from "../../src/plans/planManager.js";
import {
  cancelOrder,
  executeCancelOrder,
  TOOL_CANCEL_ORDER,
  type CancelOrderArgs,
  type CancelOrderManifestItem,
} from "../../src/tools/cancelOrder.js";
import { listOrders, type OrderSummary } from "../../src/tools/listOrders.js";
import {
  RefundExecutor,
  RefundManifestBuilder,
  REFUND_ORDER_KIND,
  RefundStateReader,
  type RefundBefore,
  type RefundManifestItem,
  type RefundOrderArgs,
  type RefundResult,
} from "../../src/tools/refundOrder.js";
import {
  buildFixture,
  integrationEnabled,
  MemorySink,
  type IntegrationFixture,
} from "./helpers.js";

const enabled = integrationEnabled();
if (!enabled) {
  console.warn(
    "[integration:cancelRefund] SKIPPED — set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN and run `npm run seed` first.",
  );
}
const describeSuite = enabled ? describe : describe.skip;

describeSuite("integration: cancel_order + refund_order irreversible flows", () => {
  let fx: IntegrationFixture;
  let cancelTarget: OrderSummary;
  let refundTarget: OrderSummary;

  beforeAll(async () => {
    fx = buildFixture();
    // Two distinct paid+unfulfilled seeded orders, discovered at runtime.
    const pool = await listOrders(fx.client, {
      financialStatus: "paid",
      fulfillmentStatus: "unfulfilled",
    });
    expect(pool.orders.length).toBeGreaterThanOrEqual(2);
    cancelTarget = pool.orders[0]!;
    refundTarget = pool.orders[1]!;
    expect(cancelTarget.id).not.toBe(refundTarget.id);
  });

  it("cancel_order previews (awaiting_approval), approves, and executes a real cancellation", async () => {
    const args: CancelOrderArgs = {
      orderId: cancelTarget.id,
      reason: "other",
      restock: false,
      notifyCustomer: false,
    };
    const planStore = new PlanStore<Manifest<CancelOrderManifestItem>>({ planTtlMs: 60_000 });
    const audit = new MemorySink();

    const previewed = await cancelOrder(
      fx.client,
      planStore,
      audit,
      args,
      "integration-tests",
    );
    expect(previewed.status).toBe("awaiting_approval");
    expect(previewed.preview.items[0]!.before.orderId).toBe(cancelTarget.id);
    expect(previewed.preview.items[0]!.before.orderName).toBe(cancelTarget.name);

    const approved = planStore.approve(previewed.planToken);
    expect(approved.ok).toBe(true);

    const result = await executeCancelOrder(
      fx.client,
      planStore,
      audit,
      previewed.planToken,
      previewed.preview,
      args,
      "integration-tests",
    );

    expect(result.status).toBe("executed");
    expect(result.orderId).toBe(cancelTarget.id);
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(0);

    const awaiting = audit.events.filter((e) => e.status === "awaiting_approval");
    const executed = audit.events.filter((e) => e.status === "executed");
    expect(awaiting.some((e) => e.tool === TOOL_CANCEL_ORDER)).toBe(true);
    expect(executed.some((e) => e.tool === TOOL_CANCEL_ORDER)).toBe(true);
  });

  it("refund_order previews (awaiting_approval), approves, and executes a real refund", async () => {
    const refundLineItems = refundTarget.lineItems.map((li) => ({
      lineItemId: li.id,
      quantity: li.quantity,
      restockType: "NO_RESTOCK" as const,
    }));
    expect(refundLineItems.length).toBeGreaterThan(0);

    const args: RefundOrderArgs = {
      orderId: refundTarget.id,
      reason: "live integration suite: refund of a seeded test order",
      refundLineItems,
    };

    const planStore = new PlanStore<Manifest<RefundManifestItem>>({ planTtlMs: 60_000 });
    const audit = new MemorySink();
    const manager = new PlanManager<RefundManifestItem, RefundBefore, RefundResult>({
      store: planStore,
      executor: new RefundExecutor(fx.client),
      stateReader: new RefundStateReader(fx.client),
      audit,
      callerId: "integration-tests",
    });

    const preview = await manager.preview(new RefundManifestBuilder(fx.client, args), {
      tool: REFUND_ORDER_KIND,
      reason: args.reason,
      alwaysRequireApproval: true,
    });
    expect(preview.status).toBe("awaiting_approval");
    expect(preview.itemCount).toBe(1);
    const calculated = preview.manifest.items[0]!.payload.calculatedRefund;
    expect(Number(calculated.totalAmount)).toBeGreaterThan(0);

    const approved = planStore.approve(preview.planToken);
    expect(approved.ok).toBe(true);

    const result = await manager.executePlan(preview.planToken, preview.manifest);

    expect(result.status).toBe("executed");
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(0);
    const outcome = result.ledger.succeeded[0]!;
    expect(outcome.result).toBeDefined();
    expect((outcome.result as RefundResult).orderId).toBe(refundTarget.id);

    const awaiting = audit.events.filter((e) => e.status === "awaiting_approval");
    const executed = audit.events.filter((e) => e.status === "executed");
    expect(awaiting.some((e) => e.tool === REFUND_ORDER_KIND)).toBe(true);
    expect(executed.some((e) => e.tool === REFUND_ORDER_KIND)).toBe(true);
  });
});