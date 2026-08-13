import { PlanStore } from "safe-write-mcp-core";
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";
import { describe, expect, it } from "vitest";
import type { AppConfig, ShopifyConfig } from "../../src/config.js";
import { AdminClient } from "../../src/graphql/adminClient.js";
import type { AdminClientOptions } from "../../src/graphql/adminClient.js";
import { PlanManager } from "../../src/plans/planManager.ts";
import { SnapshotStore } from "../../src/plans/snapshotStore.ts";
import { ExecutionError } from "../../src/plans/errors.js";
import {
  DiscountManifestBuilder,
  DiscountStateReader,
  DiscountExecutor,
  DiscountRollbackExecutor,
  type CreateDiscountArgs,
  type DiscountSnapshot,
} from "../../src/tools/createDiscount.ts";
import type { Manifest } from "../../src/plans/manifest.js";
import type { ManifestItem } from "../../src/plans/manifest.js";
import type { RollbackTarget } from "../../src/tools/rollbackPlan.js";
import { RollbackPlan } from "../../src/tools/rollbackPlan.js";
import type { ExecutedPlan } from "../../src/tools/rollbackPlan.js";

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

interface RawDiscountNode {
  id: string;
  code: string;
  discountType: string;
  value: string;
  usageLimit: number | null;
  status: string;
}

class MemorySink implements AuditSink {
  events: AuditEvent[] = [];
  record(event: AuditEvent): undefined {
    this.events.push(event);
    return undefined;
  }
}

class MemoryDiscountStore {
  private discounts = new Map<string, RawDiscountNode>();

  get(code: string): RawDiscountNode | undefined {
    return this.discounts.get(code);
  }

  set(discount: RawDiscountNode): void {
    this.discounts.set(discount.code, discount);
  }

  has(code: string): boolean {
    return this.discounts.has(code);
  }

  delete(code: string): void {
    this.discounts.delete(code);
  }

  getById(id: string): RawDiscountNode | undefined {
    for (const d of this.discounts.values()) {
      if (d.id === id) return d;
    }
    return undefined;
  }
}

interface DiscountFixture {
  client: AdminClient;
  store: MemoryDiscountStore;
  config: AppConfig;
}

function buildDiscountFixture(
  existingDiscounts: RawDiscountNode[] = [],
  configOverrides?: Partial<AppConfig>,
): DiscountFixture {
  const config = appConfig(configOverrides);
  const store = new MemoryDiscountStore();
  for (const d of existingDiscounts) {
    store.set(d);
  }

  const fetchImpl: FetchLike = async (_input, init) => {
    const raw = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables?: Record<string, unknown>;
    };

    if (raw.query.includes("GetDiscount")) {
      const code = (raw.variables as { code: string }).code;
      const discount = store.get(code);
      if (discount) {
        return jsonResponse({
          data: { discount },
        });
      }
      return jsonResponse({ data: { discount: null } });
    }

    if (raw.query.includes("DiscountCodeBasicCreate")) {
      const input = (raw.variables as { input: { code: string; discountType: string; value: string; usageLimit: number | null } }).input;
      const newDiscount: RawDiscountNode = {
        id: `gid://shopify/Discount/${Date.now()}`,
        code: input.code,
        discountType: input.discountType,
        value: input.value,
        usageLimit: input.usageLimit,
        status: "active",
      };
      store.set(newDiscount);
      return jsonResponse({
        data: {
          discountCodeBasicCreate: {
            discount: newDiscount,
            userErrors: [],
          },
        },
      });
    }

    if (raw.query.includes("DiscountCodeBasicDeactivate")) {
      const id = (raw.variables as { id: string }).id;
      const discount = store.getById(id);
      if (discount) {
        const updated = { ...discount, status: "deactivated" };
        store.set(updated);
        return jsonResponse({
          data: {
            discountCodeBasicDeactivate: {
              discount: { id: updated.id, code: updated.code, status: "deactivated" },
              userErrors: [],
            },
          },
        });
      }
      return jsonResponse({
        data: {
          discountCodeBasicDeactivate: {
            discount: null,
            userErrors: [{ field: ["id"], message: "Discount not found" }],
          },
        },
      });
    }

    return jsonResponse({ data: {} });
  };

  const client = new AdminClient(config.shopify, { fetch: fetchImpl });
  return { client, store, config };
}

interface ManagerFixture {
  manager: PlanManager<ManifestItem<DiscountSnapshot | null, DiscountSnapshot>, DiscountSnapshot | null, void>;
  planStore: PlanStore<Manifest<ManifestItem<DiscountSnapshot | null, DiscountSnapshot>>>;
  snapshotStore: SnapshotStore<DiscountSnapshot | null>;
  audit: MemorySink;
}

function makeManager(fixture: DiscountFixture): ManagerFixture {
  const planStore = new PlanStore<Manifest<ManifestItem<DiscountSnapshot | null, DiscountSnapshot>>>({ planTtlMs: 60_000 });
  const snapshotStore = new SnapshotStore<DiscountSnapshot | null>(60_000);
  const audit = new MemorySink();
  const manager = new PlanManager<ManifestItem<DiscountSnapshot | null, DiscountSnapshot>, DiscountSnapshot | null, void>({
    store: planStore,
    executor: new DiscountExecutor(fixture.client),
    stateReader: new DiscountStateReader(fixture.client),
    snapshotStore,
    audit,
    callerId: "tester",
  });
  return { manager, planStore, snapshotStore, audit };
}

const TOOL = "create_discount";

async function errorOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe("DiscountManifestBuilder (ticket #15)", () => {
  it("assembles a manifest with null before-snapshot for new discount", async () => {
    const fixture = buildDiscountFixture();
    const args: CreateDiscountArgs = {
      code: "SUMMER20",
      discountType: "percentage",
      value: 20,
      usageLimit: 100,
    };

    const builder = new DiscountManifestBuilder(fixture.client, args, fixture.config);
    const manifest = await builder.build();

    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]!).toMatchObject({
      ref: "SUMMER20",
      before: null,
      after: {
        code: "SUMMER20",
        discountType: "percentage",
        value: 20,
        usageLimit: 100,
        status: "active",
      },
      payload: { code: "SUMMER20", discountType: "percentage", value: 20, usageLimit: 100 },
    });
  });

  it("computes stable digests for drift detection", async () => {
    const fixture = buildDiscountFixture();
    const args: CreateDiscountArgs = {
      code: "SUMMER20",
      discountType: "percentage",
      value: 20,
    };

    const builder = new DiscountManifestBuilder(fixture.client, args, fixture.config);
    const manifest = await builder.build();

    expect(typeof manifest.digest).toBe("string");
    expect(typeof manifest.beforeDigest).toBe("string");
    expect(manifest.digest.length).toBeGreaterThan(0);
    expect(manifest.beforeDigest.length).toBeGreaterThan(0);
  });

  it("throws when discount code already exists", async () => {
    const existingDiscount: RawDiscountNode = {
      id: "gid://shopify/Discount/1",
      code: "SUMMER20",
      discountType: "PERCENTAGE",
      value: "20.0",
      usageLimit: 100,
      status: "active",
    };
    const fixture = buildDiscountFixture([existingDiscount]);
    const args: CreateDiscountArgs = {
      code: "SUMMER20",
      discountType: "percentage",
      value: 20,
    };

    const builder = new DiscountManifestBuilder(fixture.client, args, fixture.config);

    await expect(builder.build()).rejects.toThrow("already exists");
  });

  it("supports fixed_amount discount type", async () => {
    const fixture = buildDiscountFixture();
    const args: CreateDiscountArgs = {
      code: "TENOFF",
      discountType: "fixed_amount",
      value: 10.00,
      usageLimit: null,
    };

    const builder = new DiscountManifestBuilder(fixture.client, args, fixture.config);
    const manifest = await builder.build();

    expect(manifest.items[0]!.after.discountType).toBe("fixed_amount");
    expect(manifest.items[0]!.after.value).toBe(10.00);
    expect(manifest.items[0]!.after.usageLimit).toBeNull();
  });
});

describe("DiscountExecutor (ticket #15)", () => {
  it("executes discount creation successfully", async () => {
    const fixture = buildDiscountFixture();
    const executor = new DiscountExecutor(fixture.client);

    const outcome = await executor.execute({
      ref: "SUMMER20",
      before: null,
      after: { code: "SUMMER20", discountType: "percentage", value: 20, usageLimit: 100, status: "active" },
      payload: { code: "SUMMER20", discountType: "percentage", value: 20, usageLimit: 100 },
    });

    expect(outcome).toEqual({ ref: "SUMMER20", ok: true });
  });

  it("returns failure outcome when discount creation fails", async () => {
    const fixture = buildDiscountFixture();
    const failingClient = new AdminClient(fixture.config.shopify, {
      fetch: async () => {
        return jsonResponse({
          data: {
            discountCodeBasicCreate: {
              discount: null,
              userErrors: [{ field: ["code"], message: "Invalid discount code" }],
            },
          },
        });
      },
    });
    const executor = new DiscountExecutor(failingClient);

    const outcome = await executor.execute({
      ref: "BADCODE",
      before: null,
      after: { code: "BADCODE", discountType: "percentage", value: 20, usageLimit: null, status: "active" },
      payload: { code: "BADCODE", discountType: "percentage", value: 20, usageLimit: null },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe("SHOPIFY_USER_ERROR");
  });
});

describe("DiscountStateReader (ticket #15)", () => {
  it("returns discount snapshot when discount exists", async () => {
    const existingDiscount: RawDiscountNode = {
      id: "gid://shopify/Discount/1",
      code: "SUMMER20",
      discountType: "PERCENTAGE",
      value: "20.0",
      usageLimit: 100,
      status: "active",
    };
    const fixture = buildDiscountFixture([existingDiscount]);
    const reader = new DiscountStateReader(fixture.client);

    const current = await reader.readCurrent(["SUMMER20"]);

    expect(current["SUMMER20"]).toEqual({
      code: "SUMMER20",
      discountType: "percentage",
      value: 20,
      usageLimit: 100,
      status: "active",
    });
  });

  it("returns empty record when discount does not exist", async () => {
    const fixture = buildDiscountFixture();
    const reader = new DiscountStateReader(fixture.client);

    const current = await reader.readCurrent(["NONEXISTENT"]);

    expect(current).toEqual({});
  });

  it("returns empty record for empty refs array", async () => {
    const fixture = buildDiscountFixture();
    const reader = new DiscountStateReader(fixture.client);

    const current = await reader.readCurrent([]);

    expect(current).toEqual({});
  });
});

describe("DiscountRollbackExecutor (ticket #15)", () => {
  it("deactivates discount successfully", async () => {
    const existingDiscount: RawDiscountNode = {
      id: "gid://shopify/Discount/1",
      code: "SUMMER20",
      discountType: "PERCENTAGE",
      value: "20.0",
      usageLimit: 100,
      status: "active",
    };
    const fixture = buildDiscountFixture([existingDiscount]);
    const executor = new DiscountRollbackExecutor(fixture.client);

    const outcome = await executor.execute({
      ref: "SUMMER20",
      before: { code: "SUMMER20", discountType: "percentage", value: 20, usageLimit: 100, status: "active" },
      after: { code: "SUMMER20", discountType: "percentage", value: 20, usageLimit: 100, status: "deactivated" },
    });

    expect(outcome).toEqual({ ref: "SUMMER20", ok: true });
  });

  it("returns ok when discount does not exist", async () => {
    const fixture = buildDiscountFixture();
    const executor = new DiscountRollbackExecutor(fixture.client);

    const outcome = await executor.execute({
      ref: "NONEXISTENT",
      before: null,
      after: { code: "NONEXISTENT", discountType: "percentage", value: 20, usageLimit: null, status: "active" },
    });

    expect(outcome).toEqual({ ref: "NONEXISTENT", ok: true });
  });
});

describe("create_discount two-phase safety matrix (ticket #15)", () => {
  it("threshold trip: plan with 25+ items requires approval", async () => {
    const items: RawDiscountNode[] = [];
    for (let i = 0; i < 30; i++) {
      items.push({
        id: `gid://shopify/Discount/${i}`,
        code: `DISCOUNT${i}`,
        discountType: "PERCENTAGE",
        value: "10.0",
        usageLimit: null,
        status: "active",
      });
    }

    const fixture = buildDiscountFixture();
    const { manager } = makeManager(fixture);

    const preview = await manager.preview(
      {
        build: async () => {
          const manifestItems: ManifestItem<DiscountSnapshot | null, DiscountSnapshot>[] = items.map((d) => ({
            ref: d.code,
            before: null,
            after: {
              code: d.code,
              discountType: "percentage" as const,
              value: parseFloat(d.value),
              usageLimit: d.usageLimit,
              status: "active" as const,
            },
            payload: {
              code: d.code,
              discountType: "percentage" as const,
              value: parseFloat(d.value),
              usageLimit: d.usageLimit,
            },
          }));
          return assembleManifest(manifestItems);
        },
      },
      { tool: TOOL, reason: "bulk discount creation" },
    );

    expect(preview.status).toBe("awaiting_approval");
    expect(preview.itemCount).toBe(30);
  });

  it("hard cap: plan with 250+ items is refused without a token", async () => {
    const items: RawDiscountNode[] = [];
    for (let i = 0; i < 300; i++) {
      items.push({
        id: `gid://shopify/Discount/${i}`,
        code: `DISCOUNT${i}`,
        discountType: "PERCENTAGE",
        value: "10.0",
        usageLimit: null,
        status: "active",
      });
    }

    const fixture = buildDiscountFixture();
    const { manager, planStore, audit } = makeManager(fixture);

    const err = await errorOf(
      manager.preview(
        {
          build: async () => {
            const manifestItems: ManifestItem<DiscountSnapshot | null, DiscountSnapshot>[] = items.map((d) => ({
              ref: d.code,
              before: null,
              after: {
                code: d.code,
                discountType: "percentage" as const,
                value: parseFloat(d.value),
                usageLimit: d.usageLimit,
                status: "active" as const,
              },
              payload: {
                code: d.code,
                discountType: "percentage" as const,
                value: parseFloat(d.value),
                usageLimit: d.usageLimit,
              },
            }));
            return assembleManifest(manifestItems);
          },
        },
        { tool: TOOL },
      ),
    );

    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe("HARD_MAX_ITEMS_EXCEEDED");
    expect(planStore.listPending()).toEqual([]);
    expect(audit.events.find((e) => e.status === "refused")).toBeDefined();
  });

  it("full round-trip: preview -> execute with correct ledger", async () => {
    const fixture = buildDiscountFixture();
    const { manager } = makeManager(fixture);

    const preview = await manager.preview(
      new DiscountManifestBuilder(
        fixture.client,
        {
          code: "SUMMER20",
          discountType: "percentage",
          value: 20,
          usageLimit: 100,
        },
        fixture.config,
      ),
      { tool: TOOL },
    );

    expect(preview.status).toBe("previewed");
    expect(preview.itemCount).toBe(1);

    const result = await manager.executePlan(preview.planToken, preview.manifest);

    expect(result.status).toBe("executed");
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.ledger.attempted.map((o) => o.ref)).toEqual(["SUMMER20"]);
  });

  it("rollback deactivates the created discount", async () => {
    const fixture = buildDiscountFixture();
    const { manager, snapshotStore, audit } = makeManager(fixture);

    const preview = await manager.preview(
      new DiscountManifestBuilder(
        fixture.client,
        {
          code: "ROLLBACK_TEST",
          discountType: "percentage",
          value: 15,
          usageLimit: null,
        },
        fixture.config,
      ),
      { tool: TOOL },
    );

    expect(preview.status).toBe("previewed");

    await manager.executePlan(preview.planToken, preview.manifest);

    const snapshot = snapshotStore.snapshot(preview.planToken);
    expect(snapshot).not.toBeNull();

    const executed: Map<string, ExecutedPlan> = new Map();
    executed.set(preview.planToken, {
      kind: TOOL,
      executedRefs: ["ROLLBACK_TEST"],
    });

    const rollbackExecutor = new DiscountRollbackExecutor(fixture.client);
    const rollback = new RollbackPlan<DiscountSnapshot | null, void>({
      snapshotStore,
      executedOf: (planToken) => executed.get(planToken) ?? null,
      supportedKinds: [TOOL],
      executor: rollbackExecutor,
      audit,
      callerId: "tester",
    });

    const rollbackResult = await rollback.rollback(preview.planToken);

    expect(rollbackResult.status).toBe("rolled_back");
    expect(rollbackResult.succeededCount).toBe(1);
    expect(rollbackResult.failedCount).toBe(0);
    expect(rollbackResult.refs).toEqual(["ROLLBACK_TEST"]);
  });

  it("preview-made-zero-mutation-calls: preview does not call any mutations", async () => {
    const fixture = buildDiscountFixture();
    const mutationCalls: string[] = [];

    const trackingClient = new AdminClient(fixture.config.shopify, {
      fetch: async (_input, init) => {
        const raw = JSON.parse(String(init?.body ?? "{}")) as { query: string };
        if (raw.query.trimStart().startsWith("mutation")) {
          mutationCalls.push(raw.query);
        }
        return jsonResponse({ data: {} });
      },
    });

    const trackingManager = new PlanManager<ManifestItem<DiscountSnapshot | null, DiscountSnapshot>, DiscountSnapshot | null, void>({
      store: new PlanStore({ planTtlMs: 60_000 }),
      executor: new DiscountExecutor(trackingClient),
      stateReader: new DiscountStateReader(trackingClient),
      snapshotStore: new SnapshotStore(60_000),
      audit: new MemorySink(),
      callerId: "tester",
    });

    await trackingManager.preview(
      new DiscountManifestBuilder(
        trackingClient,
        {
          code: "TESTZERO",
          discountType: "percentage",
          value: 10,
        },
        fixture.config,
      ),
      { tool: TOOL },
    );

    expect(mutationCalls).toHaveLength(0);
  });
});

function assembleManifest<TItem extends ManifestItem>(items: readonly TItem[]): Manifest<TItem> {
  const { fingerprint } = require("safe-write-mcp-core");
  function beforeDigestOf(items: readonly Readonly<{ ref: string; before: unknown }>[]): string {
    const rows = items.map(({ ref, before }) => ({ ref, before }));
    return fingerprint({ before: rows });
  }
  function manifestDigest<TItem extends ManifestItem>(items: readonly TItem[]): string {
    return fingerprint({ items });
  }
  return {
    items,
    digest: manifestDigest(items),
    beforeDigest: beforeDigestOf(items),
  };
}
