import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { PlanStore } from "safe-write-mcp-core";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AppConfig } from "../src/config.ts";
import { AdminClient } from "../src/graphql/adminClient.ts";
import type { AdminClientOptions } from "../src/graphql/adminClient.ts";
import type { Manifest, ManifestItem } from "../src/plans/manifest.ts";
import { SnapshotStore } from "../src/plans/snapshotStore.ts";
import { createServer } from "../src/server.ts";
import type { ServerContext } from "../src/server.ts";
import { MemorySink } from "./integration/helpers.ts";

type FetchLike = NonNullable<AdminClientOptions["fetch"]>;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    shopify: {
      storeDomain: "test.myshopify.com",
      apiVersion: "2026-04",
      adminToken: "shpat_testtoken123",
    },
    plans: {
      planTtlMs: 60_000,
      approvalRequiredAboveItems: 25,
      hardMaxItems: 250,
      maxPriceChangePct: 30,
      rollbackTtlMs: 86_400_000,
    },
    approvalServer: { enabled: true, port: 4319 },
    protectedTags: ["do-not-touch"],
    callerId: "unknown",
    ...overrides,
  };
}

/** Raw variant node shape the update_prices tool reads from the Admin API. */
interface RawVariantNode {
  id: string;
  title: string;
  price: string;
  product: {
    id: string;
    vendor: string | null;
    tags: string[];
  } | null;
}

const VARIANTS: RawVariantNode[] = [
  {
    id: "gid://shopify/ProductVariant/1",
    title: "Acme Mug",
    price: "10.00",
    product: { id: "gid://shopify/Product/1", vendor: "Acme", tags: [] },
  },
  {
    id: "gid://shopify/ProductVariant/2",
    title: "Acme Teapot",
    price: "15.00",
    product: { id: "gid://shopify/Product/1", vendor: "Acme", tags: [] },
  },
  {
    id: "gid://shopify/ProductVariant/3",
    title: "VIP Item",
    price: "5.00",
    product: { id: "gid://shopify/Product/3", vendor: "Acme", tags: ["do-not-touch"] },
  },
];
const VARIANTS_BY_ID = new Map(VARIANTS.map((v) => [v.id, v]));

/** Orders served to both the list_orders and cancel_order flows. */
const ORDERS = [
  {
    id: "gid://shopify/Order/1",
    name: "#1001",
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    totalPrice: "99.99",
    refundedSettlements: [{ amount: "99.99" }],
    lineItems: [
      { id: "gid://shopify/LineItem/1", title: "Widget", quantity: 2 },
      { id: "gid://shopify/LineItem/2", title: "Gadget", quantity: 1 },
    ],
  },
];
const ORDERS_BY_ID = new Map(ORDERS.map((o) => [o.id, o]));

interface RawDiscountNode {
  id: string;
  code: string;
  discountType: string;
  value: string;
  usageLimit: number | null;
  status: string;
}
const DISCOUNTS_BY_CODE = new Map<string, RawDiscountNode>();

/**
 * Fake Admin API fetch dispatching on GraphQL operation-name substrings, the
 * same approach as tests/tools/*.test.ts. Every operation a test can trigger
 * is handled; anything else throws so a missed operation fails loudly.
 */
const shopifyFetch: FetchLike = async (_input, init) => {
  const raw = JSON.parse(String(init?.body ?? "{}")) as {
    query: string;
    variables?: Record<string, unknown>;
  };
  const q = raw.query;
  const variables = raw.variables ?? {};

  if (q.includes("CancelOrderPreview")) {
    const order = ORDERS_BY_ID.get(variables.id as string);
    if (!order) throw new Error("unexpected cancel preview order: " + String(variables.id));
    return jsonResponse({
      data: {
        orderCancelOrder: {
          order: {
            id: order.id,
            name: order.name,
            totalPrice: order.totalPrice,
            refundedSettlements: order.refundedSettlements,
            lineItems: { edges: order.lineItems.map((li) => ({ node: li })) },
          },
          userErrors: [],
        },
      },
    });
  }
  if (q.includes("OrderCancel")) {
    const order = ORDERS_BY_ID.get(variables.id as string);
    if (!order) throw new Error("unexpected cancel execute order: " + String(variables.id));
    return jsonResponse({
      data: {
        orderCancel: {
          order: {
            id: order.id,
            name: order.name,
            cancelCode: "customer",
          },
          userErrors: [],
        },
      },
    });
  }
  if (q.includes("OrdersPage")) {
    return jsonResponse({
      data: {
        orders: {
          edges: ORDERS.map((order) => ({
            node: {
              id: order.id,
              name: order.name,
              financialStatus: order.financialStatus,
              fulfillmentStatus: order.fulfillmentStatus,
              totalPrice: order.totalPrice,
              lineItems: { edges: order.lineItems.map((li) => ({ node: li })) },
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
  if (q.includes("SearchProductsForVariants")) {
    const byProduct = new Map<string, RawVariantNode[]>();
    for (const v of VARIANTS) {
      const pid = v.product?.id ?? "gid://shopify/Product/0";
      const bucket = byProduct.get(pid) ?? [];
      bucket.push(v);
      byProduct.set(pid, bucket);
    }
    return jsonResponse({
      data: {
        products: {
          edges: [...byProduct.entries()].map(([pid, vs]) => ({
            node: {
              id: pid,
              vendor: vs[0]?.product?.vendor ?? null,
              tags: vs[0]?.product?.tags ?? [],
              variants: { edges: vs.map((v) => ({ node: v })) },
            },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
  if (q.includes("SearchProducts")) {
    return jsonResponse({
      data: {
        products: {
          edges: [
            {
              node: {
                id: "gid://shopify/Product/1",
                title: "Acme Tea",
                vendor: "Acme",
                tags: [],
                variants: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/ProductVariant/1",
                        sku: "T-100",
                        price: "10.00",
                        inventoryItem: {
                          id: "gid://shopify/InventoryItem/1",
                          inventoryLevels: {
                            edges: [
                              {
                                node: {
                                  id: "gid://shopify/InventoryLevel/1_0",
                                  available: 4,
                                  location: {
                                    id: "gid://shopify/Location/1",
                                    name: "Main",
                                  },
                                },
                              },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }
  if (q.includes("GetVariants")) {
    const ids = (variables.ids as string[]) ?? [];
    const nodes = ids.map((id) => VARIANTS_BY_ID.get(id));
    if (nodes.some((n) => n === undefined)) {
      throw new Error("unexpected GetVariants ids: " + ids.join(", "));
    }
    return jsonResponse({ data: { nodes } });
  }
  if (q.includes("ProductVariantsBulkUpdate")) {
    const v = variables as {
      productId: string;
      variants: Array<{ id: string; price: string }>;
    };
    return jsonResponse({
      data: {
        productVariantsBulkUpdate: {
          productVariants: v.variants.map((x) => ({ id: x.id, price: x.price })),
          userErrors: [],
        },
      },
    });
  }
  if (q.includes("GetDiscount")) {
    const code = variables.code as string;
    return jsonResponse({ data: { discount: DISCOUNTS_BY_CODE.get(code) ?? null } });
  }
  if (q.includes("DiscountCodeBasicCreate")) {
    const input = variables.input as {
      code: string;
      discountType: string;
      value: string;
      usageLimit: number | null;
    };
    const created: RawDiscountNode = {
      id: `gid://shopify/Discount/${Date.now()}`,
      code: input.code,
      discountType: input.discountType,
      value: input.value,
      usageLimit: input.usageLimit,
      status: "active",
    };
    DISCOUNTS_BY_CODE.set(created.code, created);
    return jsonResponse({
      data: { discountCodeBasicCreate: { discount: created, userErrors: [] } },
    });
  }
  if (q.includes("DiscountCodeBasicDeactivate")) {
    const id = variables.id as string;
    const discount = [...DISCOUNTS_BY_CODE.values()].find((d) => d.id === id);
    if (!discount) {
      return jsonResponse({
        data: {
          discountCodeBasicDeactivate: {
            discount: null,
            userErrors: [{ field: ["id"], message: "Discount not found" }],
          },
        },
      });
    }
    const updated = { ...discount, status: "deactivated" };
    DISCOUNTS_BY_CODE.set(updated.code, updated);
    return jsonResponse({
      data: {
        discountCodeBasicDeactivate: {
          discount: { id: updated.id, code: updated.code, status: "deactivated" },
          userErrors: [],
        },
      },
    });
  }

  const opName = q.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "(anonymous)";
  throw new Error("unexpected GraphQL op: " + opName);
};

interface ParsedManifestItem {
  ref: string;
  before: unknown;
  after: unknown;
  payload?: unknown;
}
interface ParsedManifest {
  items: ParsedManifestItem[];
  digest: string;
  beforeDigest: string;
}
interface StructuredError {
  code: string;
  message: string;
  hint: string | null;
}

function textOf(result: { content: readonly unknown[] }): string {
  const first = result.content[0] as { type: string; text: string } | undefined;
  return first?.text ?? "";
}

describe("MCP server tools", () => {
  let client: AdminClient;
  let config: AppConfig;
  let ctx: ServerContext;
  let mcpClient: Client;
  let memorySink: MemorySink;
  let planStore: PlanStore<Manifest<ManifestItem>>;
  let server: Server | undefined;

  beforeAll(async () => {
    config = appConfig();
    client = new AdminClient(config.shopify, { fetch: shopifyFetch });
    memorySink = new MemorySink();
    planStore = new PlanStore<Manifest<ManifestItem>>({
      planTtlMs: 60_000,
      audit: memorySink,
    });
    ctx = {
      client,
      config,
      audit: memorySink,
      planStore,
      snapshotStore: new SnapshotStore<unknown>(86_400_000),
    };

    server = createServer(ctx);
    mcpClient = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await server?.close().catch(() => {});
    await mcpClient?.close().catch(() => {});
  });

  it("list_tools exposes all 9 tools and NOT approve_plan", async () => {
    const tools = await mcpClient.listTools();
    const names = tools.tools.map((t) => t.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "search_products",
        "list_orders",
        "update_prices",
        "update_inventory",
        "create_discount",
        "refund_order",
        "cancel_order",
        "execute_plan",
        "rollback_plan",
      ]),
    );
    expect(names).toHaveLength(9);

    // Regression test mirroring sw-postgres-mcp: approval must never be
    // reachable through the agent-facing MCP tool surface — the agent that
    // requests a gated write must never be able to approve it itself.
    expect(names).not.toContain("approve_plan");
  });

  it("approve_plan call_tool returns UNKNOWN_TOOL", async () => {
    const result = await mcpClient.callTool({
      name: "approve_plan",
      arguments: { plan_token: "does-not-matter" },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result)) as StructuredError;
    expect(parsed.code).toBe("UNKNOWN_TOOL");
    expect(parsed.message).toMatch(/approve_plan/);
  });

  it("search_products returns products via call_tool", async () => {
    const result = await mcpClient.callTool({
      name: "search_products",
      arguments: { vendor: "Acme" },
    });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      products: Array<{
        id: string;
        title: string;
        vendor: string | null;
        flags: { protected: boolean; protectedTags: string[] };
      }>;
      count: number;
      first: number;
    };
    expect(parsed.count).toBe(1);
    expect(parsed.first).toBe(50);
    expect(parsed.products[0]!.title).toBe("Acme Tea");
    expect(parsed.products[0]!.vendor).toBe("Acme");
    expect(parsed.products[0]!.flags).toEqual({ protected: false, protectedTags: [] });
  });

  it("list_orders returns orders via call_tool", async () => {
    const result = await mcpClient.callTool({ name: "list_orders", arguments: {} });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(textOf(result)) as {
      orders: Array<{
        id: string;
        name: string;
        financialStatus: string | null;
        fulfillmentStatus: string | null;
        totalPrice: string;
        lineItems: Array<{ id: string; title: string; quantity: number }>;
      }>;
    };
    expect(parsed.orders).toHaveLength(1);
    expect(parsed.orders[0]!.name).toBe("#1001");
    expect(parsed.orders[0]!.financialStatus).toBe("paid");
    expect(parsed.orders[0]!.lineItems).toHaveLength(2);
  });

  it("update_prices preview then execute_plan then rollback_plan", async () => {
    const previewResult = await mcpClient.callTool({
      name: "update_prices",
      arguments: {
        variantIds: [
          "gid://shopify/ProductVariant/1",
          "gid://shopify/ProductVariant/2",
        ],
        transform: { type: "set-absolute", newPrice: 12.5 },
        reason: "server test price reset",
      },
    });
    expect(previewResult.isError).not.toBe(true);
    const preview = JSON.parse(textOf(previewResult)) as {
      status: string;
      plan_token: string;
      item_count: number;
      expires_at: number;
      manifest: ParsedManifest;
    };
    expect(preview.status).toBe("previewed");
    expect(preview.item_count).toBe(2);
    expect(preview.expires_at).toBeGreaterThan(0);
    expect(preview.manifest.items).toHaveLength(2);
    expect(preview.manifest.items[0]!.after).toMatchObject({ price: "12.50" });

    const executeResult = await mcpClient.callTool({
      name: "execute_plan",
      arguments: { plan_token: preview.plan_token, manifest: preview.manifest },
    });
    expect(executeResult.isError).not.toBe(true);
    const executed = JSON.parse(textOf(executeResult)) as {
      status: string;
      item_count: number;
      succeeded_count: number;
      failed_count: number;
      refs: string[];
    };
    expect(executed.status).toBe("executed");
    expect(executed.item_count).toBe(2);
    expect(executed.succeeded_count).toBe(2);
    expect(executed.failed_count).toBe(0);
    expect(executed.refs).toEqual([
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);

    const rollbackResult = await mcpClient.callTool({
      name: "rollback_plan",
      arguments: { planToken: preview.plan_token },
    });
    expect(rollbackResult.isError).not.toBe(true);
    const rolledBack = JSON.parse(textOf(rollbackResult)) as {
      status: string;
      item_count: number;
      succeeded_count: number;
      failed_count: number;
      refs: string[];
    };
    expect(rolledBack.status).toBe("rolled_back");
    expect(rolledBack.succeeded_count).toBe(2);
    expect(rolledBack.failed_count).toBe(0);
    expect(rolledBack.refs).toHaveLength(2);

    const executedAudit = memorySink.events.find(
      (e) => e.planToken === preview.plan_token && e.status === "executed",
    );
    expect(executedAudit).toBeDefined();
    expect(executedAudit!.tool).toBe("update_prices");
  });

  it("cancel_order always requires approval, approves via out-of-band, then executes", async () => {
    const previewResult = await mcpClient.callTool({
      name: "cancel_order",
      arguments: {
        orderId: "gid://shopify/Order/1",
        reason: "customer",
        restock: true,
        notifyCustomer: true,
      },
    });
    expect(previewResult.isError).not.toBe(true);
    const preview = JSON.parse(textOf(previewResult)) as {
      status: string;
      plan_token: string;
      order_id: string;
      manifest: ParsedManifest;
    };
    expect(preview.status).toBe("awaiting_approval");
    expect(preview.order_id).toBe("gid://shopify/Order/1");
    expect(preview.manifest.items).toHaveLength(1);
    expect((preview.manifest.items[0]!.before as { flags: string[] }).flags).toContain(
      "will_restock",
    );

    // Two awaiting_approval rows are expected for one cancel token: the core
    // PlanStore.create transition and the tool's own domain preview row.
    const awaitingAudit = memorySink.events.filter(
      (e) => e.planToken === preview.plan_token && e.status === "awaiting_approval",
    );
    expect(awaitingAudit.length).toBeGreaterThanOrEqual(1);
    expect(awaitingAudit[0]!.tool).toBe("cancel_order");

    const beforeApproval = await mcpClient.callTool({
      name: "execute_plan",
      arguments: { plan_token: preview.plan_token, manifest: preview.manifest },
    });
    expect(beforeApproval.isError).toBe(true);
    const beforeError = JSON.parse(textOf(beforeApproval)) as StructuredError;
    expect(beforeError.code).toBe("AWAITING_APPROVAL");
    expect(beforeError.message).toMatch(/approval/i);

    const approved = ctx.planStore.approve(preview.plan_token);
    expect(approved.ok).toBe(true);

    const afterApproval = await mcpClient.callTool({
      name: "execute_plan",
      arguments: { plan_token: preview.plan_token, manifest: preview.manifest },
    });
    expect(afterApproval.isError).not.toBe(true);
    const executed = JSON.parse(textOf(afterApproval)) as {
      status: string;
      order_id: string;
      order_name: string;
      succeeded_count: number;
      failed_count: number;
    };
    expect(executed.status).toBe("executed");
    expect(executed.order_name).toBe("#1001");
    expect(executed.succeeded_count).toBe(1);
    expect(executed.failed_count).toBe(0);
  });

  it("INVALID_ARGUMENTS structured error on a missing required argument", async () => {
    const result = await mcpClient.callTool({
      name: "update_prices",
      arguments: { variantIds: ["gid://shopify/ProductVariant/1"] },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result)) as StructuredError;
    expect(parsed.code).toBe("INVALID_ARGUMENTS");
    expect(parsed.message).toMatch(/transform/);
    expect(parsed.hint).toBeTruthy();
  });

  it("PLAN_MISMATCH on a tampered manifest proves the manifest-echo fingerprint contract", async () => {
    const previewResult = await mcpClient.callTool({
      name: "update_prices",
      arguments: {
        variantIds: ["gid://shopify/ProductVariant/2"],
        transform: { type: "set-absolute", newPrice: 12.5 },
      },
    });
    expect(previewResult.isError).not.toBe(true);
    const preview = JSON.parse(textOf(previewResult)) as {
      plan_token: string;
      manifest: ParsedManifest;
    };

    const tampered = JSON.parse(JSON.stringify(preview.manifest)) as ParsedManifest;
    const tamperedPayload = tampered.items[0]!.payload as { price: string };
    tamperedPayload.price = "99.99";

    const result = await mcpClient.callTool({
      name: "execute_plan",
      arguments: { plan_token: preview.plan_token, manifest: tampered },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result)) as StructuredError;
    expect(parsed.code).toBe("PLAN_MISMATCH");
    expect(parsed.message).toMatch(/does not match/i);
  });

  it("PROTECTED_RESOURCE for a do-not-touch product variant", async () => {
    const result = await mcpClient.callTool({
      name: "update_prices",
      arguments: {
        variantIds: ["gid://shopify/ProductVariant/3"],
        transform: { type: "set-absolute", newPrice: 12.5 },
      },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result)) as StructuredError;
    expect(parsed.code).toBe("PROTECTED_RESOURCE");
    expect(parsed.message).toMatch(/do-not-touch/);
  });
});