import { PlanError, PlanStore } from "safe-write-mcp-core";
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";
import { describe, expect, it, vi } from "vitest";
import { PlanManager } from "../../src/plans/planManager.ts";
import type { Manifest } from "../../src/plans/manifest.ts";
import { SnapshotStore } from "../../src/plans/snapshotStore.ts";
import { RollbackPlan } from "../../src/tools/rollbackPlan.ts";
import type { ExecutedPlan } from "../../src/tools/rollbackPlan.ts";
import {
  RefundManifestBuilder,
  RefundStateReader,
  RefundExecutor,
  REFUND_ORDER_KIND,
  auditDetail,
  type RefundManifestItem,
  type RefundOrderArgs,
  type RefundBefore,
} from "../../src/tools/refundOrder.ts";

type FetchLike = typeof globalThis.fetch;

const TOOL = "refund_order";

class MemorySink implements AuditSink {
  events: AuditEvent[] = [];

  record(event: AuditEvent): undefined {
    this.events.push(event);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Fake Shopify Admin API
// ---------------------------------------------------------------------------

interface FakeRefundLine {
  lineItemId: string;
  quantity: number;
  restockType: string;
  priceAmount: string;
  priceCurrencyCode: string;
}

interface CalculatedRefund {
  orderId: string;
  totalAmount: string;
  totalCurrencyCode: string;
  lines: FakeRefundLine[];
}

interface FakeShopifyStore {
  orderId: string;
  calculatedRefunds: Map<string, CalculatedRefund>;
  refundsCreated: Array<{ orderId: string; totalAmount: string }>;
}

function makeFakeStore(orderId = "gid://shopify/Order/1"): FakeShopifyStore {
  return {
    orderId,
    calculatedRefunds: new Map(),
    refundsCreated: [],
  };
}

function buildRefundCalculateResponse(store: FakeShopifyStore, orderId: string) {
  return {
    data: {
      refundCalculate: {
        calculatedRefund: {
          amountV2: { amount: "25.00", currencyCode: "USD" },
          refundLineItems: {
            edges: [
              {
                node: {
                  lineItem: { id: "gid://shopify/LineItem/100", title: "Widget" },
                  quantity: 2,
                  restockType: "RETURN",
                  priceV2: { amount: "25.00", currencyCode: "USD" },
                },
              },
            ],
          },
        },
        userErrors: [],
      },
    },
  };
}

function buildRefundCreateResponse(store: FakeShopifyStore, orderId: string) {
  return {
    data: {
      refundCreate: {
        refund: {
          id: "gid://shopify/Refund/999",
          amountV2: { amount: "25.00", currencyCode: "USD" },
        },
        userErrors: [],
      },
    },
  };
}

function makeFetch(fakeStore: FakeShopifyStore): FetchLike {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
    if (body.query.includes("refundCalculate")) {
      fakeStore.calculatedRefunds.set(fakeStore.orderId, {
        orderId: fakeStore.orderId,
        totalAmount: "25.00",
        totalCurrencyCode: "USD",
        lines: [
          {
            lineItemId: "gid://shopify/LineItem/100",
            quantity: 2,
            restockType: "RETURN",
            priceAmount: "25.00",
            priceCurrencyCode: "USD",
          },
        ],
      });
      return new Response(JSON.stringify(buildRefundCalculateResponse(fakeStore, fakeStore.orderId)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (body.query.includes("refundCreate")) {
      fakeStore.refundsCreated.push({
        orderId: fakeStore.orderId,
        totalAmount: "25.00",
      });
      return new Response(JSON.stringify(buildRefundCreateResponse(fakeStore, fakeStore.orderId)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: null, errors: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ---------------------------------------------------------------------------
// AdminClient factory (avoids touching real network)
// ---------------------------------------------------------------------------

import { AdminClient } from "../../src/graphql/adminClient.ts";
import type { ShopifyConfig } from "../../src/config.ts";

function makeClient(fetchImpl: FetchLike): AdminClient {
  const config: ShopifyConfig = {
    storeDomain: "test.myshopify.com",
    apiVersion: "2026-04",
    adminToken: "shpat_testtoken123",
  };
  return new AdminClient(config, { fetch: fetchImpl });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface RefundFixture {
  store: FakeShopifyStore;
  client: AdminClient;
  planStore: PlanStore<Manifest<RefundManifestItem>>;
  snapshotStore: SnapshotStore<RefundBefore>;
  audit: MemorySink;
  manager: PlanManager<RefundManifestItem, RefundBefore, void>;
  rollback: RollbackPlan<RefundBefore, void>;
  executed: Map<string, ExecutedPlan>;
}

function makeFixture(): RefundFixture {
  const store = makeFakeStore();
  const fetchImpl = makeFetch(store);
  const client = makeClient(fetchImpl);
  const audit = new MemorySink();
  const planStore = new PlanStore<Manifest<RefundManifestItem>>({ planTtlMs: 60_000, audit });
  const snapshotStore = new SnapshotStore<RefundBefore>(60_000);
  const manager = new PlanManager<RefundManifestItem, RefundBefore, void>({
    store: planStore,
    executor: new RefundExecutor(client),
    stateReader: new RefundStateReader(client),
    snapshotStore,
    audit,
    callerId: "tester",
  });
  const executed = new Map<string, ExecutedPlan>();
  const rollback = new RollbackPlan<RefundBefore, void>({
    snapshotStore,
    executedOf: (planToken) => executed.get(planToken) ?? null,
    supportedKinds: ["update_prices"],
    executor: {
      execute() {
        return { ref: "", ok: false, error: { code: "UNEXPECTED", message: "rollback not supported for refund_order" } };
      },
    },
    audit,
    callerId: "tester",
  });
  return { store, client, planStore, snapshotStore, audit, manager, rollback, executed };
}

async function previewAndExecute(
  fx: RefundFixture,
  args: RefundOrderArgs,
): Promise<{ planToken: string; succeededRefs: readonly string[] }> {
  const preview = await fx.manager.preview(new RefundManifestBuilder(fx.client, args), {
    tool: TOOL,
    reason: args.reason,
    alwaysRequireApproval: true,
  });
  fx.planStore.approve(preview.planToken);
  const result = await fx.manager.executePlan(preview.planToken, preview.manifest);
  const succeededRefs = result.ledger.succeeded.map((o) => o.ref);
  fx.executed.set(preview.planToken, { kind: REFUND_ORDER_KIND, executedRefs: succeededRefs });
  return { planToken: preview.planToken, succeededRefs };
}

async function errorOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refund_order (ticket #14)", () => {
  describe("preview via refundCalculate", () => {
    it("calls refundCalculate (zero writes) and returns a manifest with exact suggested amounts", async () => {
      const fx = makeFixture();
      const calculateSpy = vi.spyOn(fx.client, "graphql");

      const args: RefundOrderArgs = {
        orderId: "gid://shopify/Order/1",
        reason: "Customer returned item",
      };

      const preview = await fx.manager.preview(new RefundManifestBuilder(fx.client, args), {
        tool: TOOL,
        reason: args.reason,
        alwaysRequireApproval: true,
      });

      expect(preview.status).toBe("awaiting_approval");
      expect(preview.itemCount).toBe(1);
      expect(preview.manifest.items[0]!.ref).toBe("gid://shopify/Order/1");
      expect(preview.manifest.items[0]!.payload.calculatedRefund.totalAmount).toBe("25.00");
      expect(preview.manifest.items[0]!.payload.calculatedRefund.lines).toHaveLength(1);
      expect(preview.manifest.items[0]!.payload.calculatedRefund.lines[0]!.title).toBe("Widget");

      expect(calculateSpy.mock.calls.some((c) => c[0]?.query?.includes("refundCalculate"))).toBe(true);
      expect(fx.store.refundsCreated).toHaveLength(0);
    });

    it("records no PII in the preview audit event", async () => {
      const fx = makeFixture();

      await fx.manager.preview(
        new RefundManifestBuilder(fx.client, {
          orderId: "gid://shopify/Order/1",
          reason: "Customer returned item",
        }),
        { tool: TOOL, reason: "Customer returned item", alwaysRequireApproval: true },
      );

      const previewed = fx.audit.events.find((e) => e.status === "awaiting_approval");
      expect(previewed).toBeDefined();
      expect(previewed!.tool).toBe(TOOL);
      expect(previewed!.callerId).toBe("tester");
    });
  });

  describe("unconditional awaiting_approval", () => {
    it("always returns awaiting_approval regardless of item count", async () => {
      const fx = makeFixture();

      const result = await fx.manager.preview(
        new RefundManifestBuilder(fx.client, {
          orderId: "gid://shopify/Order/1",
          reason: "Single item",
        }),
        { tool: TOOL, reason: "Single item", alwaysRequireApproval: true },
      );

      expect(result.status).toBe("awaiting_approval");

      const preview2 = await fx.manager.preview(
        new RefundManifestBuilder(fx.client, {
          orderId: "gid://shopify/Order/2",
          reason: "Another single item",
        }),
        { tool: TOOL, reason: "Another single item", alwaysRequireApproval: true },
      );

      expect(preview2.status).toBe("awaiting_approval");
    });

    it("refuses execute without prior approval (AWAITING_APPROVAL)", async () => {
      const fx = makeFixture();

      const preview = await fx.manager.preview(
        new RefundManifestBuilder(fx.client, {
          orderId: "gid://shopify/Order/1",
          reason: "Return",
        }),
        { tool: TOOL, reason: "Return", alwaysRequireApproval: true },
      );

      const err = await errorOf(fx.manager.executePlan(preview.planToken, preview.manifest));
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).code).toBe("AWAITING_APPROVAL");
    });

    it("executes after planStore approval", async () => {
      const fx = makeFixture();

      const preview = await fx.manager.preview(
        new RefundManifestBuilder(fx.client, {
          orderId: "gid://shopify/Order/1",
          reason: "Return",
        }),
        { tool: TOOL, reason: "Return", alwaysRequireApproval: true },
      );

      const approved = fx.planStore.approve(preview.planToken);
      expect(approved.ok).toBe(true);

      const result = await fx.manager.executePlan(preview.planToken, preview.manifest);
      expect(result.status).toBe("executed");
      expect(result.succeededCount).toBe(1);
      expect(fx.store.refundsCreated).toHaveLength(1);
      expect(fx.store.refundsCreated[0]!.orderId).toBe("gid://shopify/Order/1");
    });
  });

  describe("execute via refundCreate", () => {
    it("creates a refund after approval and returns the result", async () => {
      const fx = makeFixture();

      const preview = await fx.manager.preview(
        new RefundManifestBuilder(fx.client, {
          orderId: "gid://shopify/Order/1",
          reason: "Return",
        }),
        { tool: TOOL, reason: "Return", alwaysRequireApproval: true },
      );

      fx.planStore.approve(preview.planToken);
      const result = await fx.manager.executePlan(preview.planToken, preview.manifest);

      expect(result.status).toBe("executed");
      expect(result.succeededCount).toBe(1);
      expect(result.ledger.succeeded[0]!.result).toMatchObject({
        refundId: "gid://shopify/Refund/999",
        orderId: "gid://shopify/Order/1",
        totalAmount: "25.00",
        totalCurrencyCode: "USD",
      });
      expect(fx.store.refundsCreated).toHaveLength(1);
    });

    it("audits the executed event with order ID and amount only (no PII)", async () => {
      const fx = makeFixture();

      const preview = await fx.manager.preview(
        new RefundManifestBuilder(fx.client, {
          orderId: "gid://shopify/Order/1",
          reason: "Return",
        }),
        { tool: TOOL, reason: "Return", alwaysRequireApproval: true },
      );

      fx.planStore.approve(preview.planToken);
      await fx.manager.executePlan(preview.planToken, preview.manifest);

      const executed = fx.audit.events.find((e) => e.status === "executed");
      expect(executed).toBeDefined();
      expect(executed!.tool).toBe(TOOL);
      expect(executed!.callerId).toBe("tester");
      expect(executed!.previewCount).toBe(1);
    });
  });

  describe("ROLLBACK_UNSUPPORTED", () => {
    it("refunds are not in supportedKinds and are refused with ROLLBACK_UNSUPPORTED", async () => {
      const fx = makeFixture();
      const { planToken } = await previewAndExecute(fx, {
        orderId: "gid://shopify/Order/1",
        reason: "Return",
      });

      const err = await errorOf(fx.rollback.rollback(planToken));

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("refund_order");
    });

    it("refund_order plan has kind refund_order in executed map", async () => {
      const fx = makeFixture();
      const { planToken } = await previewAndExecute(fx, {
        orderId: "gid://shopify/Order/1",
        reason: "Return",
      });

      expect(fx.executed.get(planToken)?.kind).toBe(REFUND_ORDER_KIND);
    });
  });

  describe("auditDetail", () => {
    it("contains only order ID and amount, no PII", () => {
      const detail = auditDetail("gid://shopify/Order/123", "50.00", "USD");
      expect(detail).toContain("gid://shopify/Order/123");
      expect(detail).toContain("50.00");
      expect(detail).toContain("USD");
      expect(detail).not.toContain("customer");
      expect(detail).not.toContain("email");
      expect(detail).not.toContain("John");
    });
  });
});
