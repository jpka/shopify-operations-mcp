import type { AddressInfo } from "node:net";
import { PlanStore, startApprovalServer } from "safe-write-mcp-core";
import type { ApprovalServerHandle } from "safe-write-mcp-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PlanManager } from "../src/plans/planManager.ts";
import type { Manifest } from "../src/plans/manifest.ts";
import { renderPlan } from "../src/renderPlan.ts";
import type { PendingPlan } from "safe-write-mcp-core";
import {
  ToyPriceExecutor,
  ToyPriceManifestBuilder,
  ToyPriceStateReader,
  ToyStore,
} from "./fixtures/toyShopify.ts";
import type { PriceManifestItem, ToyProduct } from "./fixtures/toyShopify.ts";

const TOOL = "update_prices";
const REASON = "weekly sale";

/**
 * A three-product store with predictable prices so flags and the rendered
 * table are assertable (a: 10→12 = +20.0%, b: 20→25 = +25.0%).
 */
function seed(): ToyStore {
  return new ToyStore([
    { id: "a", title: "Alpha", price: 10, tags: [] },
    { id: "b", title: "Beta", price: 20, tags: [] },
    { id: "c", title: "Gamma", price: 30, tags: [] },
  ]);
}

/**
 * A PlanManager over a fresh ToyStore and PlanStore with a low approval
 * threshold, so a two-item preview can trip `awaiting_approval` for the
 * HTTP-driven approval tests.
 */
function makeManager(
  store: ToyStore,
  planTtlMs = 60_000,
): { manager: PlanManager<PriceManifestItem, ToyProduct, void>; planStore: PlanStore<Manifest<PriceManifestItem>> } {
  const planStore = new PlanStore<Manifest<PriceManifestItem>>({ planTtlMs });
  const manager = new PlanManager<PriceManifestItem, ToyProduct, void>({
    store: planStore,
    executor: new ToyPriceExecutor(store),
    stateReader: new ToyPriceStateReader(store),
    approvalRequiredAboveItems: 2,
    planTtlMs,
  });
  return { manager, planStore };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pendingPlans(baseUrl: string): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(`${baseUrl}/api/plans`);
  expect(resp.status).toBe(200);
  const json = (await resp.json()) as { plans: Array<Record<string, unknown>> };
  return json.plans;
}

describe("renderPlan (ticket #16)", () => {
  it("builds a manifest table with item, before, after, reason, and flags columns", () => {
    const store = seed();
    const manifest = new ToyPriceManifestBuilder(store, [
      { id: "a", newPrice: 12 },
      { id: "b", newPrice: 25 },
    ]).build();
    const plan: PendingPlan<Manifest<PriceManifestItem>> = {
      planToken: "tok",
      tool: TOOL,
      reason: REASON,
      callerId: "agent",
      previewCount: 2,
      expiresAt: Date.now() + 60_000,
      payload: manifest,
      extra: {},
    };

    const rendered = renderPlan(plan);
    expect(rendered.title).toBe(`${TOOL}: 2 items`);

    const table = rendered.details.find((d) => d.label === "Manifest");
    expect(table).toBeDefined();
    expect(table!.value).toContain("Item");
    expect(table!.value).toContain("a");
    expect(table!.value).toContain("b");
    expect(table!.value).toContain(REASON);
    expect(table!.value).toContain("price +20.0%");
    expect(table!.value).toContain("price +25.0%");
    expect(rendered.details.find((d) => d.label === "Digest")!.value).toBe(
      manifest.digest,
    );
  });

  it("renders a dash for flags when the snapshots expose no known fields", () => {
    const plan: PendingPlan<Manifest<PriceManifestItem>> = {
      planToken: "tok2",
      tool: "noop",
      reason: null,
      callerId: "agent",
      previewCount: 1,
      expiresAt: Date.now() + 60_000,
      payload: {
        items: [
          {
            ref: "x",
            before: {},
            after: {},
            payload: { newPrice: 1 },
          },
        ],
        digest: "digest",
        beforeDigest: "before",
      },
      extra: {},
    };
    const rendered = renderPlan(plan);
    const table = rendered.details.find((d) => d.label === "Manifest")!.value;
    expect(table).toContain("—");
    expect(table).not.toContain("price +");
  });
});

describe("localhost approval UI (ticket #16)", () => {
  let toy: ToyStore;
  let manager: PlanManager<PriceManifestItem, ToyProduct, void>;
  let planStore: PlanStore<Manifest<PriceManifestItem>>;
  let approval: ApprovalServerHandle;
  let baseUrl: string;

  beforeEach(async () => {
    toy = seed();
    const built = makeManager(toy);
    manager = built.manager;
    planStore = built.planStore;
    approval = await startApprovalServer<Manifest<PriceManifestItem>>(planStore, {
      port: 0,
      title: "test approval queue",
      renderPlan,
    });
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterEach(async () => {
    await approval?.close().catch(() => {});
  });

  async function preview(ids: readonly string[]): Promise<{
    planToken: string;
    manifest: Manifest<PriceManifestItem>;
  }> {
    const targets = ids.map((id) => ({
      id,
      newPrice: (toy.get(id)?.price ?? 0) + 2,
    }));
    const result = await manager.preview(
      new ToyPriceManifestBuilder(toy, targets),
      { tool: TOOL, reason: REASON, alwaysRequireApproval: true },
    );
    expect(result.status).toBe("awaiting_approval");
    return { planToken: result.planToken, manifest: result.manifest };
  }

  it("AC: binds to 127.0.0.1 only, never 0.0.0.0, on an OS-assigned port", () => {
    expect(approval.host).toBe("127.0.0.1");
    expect(approval.port).toBeGreaterThan(0);
    const address = approval.server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");
    const info = address as AddressInfo;
    expect(info.address).toBe("127.0.0.1");
    expect(info.family).toMatch(/^(IPv4|4)$/);
    expect(info.port).toBe(approval.port);
  });

  it("AC: a pending plan appears on GET /api/plans with tool, reason, count, and the rendered manifest table", async () => {
    const { planToken } = await preview(["a", "b"]);

    const plans = await pendingPlans(baseUrl);
    const mine = plans.find((p) => p.plan_token === planToken);
    expect(mine).toBeDefined();
    expect(mine!.tool).toBe(TOOL);
    expect(mine!.reason).toBe(REASON);
    expect(mine!.preview_count).toBe(2);
    expect(mine!.payload).toEqual({ items: expect.any(Array), digest: expect.any(String), beforeDigest: expect.any(String) });

    const render = mine!.render as { title: string; details: Array<{ label: string; value: string }> };
    expect(render.title).toBe(`${TOOL}: 2 items`);
    const table = render.details.find((d) => d.label === "Manifest")!.value;
    expect(table).toContain("Item");
    expect(table).toContain("a");
    expect(table).toContain("price +20.0%");

    // The server-rendered HTML reflects the same plan without client-side JS.
    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(REASON);
    expect(html).toContain("price +20.0%");
  });

  it("AC: approving via the HTTP endpoint unlocks execute_plan", async () => {
    const { planToken, manifest } = await preview(["a"]);

    await expect(manager.executePlan(planToken, manifest)).rejects.toMatchObject({
      code: "AWAITING_APPROVAL",
    });

    const approveResp = await fetch(
      `${baseUrl}/api/plans/${planToken}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvedBy: "reviewer@example.com" }),
      },
    );
    expect(approveResp.status).toBe(200);
    expect(((await approveResp.json()) as { ok: boolean }).ok).toBe(true);

    // An approved plan drops off the pending list.
    const plans = await pendingPlans(baseUrl);
    expect(plans.find((p) => p.plan_token === planToken)).toBeUndefined();

    const result = await manager.executePlan(planToken, manifest);
    expect(result.status).toBe("executed");
    expect(result.succeededCount).toBe(1);
    expect(toy.get("a")!.price).toBe(12);
  });

  it("AC: rejecting via the HTTP endpoint tombstones the plan with PLAN_REJECTED", async () => {
    const { planToken, manifest } = await preview(["a"]);

    const rejectResp = await fetch(`${baseUrl}/api/plans/${planToken}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rejectedBy: "reviewer@example.com",
        reason: "too broad, narrow the change",
      }),
    });
    expect(rejectResp.status).toBe(200);
    expect(((await rejectResp.json()) as { ok: boolean }).ok).toBe(true);

    // execute_plan against the rejected token fails with the distinguishable
    // PLAN_REJECTED — not AWAITING_APPROVAL, not a generic failure.
    await expect(manager.executePlan(planToken, manifest)).rejects.toMatchObject({
      code: "PLAN_REJECTED",
    });

    // Approving after rejecting does not un-kill it.
    const approveAfterReject = await fetch(
      `${baseUrl}/api/plans/${planToken}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(approveAfterReject.status).toBe(409);
    expect(((await approveAfterReject.json()) as { code: string }).code).toBe(
      "PLAN_REJECTED",
    );

    // The tombstone stays off the pending list.
    const plans = await pendingPlans(baseUrl);
    expect(plans.find((p) => p.plan_token === planToken)).toBeUndefined();

    // Rejecting twice is idempotent, not an error.
    const secondReject = await fetch(`${baseUrl}/api/plans/${planToken}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(secondReject.status).toBe(200);
    expect(((await secondReject.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("localhost approval UI: expired plans (ticket #16)", () => {
  let toy: ToyStore;
  let manager: PlanManager<PriceManifestItem, ToyProduct, void>;
  let planStore: PlanStore<Manifest<PriceManifestItem>>;
  let approval: ApprovalServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    toy = seed();
    const built = makeManager(toy, 100);
    manager = built.manager;
    planStore = built.planStore;
    approval = await startApprovalServer<Manifest<PriceManifestItem>>(planStore, {
      port: 0,
      renderPlan,
    });
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterAll(async () => {
    await approval?.close().catch(() => {});
  });

  it("AC: an expired plan disappears from the pending list and approve reports PLAN_EXPIRED", async () => {
    const preview = await manager.preview(
      new ToyPriceManifestBuilder(toy, [{ id: "a", newPrice: 12 }]),
      { tool: TOOL, reason: "expiry-check", alwaysRequireApproval: true },
    );
    expect(preview.status).toBe("awaiting_approval");

    const before = await pendingPlans(baseUrl);
    expect(before.find((p) => p.plan_token === preview.planToken)).toBeDefined();

    await sleep(200);

    const after = await pendingPlans(baseUrl);
    expect(after.find((p) => p.plan_token === preview.planToken)).toBeUndefined();

    const approveResp = await fetch(
      `${baseUrl}/api/plans/${preview.planToken}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(approveResp.status).toBe(410);
    expect(((await approveResp.json()) as { code: string }).code).toBe(
      "PLAN_EXPIRED",
    );
  });
});

describe("localhost approval UI works with no MCP client connected (ticket #16)", () => {
  let approval: ApprovalServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    // Deliberately no PlanManager, no MCP Server, no MCP Client anywhere in
    // this block — only a PlanStore and the approval HTTP server built
    // directly on top of it, mirroring how index.ts starts before the MCP
    // stdio server lands.
    const planStore = new PlanStore<Manifest<PriceManifestItem>>({
      planTtlMs: 60_000,
    });
    approval = await startApprovalServer<Manifest<PriceManifestItem>>(planStore, {
      port: 0,
      renderPlan,
    });
    baseUrl = `http://${approval.host}:${approval.port}`;
  });

  afterAll(async () => {
    await approval?.close().catch(() => {});
  });

  it("GET / and GET /api/plans succeed with plain fetch()", async () => {
    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);

    const api = await fetch(`${baseUrl}/api/plans`);
    expect(api.status).toBe(200);
    const json = (await api.json()) as { plans: unknown[] };
    expect(json.plans).toEqual([]);
  });

  it("an unknown route returns a structured 404", async () => {
    const resp = await fetch(`${baseUrl}/nope`);
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as { ok: boolean; code: string };
    expect(json.ok).toBe(false);
    expect(json.code).toBe("NOT_FOUND");
  });
});