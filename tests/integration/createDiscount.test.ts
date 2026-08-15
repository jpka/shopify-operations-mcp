/**
 * Live integration suite: create_discount two-phase flow against the real
 * Admin API — preview, execute creation of a uniquely-named percentage
 * discount, verify it reads back as active, then clean it up through
 * RollbackPlan's DiscountRollbackExecutor (deactivate). Leaves the store with
 * a deactivated discount code and no active mutation residue.
 *
 * Env-gated: skipped entirely unless both SHOPIFY_STORE_DOMAIN and
 * SHOPIFY_ADMIN_TOKEN are set, so `npm test` and `npm run test:integration`
 * pass as a no-op without credentials.
 */
import { PlanStore } from "safe-write-mcp-core";
import { beforeAll, describe, expect, it } from "vitest";
import type { Manifest } from "../../src/plans/manifest.js";
import { PlanManager } from "../../src/plans/planManager.js";
import { SnapshotStore } from "../../src/plans/snapshotStore.js";
import {
  RollbackPlan,
  type ExecutedPlan,
} from "../../src/tools/rollbackPlan.js";
import {
  DiscountExecutor,
  DiscountManifestBuilder,
  DiscountRollbackExecutor,
  DiscountStateReader,
  type CreateDiscountArgs,
  type DiscountManifestItem,
  type DiscountSnapshot,
} from "../../src/tools/createDiscount.js";
import {
  buildFixture,
  integrationEnabled,
  MemorySink,
  type IntegrationFixture,
} from "./helpers.js";

const enabled = integrationEnabled();
if (!enabled) {
  console.warn(
    "[integration:createDiscount] SKIPPED — set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN and run `npm run seed` first.",
  );
}
const describeSuite = enabled ? describe : describe.skip;

describeSuite("integration: create_discount two-phase + cleanup", () => {
  let fx: IntegrationFixture;

  beforeAll(() => {
    fx = buildFixture();
  });

  it("previews, creates a real discount, verifies it is active, then deactivates it", async () => {
    const args: CreateDiscountArgs = {
      code: `INTEGRATION-${Date.now()}`,
      discountType: "percentage",
      value: 10,
    };

    const planStore = new PlanStore<Manifest<DiscountManifestItem>>({ planTtlMs: 60_000 });
    const snapshotStore = new SnapshotStore<DiscountSnapshot | null>(60_000);
    const audit = new MemorySink();
    const executed = new Map<string, ExecutedPlan>();

    const manager = new PlanManager<DiscountManifestItem, DiscountSnapshot | null, void>({
      store: planStore,
      executor: new DiscountExecutor(fx.client),
      stateReader: new DiscountStateReader(fx.client),
      snapshotStore,
      audit,
      callerId: "integration-tests",
    });

    const preview = await manager.preview(
      new DiscountManifestBuilder(fx.client, args, fx.config),
      { tool: "create_discount", reason: `live integration suite: ${args.code}` },
    );
    expect(preview.status).toBe("previewed");
    expect(preview.itemCount).toBe(1);

    const executedResult = await manager.executePlan(preview.planToken, preview.manifest);
    expect(executedResult.status).toBe("executed");
    expect(executedResult.succeededCount).toBe(1);
    expect(executedResult.failedCount).toBe(0);

    const state = await new DiscountStateReader(fx.client).readCurrent([args.code]);
    expect(state[args.code]).toBeDefined();
    expect(state[args.code]!.status).toBe("active");
    expect(state[args.code]!.code).toBe(args.code);

    executed.set(preview.planToken, {
      kind: "create_discount",
      executedRefs: executedResult.refs,
    });

    const rollback = new RollbackPlan<DiscountSnapshot | null, void>({
      snapshotStore,
      executedOf: (token) => executed.get(token) ?? null,
      supportedKinds: ["create_discount"],
      executor: new DiscountRollbackExecutor(fx.client),
      audit,
      callerId: "integration-tests",
    });
    const rollbackResult = await rollback.rollback(preview.planToken);
    expect(rollbackResult.status).toBe("rolled_back");
    expect(rollbackResult.succeededCount).toBe(1);
    expect(rollbackResult.failedCount).toBe(0);

    const after = await new DiscountStateReader(fx.client).readCurrent([args.code]);
    expect(after[args.code]!.status).toBe("deactivated");
  });
});