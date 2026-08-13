import { PlanError, PlanStore } from "safe-write-mcp-core";
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPROVAL_REQUIRED_ABOVE_ITEMS,
  DEFAULT_HARD_MAX_ITEMS,
} from "../../src/config.js";
import { AdminClient } from "../../src/graphql/adminClient.js";
import type { ShopifyConfig } from "../../src/config.js";
import type { Manifest } from "../../src/plans/manifest.js";
import { ExecutionError } from "../../src/plans/errors.js";
import { SnapshotStore } from "../../src/plans/snapshotStore.js";
import {
  CreateDiscountTool,
  type CreateDiscountManifestItem,
  type CreateDiscountInput,
  type ExistingDiscount,
} from "../../src/tools/createDiscount.js";
import {
  ToyDiscountStore,
  toExistingDiscount,
  toyDiscountFetch,
} from "../fixtures/toyDiscountApi.ts";

const TOOL = "create_discount";

class MemorySink implements AuditSink {
  events: AuditEvent[] = [];

  record(event: AuditEvent): undefined {
    this.events.push(event);
    return undefined;
  }
}

function shopifyConfig(): ShopifyConfig {
  return {
    storeDomain: "test.myshopify.com",
    apiVersion: "2026-04",
    adminToken: "shpat_testtoken123",
  };
}

interface Harness {
  tool: CreateDiscountTool;
  store: ToyDiscountStore;
  planStore: PlanStore<Manifest<CreateDiscountManifestItem>>;
  snapshotStore: SnapshotStore<ExistingDiscount | null>;
  audit: MemorySink;
  calls: { calls: string[] };
}

function makeHarness(
  overrides: Partial<{
    planTtlMs: number;
    approvalRequiredAboveItems: number;
    hardMaxItems: number;
  }> = {},
): Harness {
  const store = new ToyDiscountStore();
  const calls: { calls: string[] } = { calls: [] };
  const client = new AdminClient(shopifyConfig(), {
    fetch: toyDiscountFetch(store, calls),
  });
  const planStore = new PlanStore<Manifest<CreateDiscountManifestItem>>({
    planTtlMs: overrides.planTtlMs ?? 60_000,
  });
  const snapshotStore = new SnapshotStore<ExistingDiscount | null>(
    overrides.planTtlMs ?? 60_000,
  );
  const audit = new MemorySink();
  const tool = new CreateDiscountTool({
    client,
    store: planStore,
    snapshotStore,
    audit,
    callerId: "tester",
    approvalRequiredAboveItems: overrides.approvalRequiredAboveItems,
    hardMaxItems: overrides.hardMaxItems,
  });
  return { tool, store, planStore, snapshotStore, audit, calls };
}

const percentage = (code: string, value = 20): CreateDiscountInput => ({
  code,
  valueType: "PERCENTAGE",
  value,
  usageLimit: 100,
});

const fixedAmount = (code: string, value = 5): CreateDiscountInput => ({
  code,
  valueType: "FIXED_AMOUNT",
  value,
});

async function errorOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe("create_discount (ticket #15)", () => {
  it("previews a percentage discount with zero mutation calls", async () => {
    const harness = makeHarness();
    const before = harness.store.all();

    const preview = await harness.tool.preview([percentage("SUMMER20")], {
      tool: TOOL,
      reason: "summer sale",
    });

    expect(preview.status).toBe("previewed");
    expect(preview.itemCount).toBe(1);
    expect(preview.manifest.items).toHaveLength(1);
    const item = preview.manifest.items[0]!;
    expect(item.ref).toBe("SUMMER20");
    expect(item.before).toBeNull();
    expect(item.after).toMatchObject({
      code: "SUMMER20",
      valueType: "PERCENTAGE",
      value: 20,
      usageLimit: 100,
      appliesOncePerCustomer: false,
    });
    expect(item.payload).toEqual(percentage("SUMMER20"));

    expect(harness.calls.calls.every((c) => c === "discountByCode")).toBe(true);
    expect(harness.store.all()).toEqual(before);
  });

  it("previews a fixed-amount discount and builds a stable digest", async () => {
    const harness = makeHarness();

    const preview = await harness.tool.preview([fixedAmount("SPEND10")], {
      tool: TOOL,
    });

    expect(preview.manifest.items[0]!.before).toBeNull();
    expect(preview.manifest.items[0]!.after.valueType).toBe("FIXED_AMOUNT");
    expect(preview.manifest.digest).toHaveLength(64);
    expect(preview.manifest.beforeDigest).toHaveLength(64);

    const rePreview = await harness.tool.preview([fixedAmount("SPEND10")], {
      tool: TOOL,
    });
    expect(rePreview.manifest.digest).toBe(preview.manifest.digest);
    expect(rePreview.manifest.beforeDigest).toBe(preview.manifest.beforeDigest);
  });

  it("executes and creates the discount, keeping the null before-state snapshot", async () => {
    const harness = makeHarness();
    const preview = await harness.tool.preview([percentage("SUMMER20", 15)], {
      tool: TOOL,
    });

    const result = await harness.tool.execute(preview.planToken, preview.manifest);

    expect(result.status).toBe("executed");
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.ledger.succeeded[0]!.result!.id).toMatch(
      /^gid:\/\/shopify\/DiscountCodeNode\//,
    );

    const created = harness.store.get("SUMMER20");
    expect(created).toBeDefined();
    expect(created!.value).toBe(15);
    expect(created!.valueType).toBe("PERCENTAGE");
    expect(created!.status).toBe("ACTIVE");

    expect(harness.snapshotStore.has(preview.planToken)).toBe(true);
    expect(harness.snapshotStore.snapshot(preview.planToken)).toEqual({
      SUMMER20: null,
    });
  });

  it("rolls back by deactivating the created discount from the null snapshot", async () => {
    const harness = makeHarness();
    const preview = await harness.tool.preview([percentage("FLASH50")], {
      tool: TOOL,
    });
    const result = await harness.tool.execute(preview.planToken, preview.manifest);

    expect(result.succeededCount).toBe(1);
    const createdId = result.ledger.succeeded[0]!.result!.id;
    expect(harness.store.get("FLASH50")!.status).toBe("ACTIVE");

    expect(harness.snapshotStore.snapshot(preview.planToken)).toEqual({
      FLASH50: null,
    });

    await harness.tool.gateway.deactivate(createdId);

    expect(harness.store.get("FLASH50")!.status).toBe("EXPIRED");
    expect(harness.store.get("FLASH50")!.id).toBe(createdId);
  });

  it("refuses with STATE_CHANGED when the code appears before execute", async () => {
    const harness = makeHarness();
    const preview = await harness.tool.preview([percentage("RACE20")], {
      tool: TOOL,
    });
    harness.store.seed({
      code: "RACE20",
      title: "RACE20",
      valueType: "PERCENTAGE",
      value: 25,
      usageLimit: null,
      appliesOncePerCustomer: false,
      startsAt: null,
      endsAt: null,
      status: "ACTIVE",
    });

    const err = await errorOf(
      harness.tool.execute(preview.planToken, preview.manifest),
    );
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe("STATE_CHANGED");
    expect(harness.calls.calls).not.toContain("discountCodeBasicCreate");

    const refused = harness.audit.events.find((e) => e.status === "refused");
    expect(refused).toBeDefined();
    expect(refused!.detail).toContain("STATE_CHANGED");
  });

  it("records a partial-failure ledger instead of aborting the plan", async () => {
    const harness = makeHarness();
    harness.store.failCreate("SLOW10");
    const preview = await harness.tool.preview(
      [percentage("FAST10"), percentage("SLOW10")],
      { tool: TOOL },
    );

    const result = await harness.tool.execute(preview.planToken, preview.manifest);

    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.ledger.succeeded[0]!.ref).toBe("FAST10");
    expect(result.ledger.failed[0]!.ref).toBe("SLOW10");
    expect(result.ledger.failed[0]!.error!.code).toBe("SHOPIFY_API_ERROR");
    expect(harness.store.has("FAST10")).toBe(true);
    expect(harness.store.has("SLOW10")).toBe(false);
  });

  it("refuses a preview when a code already exists", async () => {
    const harness = makeHarness();
    harness.store.seed({
      code: "TAKEN10",
      title: "TAKEN10",
      valueType: "PERCENTAGE",
      value: 10,
      usageLimit: null,
      appliesOncePerCustomer: false,
      startsAt: null,
      endsAt: null,
      status: "ACTIVE",
    });

    const err = await errorOf(
      harness.tool.preview([percentage("TAKEN10")], { tool: TOOL }),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("already exists");
  });

  it("refuses a preview with duplicate codes in one plan", async () => {
    const harness = makeHarness();
    const err = await errorOf(
      harness.tool.preview([percentage("DUP10"), percentage("DUP10")], {
        tool: TOOL,
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("more than once");
  });

  it("refuses invalid inputs at preview", async () => {
    const harness = makeHarness();
    const invalid = [
      { ...percentage("A"), code: "  " },
      { ...percentage("B"), value: 101 },
      { ...percentage("C"), value: 0 },
      { ...fixedAmount("D"), value: -1 },
      { ...percentage("E"), usageLimit: 0 },
      { ...percentage("F"), startsAt: "not-a-date" },
    ];
    for (const input of invalid) {
      const err = await errorOf(harness.tool.preview([input], { tool: TOOL }));
      expect(err).toBeInstanceOf(Error);
    }
    expect(harness.store.all()).toEqual([]);
  });

  it("gates plans at or above approvalRequiredAboveItems on human approval", async () => {
    const harness = makeHarness({ approvalRequiredAboveItems: 2, hardMaxItems: 5 });
    const preview = await harness.tool.preview(
      [percentage("A1"), percentage("A2")],
      { tool: TOOL },
    );
    expect(preview.status).toBe("awaiting_approval");

    const refused = await errorOf(
      harness.tool.execute(preview.planToken, preview.manifest),
    );
    expect(refused).toBeInstanceOf(PlanError);
    expect((refused as PlanError).code).toBe("AWAITING_APPROVAL");
    expect(harness.store.all()).toEqual([]);

    const approved = harness.planStore.approve(preview.planToken);
    expect(approved.ok).toBe(true);

    const result = await harness.tool.execute(preview.planToken, preview.manifest);
    expect(result.succeededCount).toBe(2);
    expect(harness.store.has("A1")).toBe(true);
    expect(harness.store.has("A2")).toBe(true);
  });

  it("refuses a plan above hardMaxItems without issuing a token", async () => {
    const harness = makeHarness({ approvalRequiredAboveItems: 2, hardMaxItems: 3 });
    const err = await errorOf(
      harness.tool.preview(
        [percentage("H1"), percentage("H2"), percentage("H3"), percentage("H4")],
        { tool: TOOL },
      ),
    );
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe("HARD_MAX_ITEMS_EXCEEDED");
    expect(harness.planStore.listPending()).toEqual([]);
    expect(
      harness.audit.events.find((e) => e.status === "refused"),
    ).toBeDefined();
  });

  it("applies the config defaults when thresholds are not overridden", async () => {
    const harness = makeHarness();

    const small = await harness.tool.preview([percentage("ONE")], { tool: TOOL });
    expect(small.status).toBe("previewed");
    expect(DEFAULT_APPROVAL_REQUIRED_ABOVE_ITEMS).toBe(25);
    expect(DEFAULT_HARD_MAX_ITEMS).toBe(250);

    const bulk = Array.from({ length: 26 }, (_, i) => percentage(`B${i}`));
    const gated = await harness.tool.preview(bulk, { tool: TOOL });
    expect(gated.status).toBe("awaiting_approval");
    expect(gated.itemCount).toBe(26);

    const huge = Array.from({ length: 251 }, (_, i) => percentage(`M${i}`));
    const err = await errorOf(harness.tool.preview(huge, { tool: TOOL }));
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe("HARD_MAX_ITEMS_EXCEEDED");
  });

  it("matches the executed discount against the toy record shape", async () => {
    const harness = makeHarness();
    const preview = await harness.tool.preview([fixedAmount("SHOP5", 7.5)], {
      tool: TOOL,
    });
    const result = await harness.tool.execute(preview.planToken, preview.manifest);

    const record = harness.store.get("SHOP5")!;
    expect(result.ledger.succeeded[0]!.result).toEqual(
      toExistingDiscount(record),
    );
    expect(result.ledger.succeeded[0]!.result!.value).toBe(7.5);
    expect(result.ledger.succeeded[0]!.result!.valueType).toBe("FIXED_AMOUNT");
    expect(result.ledger.succeeded[0]!.result!.active).toBe(true);
  });
});
