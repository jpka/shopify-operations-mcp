/**
 * Live integration suite: update_prices two-phase flow against the real Admin
 * API — preview, execute a small price change on real seeded variants, verify
 * the change landed, then roll it back through RollbackPlan and verify the
 * original price is restored. Proves the plan/preview/execute/rollback layers
 * against the live store while leaving the seeded data exactly as found.
 *
 * Env-gated: skipped entirely unless both SHOPIFY_STORE_DOMAIN and
 * SHOPIFY_ADMIN_TOKEN are set, so `npm test` and `npm run test:integration`
 * pass as a no-op without credentials.
 *
 * The target variants are discovered at runtime via search_products, so the
 * test never hardcodes GIDs. The price change is +1.00 (a few percent of any
 * seeded $5–$300 price), far under maxPriceChangePct, so the plan never
 * requires approval. Rollback restores the exact before-price.
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
  PriceExecutor,
  PriceManifestBuilder,
  PriceStateReader,
  type PriceManifestItem,
  type PriceSnapshot,
} from "../../src/tools/updatePrices.js";
import {
  buildFixture,
  integrationEnabled,
  MemorySink,
  type IntegrationFixture,
} from "./helpers.js";

const enabled = integrationEnabled();
if (!enabled) {
  console.warn(
    "[integration:updatePrices] SKIPPED — set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN and run `npm run seed` first.",
  );
}
const describeSuite = enabled ? describe : describe.skip;

/**
 * Adapts a RollbackPlan snapshot (a PriceSnapshot) into the item shape
 * PriceExecutor expects, so one real mutation path serves both execute and
 * rollback.
 */
class PriceRollbackExecutor implements Executor<RollbackTarget<PriceSnapshot>, void> {
  constructor(private readonly inner: PriceExecutor) {}

  execute(item: RollbackTarget<PriceSnapshot>): Promise<ItemOutcome<void>> {
    const priceItem: PriceManifestItem = {
      ref: item.ref,
      before: item.before,
      after: item.before,
      payload: { variantId: item.before.variantId, price: item.before.price },
    };
    return this.inner.execute(priceItem);
  }
}

describeSuite("integration: update_prices two-phase + rollback", () => {
  let fx: IntegrationFixture;

  beforeAll(() => {
    fx = buildFixture();
  });

  it("previews, executes a real price change, and rolls it back exactly", async () => {
    const seeded = await searchProducts(fx.client, { title: "Seeded Product 1" }, fx.config);
    const product = seeded.products[0]!;
    const targetVariants = product.variants.slice(0, 2).map((v) => ({
      id: v.id,
      price: Number(v.price),
    }));
    expect(targetVariants.length).toBe(2);

    const newPrices = new Map(
      targetVariants.map(({ id, price }) => [id, price + 1]),
    );

    const planStore = new PlanStore<Manifest<PriceManifestItem>>({ planTtlMs: 60_000 });
    const snapshotStore = new SnapshotStore<PriceSnapshot>(60_000);
    const audit = new MemorySink();
    const executed = new Map<string, ExecutedPlan>();

    const builder = new PriceManifestBuilder(
      fx.client,
      {
        variantIds: targetVariants.map((v) => v.id),
        transform: { type: "set-absolute", newPrice: newPrices.get(targetVariants[0]!.id)! },
      },
      fx.config,
    );
    const { manifest, maxPriceChangePct } = await builder.buildWithMaxPriceChangePct();
    expect(manifest.items).toHaveLength(2);
    expect(maxPriceChangePct).toBeLessThan(fx.config.plans.maxPriceChangePct);

    const manager = new PlanManager<PriceManifestItem, PriceSnapshot, void>({
      store: planStore,
      executor: new PriceExecutor(fx.client),
      stateReader: new PriceStateReader(fx.client),
      snapshotStore,
      audit,
      callerId: "integration-tests",
    });

    const preview = await manager.preview(
      { build: () => Promise.resolve(manifest) },
      {
        tool: "update_prices",
        reason: "live integration suite: temporary price change",
        alwaysRequireApproval: false,
      },
    );
    expect(preview.status).toBe("previewed");

    const executedResult = await manager.executePlan(preview.planToken, preview.manifest);
    expect(executedResult.status).toBe("executed");
    expect(executedResult.succeededCount).toBe(2);
    expect(executedResult.failedCount).toBe(0);

    const current = await new PriceStateReader(fx.client).readCurrent(
      targetVariants.map((v) => v.id),
    );
    for (const v of targetVariants) {
      expect(current[v.id]!.price).toBe(newPrices.get(v.id)!.toFixed(2));
    }

    executed.set(preview.planToken, {
      kind: "update_prices",
      executedRefs: executedResult.refs,
    });

    const rollback = new RollbackPlan<PriceSnapshot, void>({
      snapshotStore,
      executedOf: (token) => executed.get(token) ?? null,
      supportedKinds: ["update_prices"],
      executor: new PriceRollbackExecutor(new PriceExecutor(fx.client)),
      audit,
      callerId: "integration-tests",
    });
    const rollbackResult = await rollback.rollback(preview.planToken);
    expect(rollbackResult.status).toBe("rolled_back");
    expect(rollbackResult.succeededCount).toBe(2);
    expect(rollbackResult.failedCount).toBe(0);

    const restored = await new PriceStateReader(fx.client).readCurrent(
      targetVariants.map((v) => v.id),
    );
    for (const v of targetVariants) {
      expect(restored[v.id]!.price).toBe(v.price.toFixed(2));
    }

    const executedAudit = audit.events.find((e) => e.status === "executed");
    const rolledBackAudit = audit.events.find((e) => e.status === "rolled_back");
    expect(executedAudit).toBeDefined();
    expect(rolledBackAudit).toBeDefined();
    expect(executedAudit!.tool).toBe("update_prices");
    expect(rolledBackAudit!.tool).toBe("rollback_plan");
  });
});