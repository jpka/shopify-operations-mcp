import { PlanError, PlanStore } from "safe-write-mcp-core";
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";
import { describe, expect, it, vi } from "vitest";
import { ExecutionError } from "../../src/plans/errors.ts";
import { PlanManager } from "../../src/plans/planManager.ts";
import type { Manifest } from "../../src/plans/manifest.ts";
import { SnapshotStore } from "../../src/plans/snapshotStore.ts";
import {
  ToyPriceExecutor,
  ToyPriceManifestBuilder,
  ToyPriceStateReader,
  ToyStore,
} from "../fixtures/toyShopify.ts";
import type { PriceManifestItem, ToyProduct } from "../fixtures/toyShopify.ts";

const TOOL = "update_prices";

class MemorySink implements AuditSink {
  events: AuditEvent[] = [];

  record(event: AuditEvent): undefined {
    this.events.push(event);
    return undefined;
  }
}

interface ManagerFixture {
  manager: PlanManager<PriceManifestItem, ToyProduct, void>;
  planStore: PlanStore<Manifest<PriceManifestItem>>;
  snapshotStore: SnapshotStore<ToyProduct>;
  audit: MemorySink;
  store: ToyStore;
}

function makeManager(store: ToyStore, executor?: ToyPriceExecutor): ManagerFixture {
  const planStore = new PlanStore<Manifest<PriceManifestItem>>({ planTtlMs: 60_000 });
  const snapshotStore = new SnapshotStore<ToyProduct>(60_000);
  const audit = new MemorySink();
  const manager = new PlanManager<PriceManifestItem, ToyProduct, void>({
    store: planStore,
    executor: executor ?? new ToyPriceExecutor(store),
    stateReader: new ToyPriceStateReader(store),
    snapshotStore,
    audit,
    callerId: "tester",
  });
  return { manager, planStore, snapshotStore, audit, store };
}

function seed(overrides: Partial<ToyProduct>[] = []): ToyStore {
  const products: ToyProduct[] = [
    { id: "a", title: "Alpha", price: 10, tags: [] },
    { id: "b", title: "Beta", price: 20, tags: [] },
    { id: "c", title: "Gamma", price: 30, tags: [] },
  ].map((product, i) => ({ ...product, ...overrides[i] }));
  return new ToyStore(products);
}

async function errorOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe("PlanManager two-phase framework (ticket #9)", () => {
  it("preview performs zero mutation calls and leaves the store unchanged", async () => {
    const store = seed();
    const executor = new ToyPriceExecutor(store);
    const executeSpy = vi.spyOn(executor, "execute");
    const { manager } = makeManager(store, executor);
    const before = store.all();

    const preview = await manager.preview(
      new ToyPriceManifestBuilder(store, [
        { id: "a", newPrice: 12 },
        { id: "b", newPrice: 22 },
      ]),
      { tool: TOOL, reason: "sale" },
    );

    expect(preview.status).toBe("previewed");
    expect(preview.itemCount).toBe(2);
    expect(preview.manifest.items.map((i) => i.ref)).toEqual(["a", "b"]);
    expect(preview.manifest.items[0]!.before.price).toBe(10);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(store.all()).toEqual(before);
  });

  it("snapshot store keeps the per-item before-state on the plan for rollback", async () => {
    const store = seed();
    const { manager, snapshotStore } = makeManager(store);

    const preview = await manager.preview(
      new ToyPriceManifestBuilder(store, [{ id: "a", newPrice: 12 }]),
      { tool: TOOL },
    );

    expect(snapshotStore.has(preview.planToken)).toBe(true);
    expect(snapshotStore.snapshot(preview.planToken)).toEqual({
      a: expect.objectContaining({ price: 10 }),
    });
  });

  it("refuses with STATE_CHANGED when the data drifted since preview", async () => {
    const store = seed();
    const executor = new ToyPriceExecutor(store);
    const executeSpy = vi.spyOn(executor, "execute");
    const { manager, audit } = makeManager(store, executor);

    const preview = await manager.preview(
      new ToyPriceManifestBuilder(store, [{ id: "a", newPrice: 12 }]),
      { tool: TOOL },
    );

    const productA = store.get("a")!;
    store.set({ ...productA, price: 11 });

    const err = await errorOf(manager.executePlan(preview.planToken, preview.manifest));
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe("STATE_CHANGED");
    expect(executeSpy).not.toHaveBeenCalled();

    const refused = audit.events.find((e) => e.status === "refused");
    expect(refused).toBeDefined();
    expect(refused!.planToken).toBe(preview.planToken);
    expect(refused!.detail).toContain("STATE_CHANGED");
  });

  it("records a per-item ledger where partial failure is never hidden", async () => {
    const store = seed();
    const executor = new ToyPriceExecutor(store, ["b"]);
    const { manager, audit } = makeManager(store, executor);

    const preview = await manager.preview(
      new ToyPriceManifestBuilder(store, [
        { id: "a", newPrice: 12 },
        { id: "b", newPrice: 22 },
        { id: "c", newPrice: 32 },
      ]),
      { tool: TOOL },
    );

    const result = await manager.executePlan(preview.planToken, preview.manifest);

    expect(result.status).toBe("executed");
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.ledger.attempted.map((o) => o.ref)).toEqual(["a", "b", "c"]);
    expect(result.ledger.succeeded.map((o) => o.ref)).toEqual(["a", "c"]);
    expect(result.ledger.failed.map((o) => o.ref)).toEqual(["b"]);
    expect(result.ledger.failed[0]!.error!.code).toBe("SIMULATED_FAILURE");
    expect(store.get("a")!.price).toBe(12);
    expect(store.get("b")!.price).toBe(20);
    expect(store.get("c")!.price).toBe(32);

    const executed = audit.events.find((e) => e.status === "executed");
    expect(executed).toBeDefined();
    expect(executed!.tool).toBe(TOOL);
    expect(executed!.callerId).toBe("tester");
    expect(executed!.previewCount).toBe(3);
    expect(executed!.planToken).toBe(preview.planToken);
    expect(executed!.detail).toContain('"failed":1');
    expect(executed!.detail).toContain("SIMULATED_FAILURE");
  });

  it("tokens are single-use: a second execute is refused with PLAN_USED", async () => {
    const store = seed();
    const { manager } = makeManager(store);

    const preview = await manager.preview(
      new ToyPriceManifestBuilder(store, [{ id: "a", newPrice: 12 }]),
      { tool: TOOL },
    );

    const first = await manager.executePlan(preview.planToken, preview.manifest);
    expect(first.status).toBe("executed");
    expect(store.get("a")!.price).toBe(12);

    const err = await errorOf(manager.executePlan(preview.planToken, preview.manifest));
    expect(err).toBeInstanceOf(PlanError);
    expect((err as PlanError).code).toBe("PLAN_USED");
    expect(store.get("a")!.price).toBe(12);
  });

  it("refuses a manifest that differs from the previewed one (PLAN_MISMATCH)", async () => {
    const store = seed();
    const { manager } = makeManager(store);

    const preview = await manager.preview(
      new ToyPriceManifestBuilder(store, [{ id: "a", newPrice: 12 }]),
      { tool: TOOL },
    );

    const tampered = new ToyPriceManifestBuilder(store, [
      { id: "a", newPrice: 15 },
    ]).build();
    const err = await errorOf(manager.executePlan(preview.planToken, tampered));
    expect(err).toBeInstanceOf(PlanError);
    expect((err as PlanError).code).toBe("PLAN_MISMATCH");
  });

  it("gates plans above the item threshold on out-of-band human approval", async () => {
    const targets = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, newPrice: i + 1 }));
    const store = new ToyStore(
      Array.from({ length: 30 }, (_, i) => ({
        id: `p${i}`,
        title: `P${i}`,
        price: i,
        tags: [],
      })),
    );
    const { manager, planStore } = makeManager(store);

    const preview = await manager.preview(
      new ToyPriceManifestBuilder(store, targets),
      { tool: TOOL },
    );
    expect(preview.status).toBe("awaiting_approval");

    const refused = await errorOf(manager.executePlan(preview.planToken, preview.manifest));
    expect(refused).toBeInstanceOf(PlanError);
    expect((refused as PlanError).code).toBe("AWAITING_APPROVAL");

    const approved = planStore.approve(preview.planToken);
    expect(approved.ok).toBe(true);

    const result = await manager.executePlan(preview.planToken, preview.manifest);
    expect(result.succeededCount).toBe(30);
  });

  it("refuses a plan above the hard item cap without issuing a token", async () => {
    const targets = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, newPrice: i + 1 }));
    const store = new ToyStore(
      Array.from({ length: 300 }, (_, i) => ({
        id: `p${i}`,
        title: `P${i}`,
        price: i,
        tags: [],
      })),
    );
    const { manager, planStore, audit } = makeManager(store);

    const err = await errorOf(
      manager.preview(new ToyPriceManifestBuilder(store, targets), { tool: TOOL }),
    );
    expect(err).toBeInstanceOf(ExecutionError);
    expect((err as ExecutionError).code).toBe("HARD_MAX_ITEMS_EXCEEDED");
    expect(audit.events.find((e) => e.status === "refused")).toBeDefined();
    expect(planStore.listPending()).toEqual([]);
  });
});