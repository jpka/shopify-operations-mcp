import { PlanStore } from "safe-write-mcp-core";
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanManager } from "../../src/plans/planManager.ts";
import type { Manifest } from "../../src/plans/manifest.ts";
import { SnapshotStore } from "../../src/plans/snapshotStore.ts";
import { RollbackError, RollbackPlan } from "../../src/tools/rollbackPlan.ts";
import type { ExecutedPlan } from "../../src/tools/rollbackPlan.ts";
import {
  ToyPriceExecutor,
  ToyPriceManifestBuilder,
  ToyPriceStateReader,
  ToyRollbackExecutor,
  ToyStore,
} from "../fixtures/toyShopify.ts";
import type { PriceManifestItem, ToyProduct } from "../fixtures/toyShopify.ts";

const TOOL = "update_prices";
const SUPPORTED_KINDS = ["update_prices"];

class MemorySink implements AuditSink {
  events: AuditEvent[] = [];

  record(event: AuditEvent): undefined {
    this.events.push(event);
    return undefined;
  }
}

interface RollbackFixture {
  store: ToyStore;
  manager: PlanManager<PriceManifestItem, ToyProduct, void>;
  snapshotStore: SnapshotStore<ToyProduct>;
  audit: MemorySink;
  rollback: RollbackPlan<ToyProduct, void>;
  rollbackExecutor: ToyRollbackExecutor;
  /** Host-side executed-plan tracking: token → kind + refs that succeeded. */
  executed: Map<string, ExecutedPlan>;
}

function makeFixture(
  options: {
    forwardFailRefs?: readonly string[];
    rollbackFailRefs?: readonly string[];
    rollbackTtlMs?: number;
  } = {},
): RollbackFixture {
  const { forwardFailRefs = [], rollbackFailRefs = [], rollbackTtlMs = 60_000 } = options;
  const store = new ToyStore([
    { id: "a", title: "Alpha", price: 10, tags: [] },
    { id: "b", title: "Beta", price: 20, tags: [] },
    { id: "c", title: "Gamma", price: 30, tags: [] },
  ]);
  const planStore = new PlanStore<Manifest<PriceManifestItem>>({ planTtlMs: 60_000 });
  const snapshotStore = new SnapshotStore<ToyProduct>(rollbackTtlMs);
  const audit = new MemorySink();
  const manager = new PlanManager<PriceManifestItem, ToyProduct, void>({
    store: planStore,
    executor: new ToyPriceExecutor(store, forwardFailRefs),
    stateReader: new ToyPriceStateReader(store),
    snapshotStore,
    audit,
    callerId: "tester",
  });
  const executed = new Map<string, ExecutedPlan>();
  const rollbackExecutor = new ToyRollbackExecutor(store, rollbackFailRefs);
  const rollback = new RollbackPlan<ToyProduct, void>({
    snapshotStore,
    executedOf: (planToken) => executed.get(planToken) ?? null,
    supportedKinds: SUPPORTED_KINDS,
    executor: rollbackExecutor,
    audit,
    callerId: "tester",
  });
  return { store, manager, snapshotStore, audit, rollback, rollbackExecutor, executed };
}

/**
 * Runs a price-change plan end to end and records its executed plan the way
 * host wiring would: kind plus the refs that actually succeeded.
 */
async function previewAndExecute(
  fx: RollbackFixture,
  targets: readonly { id: string; newPrice: number }[],
): Promise<{ planToken: string; succeededRefs: readonly string[] }> {
  const preview = await fx.manager.preview(
    new ToyPriceManifestBuilder(fx.store, targets),
    { tool: TOOL, reason: "sale" },
  );
  const result = await fx.manager.executePlan(preview.planToken, preview.manifest);
  const succeededRefs = result.ledger.succeeded.map((o) => o.ref);
  fx.executed.set(preview.planToken, { kind: TOOL, executedRefs: succeededRefs });
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

interface RolledBackDetail {
  succeeded: number;
  failed: number;
  items: Array<{ ref: string; ok: boolean; code: string | null; message: string | null }>;
}

describe("RollbackPlan one-call rollback (ticket #12)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-applies snapshot before-values exactly, with no approval consulted", async () => {
    const fx = makeFixture();
    const { planToken } = await previewAndExecute(fx, [
      { id: "a", newPrice: 12 },
      { id: "b", newPrice: 22 },
    ]);
    expect(fx.store.get("a")!.price).toBe(12);
    expect(fx.store.get("b")!.price).toBe(22);
    // Two items is under the approval threshold; nothing was ever approved.
    expect(fx.audit.events.filter((e) => e.status === "approved")).toHaveLength(0);

    const result = await fx.rollback.rollback(planToken);

    expect(result.status).toBe("rolled_back");
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.refs).toEqual(["a", "b"]);
    // Exact-value restoration: the full snapshot, not just the price.
    expect(fx.store.get("a")).toEqual({ id: "a", title: "Alpha", price: 10, tags: [] });
    expect(fx.store.get("b")).toEqual({ id: "b", title: "Beta", price: 20, tags: [] });
    expect(fx.audit.events.filter((e) => e.status === "approved")).toHaveLength(0);

    const rolledBack = fx.audit.events.find((e) => e.status === "rolled_back");
    expect(rolledBack).toBeDefined();
    expect(rolledBack!.tool).toBe("rollback_plan");
    expect(rolledBack!.callerId).toBe("tester");
    expect(rolledBack!.planToken).toBe(planToken);
    expect(rolledBack!.previewCount).toBe(2);
    const detail = JSON.parse(rolledBack!.detail!) as RolledBackDetail;
    expect(detail.succeeded).toBe(2);
    expect(detail.failed).toBe(0);
    expect(detail.items.map((i) => i.ref)).toEqual(["a", "b"]);
    expect(detail.items.every((i) => i.ok)).toBe(true);
  });

  it("refuses cancel_order / refund_order plans with ROLLBACK_UNSUPPORTED and sends no inverse mutations", async () => {
    const fx = makeFixture();
    const { planToken } = await previewAndExecute(fx, [{ id: "a", newPrice: 12 }]);
    // The host tracked this token as an irreversible cancel_order plan.
    fx.executed.set(planToken, { kind: "cancel_order", executedRefs: ["a"] });
    const spy = vi.spyOn(fx.rollbackExecutor, "execute");

    const err = await errorOf(fx.rollback.rollback(planToken));

    expect(err).toBeInstanceOf(RollbackError);
    expect((err as RollbackError).code).toBe("ROLLBACK_UNSUPPORTED");
    expect(spy).not.toHaveBeenCalled();
    expect(fx.store.get("a")!.price).toBe(12);

    const refused = fx.audit.events.find((e) => e.status === "refused");
    expect(refused).toBeDefined();
    expect(refused!.planToken).toBe(planToken);
    expect(refused!.detail).toContain("ROLLBACK_UNSUPPORTED");
  });

  it("refuses a token with no executed-plan record (never executed)", async () => {
    const fx = makeFixture();
    const preview = await fx.manager.preview(
      new ToyPriceManifestBuilder(fx.store, [{ id: "a", newPrice: 12 }]),
      { tool: TOOL },
    );
    // Snapshot captured at preview, but the plan was never executed: no record.
    expect(fx.snapshotStore.has(preview.planToken)).toBe(true);

    const err = await errorOf(fx.rollback.rollback(preview.planToken));

    expect(err).toBeInstanceOf(RollbackError);
    expect((err as RollbackError).code).toBe("ROLLBACK_UNSUPPORTED");
    expect(fx.store.get("a")!.price).toBe(10);
  });

  it("refuses with ROLLBACK_WINDOW_EXPIRED once the rollbackTtlMs window has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fx = makeFixture({ rollbackTtlMs: 60_000 });
    const { planToken } = await previewAndExecute(fx, [{ id: "a", newPrice: 12 }]);
    expect(fx.store.get("a")!.price).toBe(12);

    vi.setSystemTime(1_000 + 60_000 + 1);
    const err = await errorOf(fx.rollback.rollback(planToken));

    expect(err).toBeInstanceOf(RollbackError);
    expect((err as RollbackError).code).toBe("ROLLBACK_WINDOW_EXPIRED");
    expect(fx.store.get("a")!.price).toBe(12);

    const refused = fx.audit.events.find((e) => e.status === "refused");
    expect(refused).toBeDefined();
    expect(refused!.planToken).toBe(planToken);
    expect(refused!.detail).toContain("ROLLBACK_WINDOW_EXPIRED");
  });

  it("rolls back only the refs that actually succeeded at execute, never the failed ones", async () => {
    const fx = makeFixture({ forwardFailRefs: ["b"] });
    const { planToken, succeededRefs } = await previewAndExecute(fx, [
      { id: "a", newPrice: 12 },
      { id: "b", newPrice: 22 },
      { id: "c", newPrice: 32 },
    ]);
    expect(succeededRefs).toEqual(["a", "c"]);
    expect(fx.store.get("a")!.price).toBe(12);
    expect(fx.store.get("b")!.price).toBe(20);
    expect(fx.store.get("c")!.price).toBe(32);

    const result = await fx.rollback.rollback(planToken);

    expect(result.status).toBe("rolled_back");
    expect(result.itemCount).toBe(2);
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.refs).toEqual(["a", "c"]);
    expect(fx.store.get("a")!.price).toBe(10);
    expect(fx.store.get("b")!.price).toBe(20);
    expect(fx.store.get("c")!.price).toBe(30);
  });

  it("records a partial rollback failure in the per-item ledger and audit, never hidden", async () => {
    const fx = makeFixture({ rollbackFailRefs: ["b"] });
    const { planToken } = await previewAndExecute(fx, [
      { id: "a", newPrice: 12 },
      { id: "b", newPrice: 22 },
      { id: "c", newPrice: 32 },
    ]);

    const result = await fx.rollback.rollback(planToken);

    expect(result.status).toBe("rolled_back");
    expect(result.succeededCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.ledger.attempted.map((o) => o.ref)).toEqual(["a", "b", "c"]);
    expect(result.ledger.succeeded.map((o) => o.ref)).toEqual(["a", "c"]);
    expect(result.ledger.failed.map((o) => o.ref)).toEqual(["b"]);
    expect(result.ledger.failed[0]!.error!.code).toBe("SIMULATED_FAILURE");
    expect(fx.store.get("a")!.price).toBe(10);
    expect(fx.store.get("b")!.price).toBe(22);
    expect(fx.store.get("c")!.price).toBe(30);

    const rolledBack = fx.audit.events.find((e) => e.status === "rolled_back");
    const detail = JSON.parse(rolledBack!.detail!) as RolledBackDetail;
    expect(detail.succeeded).toBe(2);
    expect(detail.failed).toBe(1);
    expect(detail.items.find((i) => i.ref === "b")).toMatchObject({
      ok: false,
      code: "SIMULATED_FAILURE",
    });
  });

  it("fails closed when no supported kinds are declared", async () => {
    const fx = makeFixture();
    const { planToken } = await previewAndExecute(fx, [{ id: "a", newPrice: 12 }]);
    const rollback = new RollbackPlan<ToyProduct, void>({
      snapshotStore: fx.snapshotStore,
      executedOf: (t) => fx.executed.get(t) ?? null,
      executor: fx.rollbackExecutor,
      audit: fx.audit,
    });

    const err = await errorOf(rollback.rollback(planToken));

    expect(err).toBeInstanceOf(RollbackError);
    expect((err as RollbackError).code).toBe("ROLLBACK_UNSUPPORTED");
  });
});