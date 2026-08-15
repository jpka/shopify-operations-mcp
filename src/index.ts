#!/usr/bin/env node
import { PlanStore, startApprovalServer } from "safe-write-mcp-core";
import type { ApprovalServerHandle, AuditSink } from "safe-write-mcp-core";
import { loadConfig } from "./config.js";
import { AdminClient } from "./graphql/adminClient.js";
import { createJsonlAuditSink } from "./auditSink.js";
import type { Manifest, ManifestItem } from "./plans/manifest.js";
import { SnapshotStore } from "./plans/snapshotStore.js";
import { startServer } from "./server.js";
import { renderPlan } from "./renderPlan.js";

/**
 * Starts the server process: load+validate config (throwing without
 * SHOPIFY_ADMIN_TOKEN, same as the config tests), construct the Shopify Admin
 * API client, open the tamper-evident JSONL audit sink, and wire up the shared
 * in-memory PlanStore (audited) plus the rollback SnapshotStore. Then — when
 * enabled — start the localhost human-approval HTTP server sharing the same
 * PlanStore, and finally start the MCP stdio server, which serves the full
 * tool surface over that shared store. Both the approval listener and the
 * stdio transport stay alive until a signal, at which point the approval
 * server and audit sink are closed before the process exits.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const client = new AdminClient(config.shopify);

  const audit = createJsonlAuditSink(
    process.env.SHOPIFY_AUDIT_PATH ?? "shopify-operations-audit.jsonl",
  );

  const store = new PlanStore<Manifest<ManifestItem>>({
    planTtlMs: config.plans.planTtlMs,
    audit,
  });

  const snapshotStore = new SnapshotStore<unknown>(config.plans.rollbackTtlMs);

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

  await startServer({ client, config, audit, planStore: store, snapshotStore });

  const onExit = async () => {
    await approval?.close().catch(() => {});
    audit.close();
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);
}

main().catch((err) => {
  console.error("[shopify-operations-mcp] fatal:", err);
  process.exit(1);
});