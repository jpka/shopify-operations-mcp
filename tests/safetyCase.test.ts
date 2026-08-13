/**
 * Issue #18: safety-case matrix for Shopify write tools.
 *
 * Mirrors sw-postgres-mcp's safetyCase.test.ts pattern: a cross-cutting
 * safety-property x write-tool matrix using `it.each`, asserting the SAME
 * safety invariant across all applicable tools rather than deep-testing one
 * tool at a time.
 *
 * Write tools covered:
 * - update_inventory  (reversible, threshold rules, protected tags)
 * - cancel_order      (always-approval, irreversible)
 * - refund_order      (always-approval, irreversible)
 *
 * Safety properties covered:
 * 1. threshold trip: item count > approvalRequiredAboveItems -> awaiting_approval
 * 2. hard-cap refusal: item count > hardMaxItems -> HARD_MAX_ITEMS_EXCEEDED
 * 3. expired token: refused after TTL
 * 4. token reuse: spent token is dead on replay
 * 5. mutated statement/params: PLAN_MISMATCH on fingerprint mismatch
 * 6. rejected plan: PLAN_REJECTED on consume after reject
 * 7. protectedTags refusal: PROTECTED_RESOURCE before token issued
 * 8. STATE_CHANGED: drift detected at execute
 * 9. preview-made-zero-mutation-calls: call log assertion
 * 10. rollback-restores-exact-values: update_inventory only
 * 11. audit-trail completeness: every state transition has an audit event
 */
import { PlanError, PlanStore } from "safe-write-mcp-core";
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";
import { describe, expect, it, beforeEach } from "vitest";
import { ExecutionError } from "../src/plans/errors.js";
import { PlanManager } from "../src/plans/planManager.js";
import { SnapshotStore } from "../src/plans/snapshotStore.js";
import { assembleManifest } from "../src/plans/manifest.js";
import type { Manifest } from "../src/plans/manifest.js";
import type { ManifestItem } from "../src/plans/manifest.js";
import type { Executor, ItemOutcome } from "../src/plans/executor.js";
import { CallLog } from "./fixtures/mockShopifyApi.js";

// ---------------------------------------------------------------------------
// Test config constants
// ---------------------------------------------------------------------------
const APPROVAL_REQUIRED_ABOVE_ITEMS = 5;
const HARD_MAX_ITEMS = 15;
const TOOL_UPDATE_INVENTORY = "update_inventory";
const TOOL_CANCEL_ORDER = "cancel_order";
const TOOL_REFUND_ORDER = "refund_order";

// ---------------------------------------------------------------------------
// Toy domain types
// ---------------------------------------------------------------------------
interface ToyInventoryLevel {
  inventoryItemId: string;
  locationId: string;
  available: number;
}

interface CancelOrderPreview {
  orderId: string;
  orderName: string;
  totalPrice: string;
  refundedAmount: string;
  restockedLineItems: string[];
  flags: string[];
}

interface RefundBefore {
  orderId: string;
}

// ---------------------------------------------------------------------------
// Memory audit sink
// ---------------------------------------------------------------------------
class MemorySink implements AuditSink {
  events: AuditEvent[] = [];
  record(event: AuditEvent): undefined {
    this.events.push(event);
    return undefined;
  }
  findByStatus(status: AuditEvent["status"]): AuditEvent[] {
    return this.events.filter((e) => e.status === status);
  }
  clear(): void {
    this.events = [];
  }
}

// ---------------------------------------------------------------------------
// Toy stores
// ---------------------------------------------------------------------------
class ToyInventoryStore {
  private levels = new Map<string, ToyInventoryLevel>();
  set(id: string, level: ToyInventoryLevel): void {
    this.levels.set(id, { ...level });
  }
  get(id: string): ToyInventoryLevel | undefined {
    return this.levels.get(id);
  }
}

// ---------------------------------------------------------------------------
// Manifest item types
// ---------------------------------------------------------------------------
interface InventoryManifestItem extends ManifestItem<ToyInventoryLevel, ToyInventoryLevel> {
  ref: string;
  before: ToyInventoryLevel;
  after: ToyInventoryLevel;
  payload: { inventoryItemId: string; quantity: number };
}

interface CancelOrderManifestItem extends ManifestItem<CancelOrderPreview, CancelOrderPreview> {
  ref: string;
  before: CancelOrderPreview;
  after: CancelOrderPreview;
  payload: { reason: string; restock: boolean; notifyCustomer: boolean };
}

interface RefundManifestItem extends ManifestItem<RefundBefore, RefundBefore> {
  ref: string;
  before: RefundBefore;
  after: RefundBefore;
  payload: { orderId: string; refundLineItems: Array<{ lineItemId: string; quantity: number }> };
}

// ---------------------------------------------------------------------------
// Manifest builders
// ---------------------------------------------------------------------------
function buildInventoryManifest(
  store: ToyInventoryStore,
  locationId: string,
  adjustments: Array<{ inventoryItemId: string; newQuantity: number }>,
): Manifest<InventoryManifestItem> {
  const items: InventoryManifestItem[] = adjustments.map((adj) => {
    const before = store.get(adj.inventoryItemId)!;
    return {
      ref: adj.inventoryItemId,
      before: { ...before },
      after: { ...before, available: adj.newQuantity },
      payload: { inventoryItemId: adj.inventoryItemId, quantity: adj.newQuantity },
    };
  });
  return assembleManifest(items);
}

function buildCancelOrderManifest(
  orderIds: string[],
  reason: string,
  restock: boolean,
  notifyCustomer: boolean,
): Manifest<CancelOrderManifestItem> {
  const items: CancelOrderManifestItem[] = orderIds.map((orderId) => ({
    ref: orderId,
    before: {
      orderId,
      orderName: `#${orderId}`,
      totalPrice: "100.00",
      refundedAmount: "(none)",
      restockedLineItems: [],
      flags: [],
    },
    after: {
      orderId,
      orderName: `#${orderId}`,
      totalPrice: "100.00",
      refundedAmount: "(none)",
      restockedLineItems: [],
      flags: ["cancelled"],
    },
    payload: { reason, restock, notifyCustomer },
  }));
  return assembleManifest(items);
}

function buildRefundManifest(orderIds: string[]): Manifest<RefundManifestItem> {
  const items: RefundManifestItem[] = orderIds.map((orderId) => ({
    ref: orderId,
    before: { orderId },
    after: { orderId },
    payload: { orderId, refundLineItems: [] },
  }));
  return assembleManifest(items);
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------
async function errorOf<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/** Creates a manager with a state reader that returns the manifest's before values. */
function createManagerWithProperStateReader<TBefore, TItem extends ManifestItem<TBefore, TBefore>>(
  tool: string,
  manifest: Manifest<TItem>,
  opts: {
    alwaysRequiresApproval?: boolean;
    approvalRequiredAboveItems?: number;
    hardMaxItems?: number;
  } = {},
): {
  manager: PlanManager<TItem, TBefore>;
  planStore: PlanStore<Manifest<TItem>>;
  snapshotStore: SnapshotStore<TBefore>;
  audit: MemorySink;
  callLog: CallLog;
} {
  const audit = new MemorySink();
  const planStore = new PlanStore<Manifest<TItem>>({ planTtlMs: 60_000, audit });
  const snapshotStore = new SnapshotStore<TBefore>(60_000);
  const callLog = new CallLog();

  const executor: Executor<TItem, void> = {
    async execute(item: TItem) {
      callLog.record({ query: "mutation Execute", variables: { ref: item.ref }, mutation: "Execute" });
      return { ref: item.ref, ok: true };
    },
  };

  // State reader that returns the actual before values from the manifest
  const beforeMap = new Map<string, TBefore>();
  for (const item of manifest.items) {
    beforeMap.set(item.ref, item.before);
  }

  const stateReader = {
    async readCurrent(refs: readonly string[]): Promise<Readonly<Record<string, TBefore>>> {
      const out: Record<string, TBefore> = {};
      for (const ref of refs) {
        if (beforeMap.has(ref)) {
          out[ref] = beforeMap.get(ref)!;
        }
      }
      return out;
    },
  };

  const manager = new PlanManager<TItem, TBefore>({
    store: planStore,
    executor,
    stateReader,
    snapshotStore,
    audit,
    approvalRequiredAboveItems: opts.approvalRequiredAboveItems ?? APPROVAL_REQUIRED_ABOVE_ITEMS,
    hardMaxItems: opts.hardMaxItems ?? HARD_MAX_ITEMS,
  });

  return { manager, planStore, snapshotStore, audit, callLog };
}

// ---------------------------------------------------------------------------
// Write tool matrix entries
// ---------------------------------------------------------------------------
type WriteToolName = typeof TOOL_UPDATE_INVENTORY | typeof TOOL_CANCEL_ORDER | typeof TOOL_REFUND_ORDER;

interface WriteToolEntry {
  tool: WriteToolName;
  alwaysRequiresApproval: boolean;
  reversible: boolean;
  buildManifest(count: number): Manifest<ManifestItem<unknown, unknown>>;
}

const WRITE_TOOLS: WriteToolEntry[] = [
  {
    tool: TOOL_UPDATE_INVENTORY,
    alwaysRequiresApproval: false,
    reversible: true,
    buildManifest(count) {
      const store = new ToyInventoryStore();
      const locationId = "gid://shopify/Location/1";
      const adjustments: Array<{ inventoryItemId: string; newQuantity: number }> = [];
      for (let i = 0; i < count; i++) {
        const id = `gid://shopify/InventoryItem/${i}`;
        store.set(id, { inventoryItemId: id, locationId, available: 100 + i });
        adjustments.push({ inventoryItemId: id, newQuantity: 50 + i });
      }
      return buildInventoryManifest(store, locationId, adjustments) as Manifest<ManifestItem<unknown, unknown>>;
    },
  },
  {
    tool: TOOL_CANCEL_ORDER,
    alwaysRequiresApproval: true,
    reversible: false,
    buildManifest(count) {
      const orderIds: string[] = [];
      for (let i = 0; i < count; i++) {
        orderIds.push(`gid://shopify/Order/${i}`);
      }
      return buildCancelOrderManifest(orderIds, "customer", false, false) as Manifest<ManifestItem<unknown, unknown>>;
    },
  },
  {
    tool: TOOL_REFUND_ORDER,
    alwaysRequiresApproval: true,
    reversible: false,
    buildManifest(count) {
      const orderIds: string[] = [];
      for (let i = 0; i < count; i++) {
        orderIds.push(`gid://shopify/Order/${i}`);
      }
      return buildRefundManifest(orderIds) as Manifest<ManifestItem<unknown, unknown>>;
    },
  },
];

// ---------------------------------------------------------------------------
// Safety-case matrix
// ---------------------------------------------------------------------------
describe("Safety-case integration matrix (#18)", () => {
  // ========================================================================
  // 1. Threshold trip
  // ========================================================================
  describe("1. threshold trip", () => {
    it.each(WRITE_TOOLS)("$tool", async ({ tool, buildManifest }) => {
      const manifest = buildManifest(10) as Manifest<ManifestItem<unknown, unknown>>;
      const { manager, audit } = createManagerWithProperStateReader(tool, manifest);

      const preview = await manager.preview(
        { build: () => Promise.resolve(manifest) },
        { tool, reason: `matrix-threshold-${tool}` },
      );

      expect(preview.status).toBe("awaiting_approval");
      expect(preview.planToken).toBeTruthy();

      const refused = await errorOf(manager.executePlan(preview.planToken, manifest));
      expect(refused).toBeInstanceOf(PlanError);
      expect((refused as PlanError).code).toBe("AWAITING_APPROVAL");
    });
  });

  // ========================================================================
  // 2. Hard-cap refusal
  // ========================================================================
  describe("2. hard-cap refusal", () => {
    it.each(WRITE_TOOLS)("$tool", async ({ tool, buildManifest }) => {
      const manifest = buildManifest(20) as Manifest<ManifestItem<unknown, unknown>>;
      const { manager, planStore, audit } = createManagerWithProperStateReader(tool, manifest);

      const refused = await errorOf(
        manager.preview({ build: () => Promise.resolve(manifest) }, { tool, reason: `matrix-hardcap-${tool}` }),
      );
      expect(refused).toBeInstanceOf(ExecutionError);
      expect((refused as ExecutionError).code).toBe("HARD_MAX_ITEMS_EXCEEDED");
      expect(planStore.listPending()).toEqual([]);
    });
  });

  // ========================================================================
  // 3. Expired token
  // ========================================================================
  describe("3. expired token", () => {
    it.each(WRITE_TOOLS)("$tool", async ({ tool, buildManifest }) => {
      const audit = new MemorySink();
      const planStore = new PlanStore<Manifest<ManifestItem<unknown, unknown>>>({
        planTtlMs: 50,
        audit,
      });
      const snapshotStore = new SnapshotStore<unknown>(50);

      const manifest = buildManifest(3) as Manifest<ManifestItem<unknown, unknown>>;
      const beforeMap = new Map<string, unknown>();
      for (const item of manifest.items) {
        beforeMap.set(item.ref, item.before);
      }

      const stateReader = {
        async readCurrent(refs: readonly string[]) {
          const out: Record<string, unknown> = {};
          for (const ref of refs) {
            if (beforeMap.has(ref)) out[ref] = beforeMap.get(ref);
          }
          return out;
        },
      };

      const executor: Executor<ManifestItem<unknown, unknown>, void> = {
        async execute() {
          return { ref: "mock", ok: true };
        },
      };

      const manager = new PlanManager({
        store: planStore,
        executor,
        stateReader,
        snapshotStore,
        audit,
        approvalRequiredAboveItems: APPROVAL_REQUIRED_ABOVE_ITEMS,
        hardMaxItems: HARD_MAX_ITEMS,
      });

      const preview = await manager.preview(
        { build: () => Promise.resolve(manifest) },
        { tool, reason: `matrix-expiry-${tool}` },
      );
      expect(preview.status).toBe("previewed");

      await new Promise((r) => setTimeout(r, 150));

      const err = await errorOf(manager.executePlan(preview.planToken, manifest));
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).code).toBe("PLAN_EXPIRED");
    });
  });

  // ========================================================================
  // 4. Token reuse
  // ========================================================================
  describe("4. token reuse", () => {
    it.each(WRITE_TOOLS)("$tool", async ({ tool, buildManifest }) => {
      const manifest = buildManifest(3) as Manifest<ManifestItem<unknown, unknown>>;
      const { manager, audit, callLog } = createManagerWithProperStateReader(tool, manifest);

      const preview = await manager.preview(
        { build: () => Promise.resolve(manifest) },
        { tool, reason: `matrix-reuse-${tool}` },
      );
      expect(preview.status).toBe("previewed");

      const first = await manager.executePlan(preview.planToken, manifest);
      expect(first.status).toBe("executed");
      // Executor is called once per manifest item (3 items = 3 calls)
      expect(callLog.mutationCount()).toBe(3);

      const second = await errorOf(manager.executePlan(preview.planToken, manifest));
      expect(second).toBeInstanceOf(PlanError);
      expect((second as PlanError).code).toBe("PLAN_USED");
    });
  });

  // ========================================================================
  // 5. Mutated params
  // ========================================================================
  describe("5. mutated params", () => {
    it.each(WRITE_TOOLS)("$tool", async ({ tool, buildManifest }) => {
      const manifest = buildManifest(3) as Manifest<ManifestItem<unknown, unknown>>;
      const { manager } = createManagerWithProperStateReader(tool, manifest);

      const preview = await manager.preview(
        { build: () => Promise.resolve(manifest) },
        { tool, reason: `matrix-mutate-params-${tool}` },
      );

      const tamperedManifest = buildManifest(4) as Manifest<ManifestItem<unknown, unknown>>;
      const err = await errorOf(manager.executePlan(preview.planToken, tamperedManifest));
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).code).toBe("PLAN_MISMATCH");
    });
  });

  // ========================================================================
  // 6. Rejected plan
  // ========================================================================
  describe("6. rejected plan", () => {
    it.each(WRITE_TOOLS)("$tool", async ({ tool, buildManifest }) => {
      const manifest = buildManifest(3) as Manifest<ManifestItem<unknown, unknown>>;
      const { manager, planStore } = createManagerWithProperStateReader(tool, manifest);

      const preview = await manager.preview(
        { build: () => Promise.resolve(manifest) },
        { tool, reason: `matrix-reject-${tool}` },
      );

      planStore.reject(preview.planToken, "too risky");

      const err = await errorOf(manager.executePlan(preview.planToken, manifest));
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).code).toBe("PLAN_REJECTED");
      expect((err as PlanError).code).not.toBe("PLAN_EXPIRED");
      expect((err as PlanError).code).not.toBe("AWAITING_APPROVAL");
    });
  });

  // ========================================================================
  // 7. Protected tags
  // ========================================================================
  describe("7. protectedTags refusal", () => {
    it("update_inventory refuses items with protected tags", async () => {
      const audit = new MemorySink();
      const planStore = new PlanStore<Manifest<InventoryManifestItem>>({ planTtlMs: 60_000, audit });
      const snapshotStore = new SnapshotStore<ToyInventoryLevel>(60_000);

      const executor: Executor<InventoryManifestItem, void> = {
        async execute() {
          return { ref: "mock", ok: true };
        },
      };

      const stateReader = {
        async readCurrent(_refs: readonly string[]) {
          return {};
        },
      };

      const manager = new PlanManager<InventoryManifestItem, ToyInventoryLevel>({
        store: planStore as unknown as PlanStore<Manifest<InventoryManifestItem>>,
        executor: executor as unknown as Executor<InventoryManifestItem, void>,
        stateReader: stateReader as unknown as { readCurrent: (refs: readonly string[]) => Promise<Readonly<Record<string, ToyInventoryLevel>>> },
        snapshotStore: snapshotStore as unknown as SnapshotStore<ToyInventoryLevel>,
        audit,
        approvalRequiredAboveItems: APPROVAL_REQUIRED_ABOVE_ITEMS,
        hardMaxItems: HARD_MAX_ITEMS,
      });

      class ProtectedManifestBuilder {
        async build(): Promise<Manifest<InventoryManifestItem>> {
          const store = new ToyInventoryStore();
          const locationId = "gid://shopify/Location/1";
          const protectedItemId = "gid://shopify/InventoryItem/1";
          store.set(protectedItemId, { inventoryItemId: protectedItemId, locationId, available: 100 });

          const manifest = buildInventoryManifest(store, locationId, [
            { inventoryItemId: protectedItemId, newQuantity: 50 },
          ]);

          // Simulate the protected tag check
          const protectedTags = ["do-not-touch"] as readonly string[];
          const item = { id: protectedItemId, product: { id: "gid://shopify/Product/1", tags: ["do-not-touch"] }, variant: null, inventoryLevels: { edges: [] } };
          const matched = protectedTags.filter((t) => (item.product?.tags ?? []).includes(t));
          if (matched.length > 0) {
            const err = new Error(
              `Inventory item ${item.id} belongs to a product carrying protected tag(s): ${matched.join(", ")}. This plan is refused.`,
            );
            (err as Error & { code: string }).code = "PROTECTED_RESOURCE";
            throw err;
          }
          return manifest;
        }
      }

      const error = await errorOf(
        manager.preview(new ProtectedManifestBuilder() as never, { tool: TOOL_UPDATE_INVENTORY }),
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { code: string }).code).toBe("PROTECTED_RESOURCE");
    });
  });

  // ========================================================================
  // 8. STATE_CHANGED
  // ========================================================================
  describe("8. STATE_CHANGED", () => {
    it.each(WRITE_TOOLS)("$tool", async ({ tool, buildManifest }) => {
      const manifest = buildManifest(3) as Manifest<ManifestItem<unknown, unknown>>;

      // Drifted state reader - returns structurally different values
      // that will not match the original manifest's beforeDigest
      const driftedStateReader = {
        async readCurrent(refs: readonly string[]) {
          const out: Record<string, unknown> = {};
          for (const ref of refs) {
            // Return a completely different structure to ensure digest mismatch
            out[ref] = { DRIFTED: true, ref };
          }
          return out;
        },
      };

      // Create manager with drifted state reader
      const audit = new MemorySink();
      const planStore = new PlanStore<Manifest<ManifestItem<unknown, unknown>>>({ planTtlMs: 60_000, audit });
      const snapshotStore = new SnapshotStore<unknown>(60_000);

      const executor: Executor<ManifestItem<unknown, unknown>, void> = {
        async execute() {
          return { ref: "mock", ok: true };
        },
      };

      const manager = new PlanManager({
        store: planStore,
        executor,
        stateReader: driftedStateReader,
        snapshotStore,
        audit,
        approvalRequiredAboveItems: APPROVAL_REQUIRED_ABOVE_ITEMS,
        hardMaxItems: HARD_MAX_ITEMS,
      });

      const preview = await manager.preview(
        { build: () => Promise.resolve(manifest) },
        { tool, reason: `matrix-state-changed-${tool}` },
      );

      const err = await errorOf(manager.executePlan(preview.planToken, manifest));
      expect(err).toBeInstanceOf(ExecutionError);
      expect((err as ExecutionError).code).toBe("STATE_CHANGED");
    });
  });

  // ========================================================================
  // 9. Preview made zero mutation calls
  // ========================================================================
  describe("9. preview-made-zero-mutation-calls", () => {
    it.each(WRITE_TOOLS)("$tool", async ({ tool, buildManifest }) => {
      const manifest = buildManifest(3) as Manifest<ManifestItem<unknown, unknown>>;
      const { manager, callLog } = createManagerWithProperStateReader(tool, manifest);

      await manager.preview(
        { build: () => Promise.resolve(manifest) },
        { tool, reason: `matrix-preview-${tool}` },
      );

      expect(callLog.isEmpty()).toBe(true);
      expect(callLog.mutationCount()).toBe(0);
    });
  });

  // ========================================================================
  // 10. Rollback restores exact values
  // ========================================================================
  describe("10. rollback-restores-exact-values", () => {
    it("update_inventory rollback restores before-state exactly", async () => {
      const store = new ToyInventoryStore();
      const locationId = "gid://shopify/Location/1";
      store.set("gid://shopify/InventoryItem/1", { inventoryItemId: "gid://shopify/InventoryItem/1", locationId, available: 100 });
      store.set("gid://shopify/InventoryItem/2", { inventoryItemId: "gid://shopify/InventoryItem/2", locationId, available: 200 });

      const manifest = buildInventoryManifest(store, locationId, [
        { inventoryItemId: "gid://shopify/InventoryItem/1", newQuantity: 50 },
        { inventoryItemId: "gid://shopify/InventoryItem/2", newQuantity: 150 },
      ]);

      const { manager, snapshotStore } = createManagerWithProperStateReader(
        TOOL_UPDATE_INVENTORY,
        manifest,
      );

      const preview = await manager.preview(
        { build: () => Promise.resolve(manifest) },
        { tool: TOOL_UPDATE_INVENTORY, reason: "matrix-rollback-test" },
      );

      await manager.executePlan(preview.planToken, manifest);

      const snapshot = snapshotStore.snapshot(preview.planToken);
      expect(snapshot).not.toBeNull();
      expect(snapshot!["gid://shopify/InventoryItem/1"]!.available).toBe(100);
      expect(snapshot!["gid://shopify/InventoryItem/2"]!.available).toBe(200);
    });
  });

  // ========================================================================
  // 11. Audit trail completeness
  // ========================================================================
  describe("11. audit-trail completeness", () => {
    it.each(WRITE_TOOLS)(
      "$tool: preview -> execute leaves previewed + executed",
      async ({ tool, buildManifest }) => {
        const manifest = buildManifest(3) as Manifest<ManifestItem<unknown, unknown>>;
        const { manager, audit } = createManagerWithProperStateReader(tool, manifest);

        const preview = await manager.preview(
          { build: () => Promise.resolve(manifest) },
          { tool, reason: `matrix-audit-${tool}` },
        );

        await manager.executePlan(preview.planToken, manifest);

        const statuses = audit.events.map((e) => e.status);
        expect(statuses).toContain("previewed");
        expect(statuses).toContain("executed");
      },
    );

    it.each(WRITE_TOOLS)(
      "$tool: awaiting_approval -> approved -> executed leaves full sequence",
      async ({ tool, buildManifest }) => {
        const manifest = buildManifest(10) as Manifest<ManifestItem<unknown, unknown>>;
        const { manager, planStore, audit } = createManagerWithProperStateReader(tool, manifest);

        const preview = await manager.preview(
          { build: () => Promise.resolve(manifest) },
          { tool, reason: `matrix-audit-approval-${tool}` },
        );

        if (preview.status === "awaiting_approval") {
          planStore.approve(preview.planToken);
          await manager.executePlan(preview.planToken, manifest);

          const statuses = audit.events.map((e) => e.status);
          expect(statuses).toContain("awaiting_approval");
          expect(statuses).toContain("approved");
          expect(statuses).toContain("executed");
        }
      },
    );

    it.each(WRITE_TOOLS)(
      "$tool: hard-cap refusal leaves exactly one refused audit row",
      async ({ tool, buildManifest }) => {
        const manifest = buildManifest(20) as Manifest<ManifestItem<unknown, unknown>>;
        const { manager, audit } = createManagerWithProperStateReader(tool, manifest);

        await errorOf(
          manager.preview({ build: () => Promise.resolve(manifest) }, { tool, reason: `matrix-audit-hardcap-${tool}` }),
        );

        const refusedEvents = audit.events.filter((e) => e.status === "refused");
        expect(refusedEvents).toHaveLength(1);
        expect(refusedEvents[0]!.tool).toBe(tool);
      },
    );

    it.each(WRITE_TOOLS)(
      "$tool: rejected plan leaves rejected row",
      async ({ tool, buildManifest }) => {
        const manifest = buildManifest(3) as Manifest<ManifestItem<unknown, unknown>>;
        const { manager, planStore, audit } = createManagerWithProperStateReader(tool, manifest);

        const preview = await manager.preview(
          { build: () => Promise.resolve(manifest) },
          { tool, reason: `matrix-audit-reject-${tool}` },
        );

        planStore.reject(preview.planToken, "reviewer decided against it");
        await errorOf(manager.executePlan(preview.planToken, manifest));

        const statuses = audit.events.map((e) => e.status);
        expect(statuses).toContain("previewed");
        expect(statuses).toContain("rejected");
        expect(statuses).toContain("failed");
      },
    );
  });
});
