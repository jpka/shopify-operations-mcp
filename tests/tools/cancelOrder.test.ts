import { PlanStore } from "safe-write-mcp-core";
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../../src/plans/manifest.ts";
import { SnapshotStore } from "../../src/plans/snapshotStore.ts";
import { AdminClient } from "../../src/graphql/adminClient.ts";
import {
  cancelOrder,
  executeCancelOrder,
  TOOL_CANCEL_ORDER,
} from "../../src/tools/cancelOrder.ts";
import type { CancelOrderManifestItem } from "../../src/tools/cancelOrder.ts";
import { RollbackPlan } from "../../src/tools/rollbackPlan.ts";
import { RollbackError } from "../../src/tools/rollbackPlan.ts";
import type { ExecutedPlan } from "../../src/tools/rollbackPlan.ts";
import type { ShopifyConfig } from "../../src/config.ts";

class MemorySink implements AuditSink {
  events: AuditEvent[] = [];

  record(event: AuditEvent): undefined {
    this.events.push(event);
    return undefined;
  }
}

interface FakeOrder {
  id: string;
  name: string;
  totalPrice: string;
  financialStatus: string;
  refundedSettlements: { amount: string }[];
  lineItems: { id: string; title: string; quantity: number }[];
  cancelled: boolean;
}

interface TestFixture {
  orders: Map<string, FakeOrder>;
  planStore: PlanStore<Manifest<CancelOrderManifestItem>>;
  snapshotStore: SnapshotStore<CancelOrderManifestItem["before"]>;
  audit: MemorySink;
  rollback: RollbackPlan<CancelOrderManifestItem["before"], void>;
  executed: Map<string, ExecutedPlan>;
  client: AdminClient;
}

function makeFixture(): TestFixture {
  const orders = new Map<string, FakeOrder>([
    [
      "gid://shopify/Order/1",
      {
        id: "gid://shopify/Order/1",
        name: "#1001",
        totalPrice: "99.99",
        financialStatus: "paid",
        refundedSettlements: [{ amount: "99.99" }],
        lineItems: [
          { id: "li1", title: "Widget", quantity: 2 },
          { id: "li2", title: "Gadget", quantity: 1 },
        ],
        cancelled: false,
      },
    ],
    [
      "gid://shopify/Order/2",
      {
        id: "gid://shopify/Order/2",
        name: "#1002",
        totalPrice: "49.50",
        financialStatus: "paid",
        refundedSettlements: [{ amount: "49.50" }],
        lineItems: [{ id: "li3", title: "Thing", quantity: 3 }],
        cancelled: false,
      },
    ],
  ]);

  const planStore = new PlanStore<Manifest<CancelOrderManifestItem>>({ planTtlMs: 60_000 });
  const snapshotStore = new SnapshotStore<CancelOrderManifestItem["before"]>(60_000);
  const audit = new MemorySink();

  const executed = new Map<string, ExecutedPlan>();

  const rollback = new RollbackPlan<CancelOrderManifestItem["before"], void>({
    snapshotStore,
    executedOf: (t) => executed.get(t) ?? null,
    supportedKinds: ["update_prices"],
    executor: {
      execute() {
        throw new Error("should not be called");
      },
    },
    audit,
    callerId: "tester",
  });

  const client = buildFakeAdminClient(orders);

  return { orders, planStore, snapshotStore, audit, rollback, executed, client };
}

function buildFakeFetch(orders: Map<string, FakeOrder>) {
  return async (_input: RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables?: {
        id?: string;
        reason?: string;
        restockLineItems?: boolean;
        notifyCustomer?: boolean;
      };
    };

    if (body.query.includes("CancelOrderPreview") || body.query.includes("orderCancelOrder")) {
      const order = orders.get(body.variables?.id ?? "");
      if (!order) {
        return new Response(
          JSON.stringify({
            data: {
              orderCancelOrder: {
                order: null,
                userErrors: [{ field: "id", message: "Order not found" }],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            orderCancelOrder: {
              order: {
                id: order.id,
                name: order.name,
                totalPrice: order.totalPrice,
                refundedSettlements: order.refundedSettlements,
                lineItems: {
                  edges: order.lineItems.map((li) => ({ node: li })),
                },
              },
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (body.query.includes("orderCancel")) {
      const order = orders.get(body.variables?.id ?? "");
      if (!order) {
        return new Response(
          JSON.stringify({
            data: {
              orderCancel: {
                order: null,
                userErrors: [{ field: "id", message: "Order not found" }],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      order.cancelled = true;
      return new Response(
        JSON.stringify({
          data: {
            orderCancel: {
              order: {
                id: order.id,
                name: order.name,
                cancelCode: body.variables?.reason ?? "customer",
              },
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ data: null, errors: [{ message: "Unknown query" }] }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  };
}

function buildFakeAdminClient(orders: Map<string, FakeOrder>): AdminClient {
  const config: ShopifyConfig = {
    storeDomain: "test.myshopify.com",
    apiVersion: "2026-04",
    adminToken: "test",
  };
  return new AdminClient(config, { fetch: buildFakeFetch(orders) });
}

function buildFailingAdminClient(errorMessage: string): AdminClient {
  const config: ShopifyConfig = {
    storeDomain: "test.myshopify.com",
    apiVersion: "2026-04",
    adminToken: "test",
  };
  const fetchImpl = async (_input: RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
    if (body.query.includes("CancelOrderPreview") || body.query.includes("orderCancelOrder")) {
      return new Response(
        JSON.stringify({
          data: {
            orderCancelOrder: {
              order: {
                id: "gid://shopify/Order/999",
                name: "#1999",
                totalPrice: "0.00",
                refundedSettlements: [],
                lineItems: { edges: [] },
              },
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        data: {
          orderCancel: {
            order: null,
            userErrors: [{ field: "order", message: errorMessage }],
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return new AdminClient(config, { fetch: fetchImpl });
}

async function errorOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe("cancel_order always-approval irreversible tool (ticket #13)", () => {
  it("preview always returns awaiting_approval status regardless of item count", async () => {
    const fx = makeFixture();

    const result = await cancelOrder(
      fx.client,
      fx.planStore,
      fx.audit,
      {
        orderId: "gid://shopify/Order/1",
        reason: "customer",
        restock: true,
        notifyCustomer: true,
      },
      "tester",
    );

    expect(result.status).toBe("awaiting_approval");
    expect(result.planToken).toBeDefined();
    expect(result.preview.items).toHaveLength(1);
    expect(result.preview.items[0]!.before.orderName).toBe("#1001");
    expect(result.preview.items[0]!.before.flags).toContain("will_restock");
    expect(result.preview.items[0]!.before.flags).toContain("will_notify_customer");
    expect(result.preview.items[0]!.before.refundedAmount).toBe("99.99");
  });

  it("preview performs zero writes and does not capture a snapshot", async () => {
    const fx = makeFixture();

    const result = await cancelOrder(
      fx.client,
      fx.planStore,
      fx.audit,
      {
        orderId: "gid://shopify/Order/1",
        reason: "customer",
        restock: false,
        notifyCustomer: false,
      },
      "tester",
    );

    expect(result.status).toBe("awaiting_approval");
    expect(fx.snapshotStore.has(result.planToken)).toBe(false);
    expect(fx.orders.get("gid://shopify/Order/1")!.cancelled).toBe(false);
  });

  it("execute without prior approval is refused with AWAITING_APPROVAL", async () => {
    const fx = makeFixture();

    const { preview, planToken } = await cancelOrder(
      fx.client,
      fx.planStore,
      fx.audit,
      {
        orderId: "gid://shopify/Order/1",
        reason: "customer",
        restock: false,
        notifyCustomer: false,
      },
      "tester",
    );

    const err = await errorOf(
      executeCancelOrder(
        fx.client,
        fx.planStore,
        fx.audit,
        planToken,
        preview,
        {
          orderId: "gid://shopify/Order/1",
          reason: "customer",
          restock: false,
          notifyCustomer: false,
        },
        "tester",
      ),
    );

    expect(err).toBeDefined();
    expect((err as { code: string }).code).toBe("AWAITING_APPROVAL");
    expect(fx.orders.get("gid://shopify/Order/1")!.cancelled).toBe(false);
  });

  it("execute succeeds after approval is granted", async () => {
    const fx = makeFixture();

    const { preview, planToken } = await cancelOrder(
      fx.client,
      fx.planStore,
      fx.audit,
      {
        orderId: "gid://shopify/Order/1",
        reason: "customer",
        restock: true,
        notifyCustomer: true,
      },
      "tester",
    );

    const approved = fx.planStore.approve(planToken);
    expect(approved.ok).toBe(true);

    const result = await executeCancelOrder(
      fx.client,
      fx.planStore,
      fx.audit,
      planToken,
      preview,
      {
        orderId: "gid://shopify/Order/1",
        reason: "customer",
        restock: true,
        notifyCustomer: true,
      },
      "tester",
    );

    expect(result.status).toBe("executed");
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.orderId).toBe("gid://shopify/Order/1");
    expect(fx.orders.get("gid://shopify/Order/1")!.cancelled).toBe(true);
  });

  it("audit row records awaiting_approval then executed with correct tool name", async () => {
    const fx = makeFixture();

    const { preview, planToken } = await cancelOrder(
      fx.client,
      fx.planStore,
      fx.audit,
      {
        orderId: "gid://shopify/Order/2",
        reason: "inventory",
        restock: true,
        notifyCustomer: false,
      },
      "tester",
    );

    const approved = fx.planStore.approve(planToken);
    expect(approved.ok).toBe(true);

    await executeCancelOrder(
      fx.client,
      fx.planStore,
      fx.audit,
      planToken,
      preview,
      {
        orderId: "gid://shopify/Order/2",
        reason: "inventory",
        restock: true,
        notifyCustomer: false,
      },
      "tester",
    );

    const awaitingEvents = fx.audit.events.filter((e) => e.status === "awaiting_approval");
    expect(awaitingEvents).toHaveLength(1);
    expect(awaitingEvents[0]!.tool).toBe(TOOL_CANCEL_ORDER);
    expect(awaitingEvents[0]!.callerId).toBe("tester");
    expect(awaitingEvents[0]!.planToken).toBe(planToken);
    expect(awaitingEvents[0]!.detail).toContain("#1002");

    const executedEvents = fx.audit.events.filter((e) => e.status === "executed");
    expect(executedEvents).toHaveLength(1);
    expect(executedEvents[0]!.tool).toBe(TOOL_CANCEL_ORDER);
    expect(executedEvents[0]!.planToken).toBe(planToken);
  });

  it("preview shows refund implication in flags", async () => {
    const fx = makeFixture();

    const { preview } = await cancelOrder(
      fx.client,
      fx.planStore,
      fx.audit,
      {
        orderId: "gid://shopify/Order/1",
        reason: "customer",
        restock: true,
        notifyCustomer: false,
      },
      "tester",
    );

    const item = preview.items[0]!;
    expect(item.before.flags).toContain("will_restock");
    expect(item.before.flags).toContain("refund:99.99");
    expect(item.before.restockedLineItems).toContain("Widget");
    expect(item.before.restockedLineItems).toContain("Gadget");
  });

  it("a second execute after successful execute is refused with PLAN_USED", async () => {
    const fx = makeFixture();

    const { preview, planToken } = await cancelOrder(
      fx.client,
      fx.planStore,
      fx.audit,
      {
        orderId: "gid://shopify/Order/1",
        reason: "customer",
        restock: false,
        notifyCustomer: false,
      },
      "tester",
    );

    const approved = fx.planStore.approve(planToken);
    expect(approved.ok).toBe(true);

    await executeCancelOrder(
      fx.client,
      fx.planStore,
      fx.audit,
      planToken,
      preview,
      {
        orderId: "gid://shopify/Order/1",
        reason: "customer",
        restock: false,
        notifyCustomer: false,
      },
      "tester",
    );

    const secondErr = await errorOf(
      executeCancelOrder(
        fx.client,
        fx.planStore,
        fx.audit,
        planToken,
        preview,
        {
          orderId: "gid://shopify/Order/1",
          reason: "customer",
          restock: false,
          notifyCustomer: false,
        },
        "tester",
      ),
    );

    expect(secondErr).toBeDefined();
    expect((secondErr as { code: string }).code).toBe("PLAN_USED");
  });

  it("execute returns failure ledger when Shopify returns userErrors", async () => {
    const fx = makeFixture();
    const failingClient = buildFailingAdminClient("Order cannot be cancelled");
    const planStore = new PlanStore<Manifest<CancelOrderManifestItem>>({ planTtlMs: 60_000 });
    const audit = new MemorySink();

    const { preview, planToken } = await cancelOrder(
      failingClient,
      planStore,
      audit,
      {
        orderId: "gid://shopify/Order/999",
        reason: "customer",
        restock: false,
        notifyCustomer: false,
      },
      "tester",
    );

    const approved = planStore.approve(planToken);
    expect(approved.ok).toBe(true);

    const result = await executeCancelOrder(
      failingClient,
      planStore,
      audit,
      planToken,
      preview,
      {
        orderId: "gid://shopify/Order/999",
        reason: "customer",
        restock: false,
        notifyCustomer: false,
      },
      "tester",
    );

    expect(result.status).toBe("executed");
    expect(result.failedCount).toBe(1);
    expect(result.succeededCount).toBe(0);
    expect(result.orderId).toBe("gid://shopify/Order/999");
    const failedItem = result.orderId; // just verify result structure
    expect(failedItem).toBe("gid://shopify/Order/999");
  });
});
