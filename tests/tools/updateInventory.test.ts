import { PlanStore } from "safe-write-mcp-core";
import type { AuditSink, AuditEvent } from "safe-write-mcp-core";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig, ShopifyConfig } from "../../src/config.js";
import { AdminClient } from "../../src/graphql/adminClient.js";
import type { AdminClientOptions } from "../../src/graphql/adminClient.js";
import { PlanManager } from "../../src/plans/planManager.ts";
import { SnapshotStore } from "../../src/plans/snapshotStore.ts";
import { ExecutionError } from "../../src/plans/errors.ts";
import {
  InventoryManifestBuilder,
  InventoryStateReader,
  InventoryExecutor,
  PROTECTED_RESOURCE_CODE,
} from "../../src/tools/updateInventory.ts";
import type { Manifest } from "../../src/plans/manifest.js";
import type { InventoryManifestItem } from "../../src/tools/updateInventory.js";

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

interface RawInventoryLevelNode {
  id: string;
  available: number;
  location: { id: string };
}

interface RawInventoryItemNode {
  id: string;
  product: { id: string; tags: string[] } | null;
  variant: { id: string; title: string } | null;
  inventoryLevels: { edges: Array<{ node: RawInventoryLevelNode }> };
}

function rawInventoryItem(
  id: number,
  available: number,
  opts: { tags?: string[]; locationId?: string } = {},
): RawInventoryItemNode {
  const locationId = opts.locationId ?? "gid://shopify/Location/1";
  return {
    id: `gid://shopify/InventoryItem/${id}`,
    product: {
      id: `gid://shopify/Product/${id}`,
      tags: opts.tags ?? [],
    },
    variant: {
      id: `gid://shopify/ProductVariant/${id}`,
      title: "Default",
    },
    inventoryLevels: {
      edges: [
        {
          node: {
            id: `gid://shopify/InventoryLevel/${id}`,
            available,
            location: { id: locationId },
          },
        },
      ],
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

interface InventoryFixture {
  client: AdminClient;
  fetchImpl: FetchLike;
  config: AppConfig;
  locationId: string;
}

function buildInventoryFixture(
  items: RawInventoryItemNode[],
  configOverrides?: Partial<AppConfig>,
): InventoryFixture {
  const config = appConfig(configOverrides);
  const locationId = "gid://shopify/Location/1";
  const fetchImpl: FetchLike = async (_input, init) => {
    const raw = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    if (raw.query.includes("GetInventoryItems")) {
      return jsonResponse({
        data: {
          nodes: items,
        },
      });
    }
    if (raw.query.includes("InventorySetQuantities")) {
      const input = (raw.variables as { input: { quantities: Array<{ inventoryItemId: string; quantity: number }> } }).input;
      return jsonResponse({
        data: {
          inventorySetQuantities: {
            inventoryLevels: input.quantities.map((q, i) => ({
              id: `gid://shopify/InventoryLevel/${i}`,
              available: q.quantity,
              location: { id: locationId },
            })),
            userErrors: [],
          },
        },
      });
    }
    return jsonResponse({ data: {} });
  };
  const client = new AdminClient(config.shopify, { fetch: fetchImpl });
  return { client, fetchImpl, config, locationId };
}

interface ManagerFixture {
  manager: PlanManager<InventoryManifestItem, import("../../src/tools/updateInventory.js").InventoryLevelSnapshot, void>;
  planStore: PlanStore<Manifest<InventoryManifestItem>>;
  snapshotStore: SnapshotStore<import("../../src/tools/updateInventory.js").InventoryLevelSnapshot>;
  audit: MemorySink;
}

function makeManager(fixture: InventoryFixture): ManagerFixture {
  const planStore = new PlanStore<Manifest<InventoryManifestItem>>({ planTtlMs: 60_000 });
  const snapshotStore = new SnapshotStore<import("../../src/tools/updateInventory.js").InventoryLevelSnapshot>(60_000);
  const audit = new MemorySink();
  const manager = new PlanManager<InventoryManifestItem, import("../../src/tools/updateInventory.js").InventoryLevelSnapshot, void>({
    store: planStore,
    executor: new InventoryExecutor(fixture.client, fixture.locationId),
    stateReader: new InventoryStateReader(fixture.client, fixture.locationId),
    snapshotStore,
    audit,
    callerId: "tester",
  });
  return { manager, planStore, snapshotStore, audit };
}

const TOOL = "update_inventory";

async function errorOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe("InventoryManifestBuilder (ticket #11)", () => {
  it("assembles a manifest with before/after snapshots for each adjustment", async () => {
    const items = [
      rawInventoryItem(1, 10),
      rawInventoryItem(2, 20),
    ];
    const fixture = buildInventoryFixture(items);
    const builder = new InventoryManifestBuilder(
      fixture.client,
      { locationId: fixture.locationId, adjustments: [
        { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 15 },
        { inventoryItemId: "gid://shopify/InventoryItem/2", quantity: 25 },
      ]},
      fixture.config,
    );

    const manifest = await builder.build();

    expect(manifest.items).toHaveLength(2);
    expect(manifest.items[0]!).toMatchObject({
      ref: "gid://shopify/InventoryItem/1",
      before: { inventoryItemId: "gid://shopify/InventoryItem/1", available: 10 },
      after: { inventoryItemId: "gid://shopify/InventoryItem/1", available: 15 },
      payload: { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 15 },
    });
    expect(manifest.items[1]!).toMatchObject({
      ref: "gid://shopify/InventoryItem/2",
      before: { inventoryItemId: "gid://shopify/InventoryItem/2", available: 20 },
      after: { inventoryItemId: "gid://shopify/InventoryItem/2", available: 25 },
    });
  });

  it("computes stable digests for drift detection", async () => {
    const items = [rawInventoryItem(1, 10)];
    const fixture = buildInventoryFixture(items);
    const builder = new InventoryManifestBuilder(
      fixture.client,
      { locationId: fixture.locationId, adjustments: [
        { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 99 },
      ]},
      fixture.config,
    );

    const manifest = await builder.build();

    expect(typeof manifest.digest).toBe("string");
    expect(typeof manifest.beforeDigest).toBe("string");
    expect(manifest.digest.length).toBeGreaterThan(0);
    expect(manifest.beforeDigest.length).toBeGreaterThan(0);
  });

  it("throws when an inventory item is not found", async () => {
    const items: RawInventoryItemNode[] = [];
    const fixture = buildInventoryFixture(items);
    const builder = new InventoryManifestBuilder(
      fixture.client,
      { locationId: fixture.locationId, adjustments: [
        { inventoryItemId: "gid://shopify/InventoryItem/999", quantity: 10 },
      ]},
      fixture.config,
    );

    await expect(builder.build()).rejects.toThrow("not found");
  });

  it("throws when an inventory item has no level at the specified location", async () => {
    const items = [rawInventoryItem(1, 10, { locationId: "gid://shopify/Location/other" })];
    const fixture = buildInventoryFixture(items);
    const builder = new InventoryManifestBuilder(
      fixture.client,
      { locationId: fixture.locationId, adjustments: [
        { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 99 },
      ]},
      fixture.config,
    );

    await expect(builder.build()).rejects.toThrow("no level at location");
  });
});

describe("protected-tag refusal (ticket #11)", () => {
  it("refuses with PROTECTED_RESOURCE when a product carries a protected tag", async () => {
    const items = [rawInventoryItem(1, 10, { tags: ["do-not-touch", "sale"] })];
    const fixture = buildInventoryFixture(items);
    const builder = new InventoryManifestBuilder(
      fixture.client,
      { locationId: fixture.locationId, adjustments: [
        { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 99 },
      ]},
      fixture.config,
    );

    await expect(builder.build()).rejects.toMatchObject({
      code: PROTECTED_RESOURCE_CODE,
    });
  });

  it("allows items without protected tags to proceed", async () => {
    const items = [rawInventoryItem(1, 10, { tags: ["sale", "clearance"] })];
    const fixture = buildInventoryFixture(items);
    const builder = new InventoryManifestBuilder(
      fixture.client,
      { locationId: fixture.locationId, adjustments: [
        { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 99 },
      ]},
      fixture.config,
    );

    const manifest = await builder.build();
    expect(manifest.items).toHaveLength(1);
  });

  it("honors custom protectedTags from config", async () => {
    const items = [rawInventoryItem(1, 10, { tags: ["fragile"] })];
    const fixture = buildInventoryFixture(items, { protectedTags: ["fragile"] });
    const builder = new InventoryManifestBuilder(
      fixture.client,
      { locationId: fixture.locationId, adjustments: [
        { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 99 },
      ]},
      fixture.config,
    );

    await expect(builder.build()).rejects.toMatchObject({
      code: PROTECTED_RESOURCE_CODE,
    });
  });

  it("allows items when no protectedTags match", async () => {
    const items = [rawInventoryItem(1, 10, { tags: ["fragile", "sale"] })];
    const fixture = buildInventoryFixture(items, { protectedTags: ["do-not-touch"] });
    const builder = new InventoryManifestBuilder(
      fixture.client,
      { locationId: fixture.locationId, adjustments: [
        { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 99 },
      ]},
      fixture.config,
    );

    const manifest = await builder.build();
    expect(manifest.items).toHaveLength(1);
  });
});

describe("InventoryExecutor (ticket #11)", () => {
  it("executes a single item successfully", async () => {
    const items = [rawInventoryItem(1, 10)];
    const fixture = buildInventoryFixture(items);
    const executor = new InventoryExecutor(fixture.client, fixture.locationId);

    const outcome = await executor.execute({
      ref: "gid://shopify/InventoryItem/1",
      before: { inventoryItemId: "gid://shopify/InventoryItem/1", locationId: fixture.locationId, available: 10 },
      after: { inventoryItemId: "gid://shopify/InventoryItem/1", locationId: fixture.locationId, available: 99 },
      payload: { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 99 },
    });

    expect(outcome).toEqual({ ref: "gid://shopify/InventoryItem/1", ok: true });
  });
});

describe("InventoryStateReader (ticket #11)", () => {
  it("reads current inventory levels", async () => {
    const items = [rawInventoryItem(1, 42)];
    const fixture = buildInventoryFixture(items);
    const reader = new InventoryStateReader(fixture.client, fixture.locationId);

    const current = await reader.readCurrent(["gid://shopify/InventoryItem/1"]);

    expect(current).toEqual({
      "gid://shopify/InventoryItem/1": {
        inventoryItemId: "gid://shopify/InventoryItem/1",
        locationId: fixture.locationId,
        available: 42,
      },
    });
  });

  it("returns empty record for empty refs array", async () => {
    const items = [rawInventoryItem(1, 42)];
    const fixture = buildInventoryFixture(items);
    const reader = new InventoryStateReader(fixture.client, fixture.locationId);

    const current = await reader.readCurrent([]);

    expect(current).toEqual({});
  });
});

describe("update_inventory two-phase safety matrix (ticket #11)", () => {
  it("threshold trip: plan with 25+ items requires approval", async () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      rawInventoryItem(i + 1, i * 10),
    );
    const fixture = buildInventoryFixture(items);
    const { manager } = makeManager(fixture);

    const adjustments = items.map((item) => ({
      inventoryItemId: item.id,
      quantity: 999,
    }));

    const preview = await manager.preview(
      new InventoryManifestBuilder(
        fixture.client,
        { locationId: fixture.locationId, adjustments },
        fixture.config,
      ),
      { tool: TOOL, reason: "inventory reset" },
    );

    expect(preview.status).toBe("awaiting_approval");
    expect(preview.itemCount).toBe(30);
  });

  it("hard cap: plan with 250+ items is refused without a token", async () => {
    const items = Array.from({ length: 300 }, (_, i) =>
      rawInventoryItem(i + 1, i * 10),
    );
    const fixture = buildInventoryFixture(items);
    const { manager, planStore, audit } = makeManager(fixture);

    const adjustments = items.map((item) => ({
      inventoryItemId: item.id,
      quantity: 999,
    }));

    const err = await errorOf(
      manager.preview(
        new InventoryManifestBuilder(
          fixture.client,
          { locationId: fixture.locationId, adjustments },
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

  it("protected-tag refusal: plan touching a protected item throws before token issue", async () => {
    const items = [
      rawInventoryItem(1, 10, { tags: ["do-not-touch"] }),
      rawInventoryItem(2, 20),
    ];
    const fixture = buildInventoryFixture(items);
    const { manager } = makeManager(fixture);

    const adjustments = [
      { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 99 },
      { inventoryItemId: "gid://shopify/InventoryItem/2", quantity: 99 },
    ];

    const err = await errorOf(
      manager.preview(
        new InventoryManifestBuilder(
          fixture.client,
          { locationId: fixture.locationId, adjustments },
          fixture.config,
        ),
        { tool: TOOL },
      ),
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code: string }).code).toBe(PROTECTED_RESOURCE_CODE);
  });

  it("full round-trip: preview -> execute with correct ledger", async () => {
    const items = [
      rawInventoryItem(1, 10),
      rawInventoryItem(2, 20),
    ];
    const fixture = buildInventoryFixture(items);
    const { manager } = makeManager(fixture);

    const adjustments = [
      { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 15 },
      { inventoryItemId: "gid://shopify/InventoryItem/2", quantity: 25 },
    ];

    const preview = await manager.preview(
      new InventoryManifestBuilder(
        fixture.client,
        { locationId: fixture.locationId, adjustments },
        fixture.config,
      ),
      { tool: TOOL },
    );

    expect(preview.status).toBe("previewed");
    expect(preview.itemCount).toBe(2);

    const result = await manager.executePlan(preview.planToken, preview.manifest);

    expect(result.status).toBe("executed");
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.ledger.attempted.map((o) => o.ref)).toEqual([
      "gid://shopify/InventoryItem/1",
      "gid://shopify/InventoryItem/2",
    ]);
  });

  it("partial failure: one bad item does not block the others", async () => {
    const items = [
      rawInventoryItem(1, 10),
      rawInventoryItem(2, 20),
    ];
    const fixture = buildInventoryFixture(items, {
      // Override fetch to simulate a failure on second item
    });
    const failingClient = new AdminClient(fixture.config.shopify, {
      fetch: async (_input, init) => {
        const raw = JSON.parse(String(init?.body ?? "{}")) as {
          variables?: { input?: { quantities?: Array<{ inventoryItemId: string }> } };
        };
        const qty = raw.variables?.input?.quantities;
        if (qty?.some((q) => q.inventoryItemId === "gid://shopify/InventoryItem/2")) {
          throw new Error("simulated network failure for item 2");
        }
        return jsonResponse({
          data: {
            inventorySetQuantities: {
              inventoryLevels: (qty ?? []).map((q, i) => ({
                id: `gid://shopify/InventoryLevel/${i}`,
                available: q.inventoryItemId === "gid://shopify/InventoryItem/1" ? 99 : 0,
                location: { id: fixture.locationId },
              })),
              userErrors: [],
            },
          },
        });
      },
    });
    const planStore = new PlanStore<Manifest<InventoryManifestItem>>({ planTtlMs: 60_000 });
    const snapshotStore = new SnapshotStore<import("../../src/tools/updateInventory.js").InventoryLevelSnapshot>(60_000);
    const audit = new MemorySink();
    const manager = new PlanManager<InventoryManifestItem, import("../../src/tools/updateInventory.js").InventoryLevelSnapshot, void>({
      store: planStore,
      executor: new InventoryExecutor(failingClient, fixture.locationId),
      stateReader: new InventoryStateReader(fixture.client, fixture.locationId),
      snapshotStore,
      audit,
      callerId: "tester",
    });

    const adjustments = [
      { inventoryItemId: "gid://shopify/InventoryItem/1", quantity: 99 },
      { inventoryItemId: "gid://shopify/InventoryItem/2", quantity: 99 },
    ];

    const preview = await manager.preview(
      new InventoryManifestBuilder(
        fixture.client,
        { locationId: fixture.locationId, adjustments },
        fixture.config,
      ),
      { tool: TOOL },
    );

    const result = await manager.executePlan(preview.planToken, preview.manifest);

    expect(result.status).toBe("executed");
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.ledger.failed[0]!.ref).toBe("gid://shopify/InventoryItem/2");
    expect(result.ledger.failed[0]!.error!.code).toBe("SHOPIFY_API_ERROR");
  });
});
