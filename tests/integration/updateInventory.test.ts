/**
 * Live integration suite: update_inventory two-phase flow against the real
 * Admin API — preview a +1 quantity change on one real seeded inventory item
 * at a real location, execute it, verify the level moved, then roll it back
 * through RollbackPlan and verify the original quantity is restored. Leaves
 * the seeded stock exactly as found.
 *
 * Env-gated: skipped entirely unless both SHOPIFY_STORE_DOMAIN and
 * SHOPIFY_ADMIN_TOKEN are set, so `npm test` and `npm run test:integration`
 * pass as a no-op without credentials.
 *
 * The target inventory item + location are discovered at runtime via
 * search_products (the seeder stocks every variant at both locations).
 */
import { PlanStore } from "safe-write-mcp-core";
import { beforeAll, describe, expect, it } from "vitest";
import type { Executor, ItemOutcome } from "../../src/plans/executor.js";
import type { Manifest } from "../../src/plans/manifest.js";
import { PlanManager } from "../../src/plans/planManager.js";
import { SnapshotStore } from "../../src/plans/snapshotStore.js";
import {
  RollbackPlan,
  type ExecutedPlan,
  type RollbackTarget,
} from "../../src/tools/rollbackPlan.js";
import { searchProducts } from "../../src/tools/searchProducts.js";
import {
  InventoryExecutor,
  InventoryManifestBuilder,
  InventoryStateReader,
  type InventoryLevelSnapshot,
  type InventoryManifestItem,
} from "../../src/tools/updateInventory.js";
import {
  buildFixture,
  integrationEnabled,
  MemorySink,
  type IntegrationFixture,
} from "./helpers.js";

const enabled = integrationEnabled();
if (!enabled) {
  console.warn(
    "[integration:updateInventory] SKIPPED — set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN and run `npm run seed` first.",
  );
}
const describeSuite = enabled ? describe : describe.skip;

/**
 * Adapts a RollbackPlan snapshot (an InventoryLevelSnapshot) into the item
 * shape InventoryExecutor expects, so one real mutation path serves both
 * execute and rollback.
 */
class InventoryRollbackExecutor
  implements Executor<RollbackTarget<InventoryLevelSnapshot>, void>
{
  constructor(
    private readonly inner: InventoryExecutor,
    private readonly locationId: string,
  ) {}

  execute(item: RollbackTarget<InventoryLevelSnapshot>): Promise<ItemOutcome<void>> {
    const inventoryItem: InventoryManifestItem = {
      ref: item.ref,
      before: item.before,
      after: item.before,
      payload: {
        inventoryItemId: item.before.inventoryItemId,
        quantity: item.before.available,
      },
    };
    return this.inner.execute(inventoryItem);
  }
}

describeSuite("integration: update_inventory two-phase + rollback", () => {
  let fx: IntegrationFixture;

  beforeAll(() => {
    fx = buildFixture();
  });

  it("previews, executes a real quantity change, and rolls it back exactly", async () => {
    const seeded = await searchProducts(fx.client, { title: "Seeded Product 1" }, fx.config);
    const variant = seeded.products[0]!.variants[0]!;
    const inventoryItemId = variant.inventoryItemId;
    const locationId = variant.inventoryLevels[0]!.locationId;
    const originalAvailable = variant.inventoryLevels[0]!.available;

    const planStore = new PlanStore<Manifest<InventoryManifestItem>>({ planTtlMs: 60_000 });
    const snapshotStore = new SnapshotStore<InventoryLevelSnapshot>(60_000);
    const audit = new MemorySink();
    const executed = new Map<string, ExecutedPlan>();

    const builder = new InventoryManifestBuilder(
      fx.client,
      { locationId, adjustments: [{ inventoryItemId, quantity: originalAvailable + 1 }] },
      fx.config,
    );
    const manifest = await builder.build();
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]!.before.available).toBe(originalAvailable);
    expect(manifest.items[0]!.after.available).toBe(originalAvailable + 1);

    const manager = new PlanManager<InventoryManifestItem, InventoryLevelSnapshot, void>({
      store: planStore,
      executor: new InventoryExecutor(fx.client, locationId),
      stateReader: new InventoryStateReader(fx.client, locationId),
      snapshotStore,
      audit,
      callerId: "integration-tests",
    });

    const preview = await manager.preview(
      { build: () => Promise.resolve(manifest) },
      {
        tool: "update_inventory",
        reason: "live integration suite: temporary quantity change",
      },
    );
    expect(preview.status).toBe("previewed");

    const executedResult = await manager.executePlan(preview.planToken, preview.manifest);
    expect(executedResult.status).toBe("executed");
    expect(executedResult.succeededCount).toBe(1);
    expect(executedResult.failedCount).toBe(0);

    const current = await new InventoryStateReader(fx.client, locationId).readCurrent([
      inventoryItemId,
    ]);
    expect(current[inventoryItemId]!.available).toBe(originalAvailable + 1);

    executed.set(preview.planToken, {
      kind: "update_inventory",
      executedRefs: executedResult.refs,
    });

    const rollback = new RollbackPlan<InventoryLevelSnapshot, void>({
      snapshotStore,
      executedOf: (token) => executed.get(token) ?? null,
      supportedKinds: ["update_inventory"],
      executor: new InventoryRollbackExecutor(
        new InventoryExecutor(fx.client, locationId),
        locationId,
      ),
      audit,
      callerId: "integration-tests",
    });
    const rollbackResult = await rollback.rollback(preview.planToken);
    expect(rollbackResult.status).toBe("rolled_back");
    expect(rollbackResult.succeededCount).toBe(1);
    expect(rollbackResult.failedCount).toBe(0);

    const restored = await new InventoryStateReader(fx.client, locationId).readCurrent([
      inventoryItemId,
    ]);
    expect(restored[inventoryItemId]!.available).toBe(originalAvailable);
  });
});