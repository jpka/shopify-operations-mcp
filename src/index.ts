#!/usr/bin/env node
import { PlanStore, startApprovalServer } from "safe-write-mcp-core";
import type { ApprovalServerHandle } from "safe-write-mcp-core";
import { loadConfig } from "./config.js";
import type { Manifest, ManifestItem } from "./plans/manifest.js";
import { renderPlan } from "./renderPlan.js";

/**
 * Starts the server process: load+validate config (throwing without
 * SHOPIFY_ADMIN_TOKEN, same as the config tests), then — when enabled — start
 * the localhost human-approval HTTP server sharing the same in-memory PlanStore
 * an MCP stdio server will later be wired to (the @modelcontextprotocol/sdk
 * transport lands in a later ticket; the approval surface must already work
 * standalone). Both stay alive on the approval server's listener until a
 * signal.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const store = new PlanStore<Manifest<ManifestItem>>({
    planTtlMs: config.plans.planTtlMs,
  });

  let approval: ApprovalServerHandle | undefined;
  if (config.approvalServer.enabled) {
    approval = await startApprovalServer(store, {
      port: config.approvalServer.port,
      title: "shopify-operations-mcp — approval queue",
      renderPlan,
    });
    console.error(
      `[shopify-operations-mcp] localhost approval UI listening on http://${approval.host}:${approval.port}`,
    );
  }

  const onExit = async () => {
    await approval?.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);
}

main().catch((err) => {
  console.error("[shopify-operations-mcp] fatal:", err);
  process.exit(1);
});