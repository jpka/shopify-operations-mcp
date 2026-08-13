import { PlanStore } from "safe-write-mcp-core";
import type { AuditSink, AuditEvent } from "safe-write-mcp-core";
import { describe, expect, it } from "vitest";
import type { AppConfig, ShopifyConfig } from "../../src/config.js";
import { AdminClient } from "../../src/graphql/adminClient.js";
import type { AdminClientOptions } from "../../src/graphql/adminClient.js";
import { PlanManager } from "../../src/plans/planManager.ts";
import { SnapshotStore } from "../../src/plans/snapshotStore.ts";
import { ExecutionError } from "../../src/plans/errors.ts";
import {
  PriceManifestBuilder,
  PriceStateReader,
  PriceExecutor,
  PROTECTED_RESOURCE_CODE,
  type PriceManifestItem,
  type PriceSnapshot,
  type PriceTransform,
} from "../../src/tools/updatePrices.ts";
import type { Manifest } from "../../src/plans/manifest.js";

type FetchLike = NonNullable<AdminClientOptions["fetch"]>;

function shopifyConfig(overrides: Partial<ShopifyConfig> = {}): ShopifyConfig {
  return {
    storeDomain: "test.myshopify.com",
    apiVersion: "2026-04",
    adminToken: "shpat_testtoken123",
    ...overrides,
  };
}

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    shopify: shopifyConfig(),
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

function rawVariant(
  id: number,
  price: number,
  opts: { tags?: string[]; vendor?: string; productId?: number } = {},
): RawVariantNode {
  const productId = opts.productId ?? 1;
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    title: `Variant ${id}`,
    price: price.toFixed(2),
    product: {
      id: `gid://shopify/Product/${productId}`,
      vendor: opts.vendor ?? null,
      tags: opts.tags ?? [],
    },
  };
}

class MemorySink implements AuditSink {
  events: AuditEvent[] = [];
  record(event: AuditEvent): undefined {
    this.events.push(event);
    return undefined;
  }
}

interface PriceFixture {
  client: AdminClient;
  config: AppConfig;
}

function buildPriceFixture(
  variants: RawVariantNode[],
  configOverrides?: Partial<AppConfig>,
): PriceFixture {
  const config = appConfig(configOverrides);
  const fetchImpl: FetchLike = async (_input, init) => {
    const raw = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    if (raw.query.includes("GetVariants")) {
      return jsonResponse({
        data: {
          nodes: variants,
        },
      });
    }
    if (raw.query.includes("SearchProductsForVariants")) {
      const productsMap = new Map<number, RawVariantNode[]>();
      for (const v of variants) {
        const pid = parseInt(v.product?.id.split("/").pop() ?? "0", 10);
        if (!productsMap.has(pid)) productsMap.set(pid, []);
        productsMap.get(pid)!.push(v);
      }
      return jsonResponse({
        data: {
          products: {
            edges: [...productsMap.entries()].map(([pid, vs]) => ({
              node: {
                id: `gid://shopify/Product/${pid}`,
                vendor: vs[0]?.product?.vendor ?? null,
                tags: vs[0]?.product?.tags ?? [],
                variants: {
                  edges: vs.map((v) => ({ node: v })),
                },
              },
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    if (raw.query.includes("ProductVariantsBulkUpdate")) {
      const variables = raw.variables as {
        productId: string;
        variants: Array<{ id: string; price: string }>;
      };
      return jsonResponse({
        data: {
          productVariantsBulkUpdate: {
            productVariants: variables.variants.map((v, i) => ({
              id: v.id,
              price: v.price,
            })),
            userErrors: [],
          },
        },
      });
    }
    return jsonResponse({ data: {} });
  };
  const client = new AdminClient(config.shopify, { fetch: fetchImpl });
  return { client, config };
}

interface ManagerFixture {
  manager: PlanManager<PriceManifestItem, PriceSnapshot, void>;
  planStore: PlanStore<Manifest<PriceManifestItem>>;
  snapshotStore: SnapshotStore<PriceSnapshot>;
  audit: MemorySink;
}

function makeManager(fixture: PriceFixture): ManagerFixture {
  const planStore = new PlanStore<Manifest<PriceManifestItem>>({ planTtlMs: 60_000 });
  const snapshotStore = new SnapshotStore<PriceSnapshot>(60_000);
  const audit = new MemorySink();
  const manager = new PlanManager<PriceManifestItem, PriceSnapshot, void>({
    store: planStore,
    executor: new PriceExecutor(fixture.client),
    stateReader: new PriceStateReader(fixture.client),
    snapshotStore,
    audit,
    callerId: "tester",
  });
  return { manager, planStore, snapshotStore, audit };
}

const TOOL = "update_prices";

async function errorOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe("PriceManifestBuilder (ticket #10)", () => {
  it("assembles a manifest with set-absolute transform", async () => {
    const variants = [
      rawVariant(1, 10.0),
      rawVariant(2, 20.0),
    ];
    const fixture = buildPriceFixture(variants);
    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"],
        transform: { type: "set-absolute", newPrice: 15.0 },
      },
      fixture.config,
    );

    const result = await builder.buildWithMaxPriceChangePct();
    const manifest = result.manifest;

    expect(manifest.items).toHaveLength(2);
    expect(manifest.items[0]!).toMatchObject({
      ref: "gid://shopify/ProductVariant/1",
      before: { variantId: "gid://shopify/ProductVariant/1", price: "10.00" },
      after: { variantId: "gid://shopify/ProductVariant/1", price: "15.00" },
      payload: { variantId: "gid://shopify/ProductVariant/1", price: "15.00" },
    });
    expect(manifest.items[1]!).toMatchObject({
      ref: "gid://shopify/ProductVariant/2",
      before: { variantId: "gid://shopify/ProductVariant/2", price: "20.00" },
      after: { variantId: "gid://shopify/ProductVariant/2", price: "15.00" },
    });
  });

  it("assembles a manifest with adjust-percentage transform", async () => {
    const variants = [rawVariant(1, 100.0)];
    const fixture = buildPriceFixture(variants);
    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: ["gid://shopify/ProductVariant/1"],
        transform: { type: "adjust-percentage", percentage: 10 },
      },
      fixture.config,
    );

    const result = await builder.buildWithMaxPriceChangePct();
    const manifest = result.manifest;

    expect(manifest.items[0]!).toMatchObject({
      ref: "gid://shopify/ProductVariant/1",
      before: { variantId: "gid://shopify/ProductVariant/1", price: "100.00" },
      after: { variantId: "gid://shopify/ProductVariant/1", price: "110.00" },
    });
    expect(result.maxPriceChangePct).toBe(10);
  });

  it("computes stable digests for drift detection", async () => {
    const variants = [rawVariant(1, 50.0)];
    const fixture = buildPriceFixture(variants);
    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: ["gid://shopify/ProductVariant/1"],
        transform: { type: "set-absolute", newPrice: 75.0 },
      },
      fixture.config,
    );

    const manifest = await builder.build();

    expect(typeof manifest.digest).toBe("string");
    expect(typeof manifest.beforeDigest).toBe("string");
    expect(manifest.digest.length).toBeGreaterThan(0);
    expect(manifest.beforeDigest.length).toBeGreaterThan(0);
  });

  it("throws when a variant is not found", async () => {
    const variants: RawVariantNode[] = [];
    const fixture = buildPriceFixture(variants);
    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: ["gid://shopify/ProductVariant/999"],
        transform: { type: "set-absolute", newPrice: 15.0 },
      },
      fixture.config,
    );

    await expect(builder.buildWithMaxPriceChangePct()).rejects.toThrow("not found");
  });

  it("uses vendor filter to select variants", async () => {
    const variants = [
      rawVariant(1, 10.0, { vendor: "Acme" }),
      rawVariant(2, 20.0, { vendor: "Other" }),
    ];
    const fixture = buildPriceFixture(variants, {
      // Override fetch to simulate Shopify's vendor filtering
      shopify: {
        storeDomain: "test.myshopify.com",
        apiVersion: "2026-04",
        adminToken: "shpat_testtoken123",
      },
    });
    const vendorFilterFetch: FetchLike = async (_input, init) => {
      const raw = JSON.parse(String(init?.body ?? "{}")) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      if (raw.query.includes("SearchProductsForVariants")) {
        const searchVars = raw.variables as { searchQuery?: string };
        const vendorMatch = searchVars.searchQuery?.includes("vendor:'Acme'") ?? false;
        const filtered = variants.filter((v) => v.product?.vendor === "Acme" || !vendorMatch);
        return jsonResponse({
          data: {
            products: {
              edges: [{
                node: {
                  id: "gid://shopify/Product/1",
                  vendor: "Acme",
                  tags: [],
                  variants: {
                    edges: filtered.map((v) => ({ node: v })),
                  },
                },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    };
    const client = new AdminClient(fixture.config.shopify, { fetch: vendorFilterFetch });
    const builder = new PriceManifestBuilder(
      client,
      {
        vendor: "Acme",
        transform: { type: "set-absolute", newPrice: 99.0 },
      },
      fixture.config,
    );

    const result = await builder.buildWithMaxPriceChangePct();

    expect(result.manifest.items).toHaveLength(1);
    expect(result.manifest.items[0]!.ref).toBe("gid://shopify/ProductVariant/1");
  });

  it("uses tag filter to select variants", async () => {
    const variants = [
      rawVariant(1, 10.0, { tags: ["sale"] }),
      rawVariant(2, 20.0, { tags: ["regular"] }),
    ];
    const fixture = buildPriceFixture(variants, {
      shopify: {
        storeDomain: "test.myshopify.com",
        apiVersion: "2026-04",
        adminToken: "shpat_testtoken123",
      },
    });
    const tagFilterFetch: FetchLike = async (_input, init) => {
      const raw = JSON.parse(String(init?.body ?? "{}")) as {
        query: string;
        variables?: Record<string, unknown>;
      };
      if (raw.query.includes("SearchProductsForVariants")) {
        const searchVars = raw.variables as { searchQuery?: string };
        const tagMatch = searchVars.searchQuery?.includes("tag:'sale'") ?? false;
        const filtered = variants.filter((v) => v.product?.tags.includes("sale") || !tagMatch);
        return jsonResponse({
          data: {
            products: {
              edges: [{
                node: {
                  id: "gid://shopify/Product/1",
                  vendor: null,
                  tags: ["sale"],
                  variants: {
                    edges: filtered.map((v) => ({ node: v })),
                  },
                },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    };
    const client = new AdminClient(fixture.config.shopify, { fetch: tagFilterFetch });
    const builder = new PriceManifestBuilder(
      client,
      {
        tag: "sale",
        transform: { type: "set-absolute", newPrice: 99.0 },
      },
      fixture.config,
    );

    const result = await builder.buildWithMaxPriceChangePct();

    expect(result.manifest.items).toHaveLength(1);
    expect(result.manifest.items[0]!.ref).toBe("gid://shopify/ProductVariant/1");
  });
});

describe("protected-tag refusal (ticket #10)", () => {
  it("refuses with PROTECTED_RESOURCE when a product carries a protected tag", async () => {
    const variants = [
      rawVariant(1, 10.0, { tags: ["do-not-touch", "sale"] }),
      rawVariant(2, 20.0),
    ];
    const fixture = buildPriceFixture(variants);
    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: [
          "gid://shopify/ProductVariant/1",
          "gid://shopify/ProductVariant/2",
        ],
        transform: { type: "set-absolute", newPrice: 99.0 },
      },
      fixture.config,
    );

    await expect(builder.buildWithMaxPriceChangePct()).rejects.toMatchObject({
      code: PROTECTED_RESOURCE_CODE,
    });
  });

  it("allows items without protected tags to proceed", async () => {
    const variants = [
      rawVariant(1, 10.0, { tags: ["sale", "clearance"] }),
      rawVariant(2, 20.0),
    ];
    const fixture = buildPriceFixture(variants);
    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: [
          "gid://shopify/ProductVariant/1",
          "gid://shopify/ProductVariant/2",
        ],
        transform: { type: "set-absolute", newPrice: 99.0 },
      },
      fixture.config,
    );

    const result = await builder.buildWithMaxPriceChangePct();
    expect(result.manifest.items).toHaveLength(2);
  });

  it("honors custom protectedTags from config", async () => {
    const variants = [rawVariant(1, 10.0, { tags: ["fragile"] })];
    const fixture = buildPriceFixture(variants, { protectedTags: ["fragile"] });
    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: ["gid://shopify/ProductVariant/1"],
        transform: { type: "set-absolute", newPrice: 99.0 },
      },
      fixture.config,
    );

    await expect(builder.buildWithMaxPriceChangePct()).rejects.toMatchObject({
      code: PROTECTED_RESOURCE_CODE,
    });
  });

  it("allows items when no protectedTags match", async () => {
    const variants = [rawVariant(1, 10.0, { tags: ["fragile", "sale"] })];
    const fixture = buildPriceFixture(variants, { protectedTags: ["do-not-touch"] });
    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: ["gid://shopify/ProductVariant/1"],
        transform: { type: "set-absolute", newPrice: 99.0 },
      },
      fixture.config,
    );

    const result = await builder.buildWithMaxPriceChangePct();
    expect(result.manifest.items).toHaveLength(1);
  });
});

describe("PriceExecutor (ticket #10)", () => {
  it("executes a single item successfully", async () => {
    const variants = [rawVariant(1, 10.0)];
    const fixture = buildPriceFixture(variants);
    const executor = new PriceExecutor(fixture.client);

    const outcome = await executor.execute({
      ref: "gid://shopify/ProductVariant/1",
      before: {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Variant 1",
        price: "10.00",
        tags: [],
        vendor: null,
      },
      after: {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Variant 1",
        price: "99.00",
        tags: [],
        vendor: null,
      },
      payload: {
        variantId: "gid://shopify/ProductVariant/1",
        price: "99.00",
      },
    });

    expect(outcome).toEqual({
      ref: "gid://shopify/ProductVariant/1",
      ok: true,
    });
  });
});

describe("PriceStateReader (ticket #10)", () => {
  it("reads current variant prices", async () => {
    const variants = [rawVariant(1, 42.0)];
    const fixture = buildPriceFixture(variants);
    const reader = new PriceStateReader(fixture.client);

    const current = await reader.readCurrent(["gid://shopify/ProductVariant/1"]);

    expect(current).toEqual({
      "gid://shopify/ProductVariant/1": {
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        title: "Variant 1",
        price: "42.00",
        tags: [],
        vendor: null,
      },
    });
  });

  it("returns empty record for empty refs array", async () => {
    const variants = [rawVariant(1, 42.0)];
    const fixture = buildPriceFixture(variants);
    const reader = new PriceStateReader(fixture.client);

    const current = await reader.readCurrent([]);

    expect(current).toEqual({});
  });
});

describe("update_prices two-phase safety matrix (ticket #10)", () => {
  it("threshold trip: plan with 25+ items requires approval", async () => {
    const variants = Array.from({ length: 30 }, (_, i) =>
      rawVariant(i + 1, (i + 1) * 10.0),
    );
    const fixture = buildPriceFixture(variants);
    const { manager } = makeManager(fixture);

    const transform: PriceTransform = { type: "set-absolute", newPrice: 5.0 };

    const preview = await manager.preview(
      new PriceManifestBuilder(
        fixture.client,
        {
          variantIds: variants.map((v) => v.id),
          transform,
        },
        fixture.config,
      ),
      { tool: TOOL, reason: "price reset" },
    );

    expect(preview.status).toBe("awaiting_approval");
    expect(preview.itemCount).toBe(30);
  });

  it("hard cap: plan with 250+ items is refused without a token", async () => {
    const variants = Array.from({ length: 300 }, (_, i) =>
      rawVariant(i + 1, (i + 1) * 10.0),
    );
    const fixture = buildPriceFixture(variants);
    const { manager, planStore, audit } = makeManager(fixture);

    const transform: PriceTransform = { type: "set-absolute", newPrice: 5.0 };

    const err = await errorOf(
      manager.preview(
        new PriceManifestBuilder(
          fixture.client,
          {
            variantIds: variants.map((v) => v.id),
            transform,
          },
          fixture.config,
        ),
        { tool: TOOL },
      ),
    );

    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe("HARD_MAX_ITEMS_EXCEEDED");
    expect(planStore.listPending()).toEqual([]);
    expect(audit.events.find((e) => e.status === "refused")).toBeDefined();
  });

  it("percentage escalation: any single change > maxPriceChangePct forces awaiting_approval", async () => {
    const variants = [rawVariant(1, 100.0)];
    const fixture = buildPriceFixture(variants);
    const { manager } = makeManager(fixture);

    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: ["gid://shopify/ProductVariant/1"],
        transform: { type: "set-absolute", newPrice: 200.0 },
      },
      fixture.config,
    );

    const { manifest, maxPriceChangePct } = await builder.buildWithMaxPriceChangePct();

    expect(maxPriceChangePct).toBe(100);
    expect(fixture.config.plans.maxPriceChangePct).toBe(30);

    const preview = await manager.preview(
      { build: () => Promise.resolve(manifest) },
      { tool: TOOL, alwaysRequireApproval: maxPriceChangePct > fixture.config.plans.maxPriceChangePct },
    );

    expect(preview.status).toBe("awaiting_approval");
    expect(preview.itemCount).toBe(1);
  });

  it("percentage within threshold does not force approval by itself", async () => {
    const variants = [rawVariant(1, 100.0)];
    const fixture = buildPriceFixture(variants);
    const { manager } = makeManager(fixture);

    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: ["gid://shopify/ProductVariant/1"],
        transform: { type: "set-absolute", newPrice: 110.0 },
      },
      fixture.config,
    );

    const { manifest, maxPriceChangePct } = await builder.buildWithMaxPriceChangePct();

    expect(maxPriceChangePct).toBe(10);
    expect(fixture.config.plans.maxPriceChangePct).toBe(30);

    const preview = await manager.preview(
      { build: () => Promise.resolve(manifest) },
      { tool: TOOL, alwaysRequireApproval: maxPriceChangePct > fixture.config.plans.maxPriceChangePct },
    );

    expect(preview.status).toBe("previewed");
    expect(preview.itemCount).toBe(1);
  });

  it("protected-tag refusal: plan touching a protected item throws before token issue", async () => {
    const variants = [
      rawVariant(1, 10.0, { tags: ["do-not-touch"] }),
      rawVariant(2, 20.0),
    ];
    const fixture = buildPriceFixture(variants);
    const { manager } = makeManager(fixture);

    const err = await errorOf(
      manager.preview(
        new PriceManifestBuilder(
          fixture.client,
          {
            variantIds: [
              "gid://shopify/ProductVariant/1",
              "gid://shopify/ProductVariant/2",
            ],
            transform: { type: "set-absolute", newPrice: 99.0 },
          },
          fixture.config,
        ),
        { tool: TOOL },
      ),
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code: string }).code).toBe(PROTECTED_RESOURCE_CODE);
  });

  it("full round-trip: preview -> execute with correct ledger", async () => {
    const variants = [
      rawVariant(1, 100.0),
      rawVariant(2, 200.0),
    ];
    const fixture = buildPriceFixture(variants);
    const { manager } = makeManager(fixture);

    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: [
          "gid://shopify/ProductVariant/1",
          "gid://shopify/ProductVariant/2",
        ],
        transform: { type: "adjust-percentage", percentage: 10 },
      },
      fixture.config,
    );

    const { manifest, maxPriceChangePct } = await builder.buildWithMaxPriceChangePct();

    expect(maxPriceChangePct).toBe(10);

    const preview = await manager.preview(
      { build: () => Promise.resolve(manifest) },
      {
        tool: TOOL,
        alwaysRequireApproval: maxPriceChangePct > fixture.config.plans.maxPriceChangePct,
      },
    );

    expect(preview.status).toBe("previewed");
    expect(preview.itemCount).toBe(2);

    const result = await manager.executePlan(preview.planToken, preview.manifest);

    expect(result.status).toBe("executed");
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.ledger.attempted.map((o) => o.ref)).toEqual([
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);
  });

  it("partial failure: one bad item does not block the others", async () => {
    const variants = [
      rawVariant(1, 10.0),
      rawVariant(2, 20.0),
    ];
    const failingClient = new AdminClient(appConfig().shopify, {
      fetch: async (_input, init) => {
        const raw = JSON.parse(String(init?.body ?? "{}")) as {
          query: string;
          variables?: Record<string, unknown>;
        };
        if (raw.query.includes("GetVariants")) {
          const ids = (raw.variables as { ids: string[] }).ids;
          const found = variants.filter((v) => ids.includes(v.id));
          return jsonResponse({ data: { nodes: found } });
        }
        if (raw.query.includes("ProductVariantsBulkUpdate")) {
          const variables = raw.variables as {
            variants?: Array<{ id: string }>;
          };
          const variantIds = variables.variants?.map((v) => v.id);
          if (variantIds?.includes("gid://shopify/ProductVariant/2")) {
            throw new Error("simulated network failure for variant 2");
          }
          return jsonResponse({
            data: {
              productVariantsBulkUpdate: {
                productVariants: variantIds?.map((id) => ({
                  id,
                  price: "99.00",
                })) ?? [],
                userErrors: [],
              },
            },
          });
        }
        return jsonResponse({ data: {} });
      },
    });
    const planStore = new PlanStore<Manifest<PriceManifestItem>>({ planTtlMs: 60_000 });
    const snapshotStore = new SnapshotStore<PriceSnapshot>(60_000);
    const audit = new MemorySink();
    const manager = new PlanManager<PriceManifestItem, PriceSnapshot, void>({
      store: planStore,
      executor: new PriceExecutor(failingClient),
      stateReader: new PriceStateReader(failingClient),
      snapshotStore,
      audit,
      callerId: "tester",
    });
    const fixture = buildPriceFixture(variants);

    const builder = new PriceManifestBuilder(
      fixture.client,
      {
        variantIds: [
          "gid://shopify/ProductVariant/1",
          "gid://shopify/ProductVariant/2",
        ],
        transform: { type: "set-absolute", newPrice: 99.0 },
      },
      fixture.config,
    );

    const { manifest } = await builder.buildWithMaxPriceChangePct();

    const preview = await manager.preview(
      { build: () => Promise.resolve(manifest) },
      { tool: TOOL },
    );

    const result = await manager.executePlan(preview.planToken, preview.manifest);

    expect(result.status).toBe("executed");
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.ledger.failed[0]!.ref).toBe("gid://shopify/ProductVariant/2");
    expect(result.ledger.failed[0]!.error!.code).toBe("SHOPIFY_API_ERROR");
  });
});
