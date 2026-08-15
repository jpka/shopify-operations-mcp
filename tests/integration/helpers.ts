/**
 * Shared env-gating and client construction for the live integration suite
 * (tests/integration, run via `npm run test:integration`).
 *
 * Every integration test file must gate on `integrationEnabled()`: without
 * credentials the whole file skips as a clear no-op (see the describe wrapper
 * pattern each file uses) so both `npm run test:integration` and the default
 * `npm test` pass without touching the network. `loadConfig()` is deliberately
 * only called from `buildFixture()`, which is only ever invoked inside a
 * `beforeAll` hook of an enabled suite — it throws when SHOPIFY_ADMIN_TOKEN is
 * missing, so it must never run in the skipped path.
 */
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { AdminClient } from "../../src/graphql/adminClient.js";

/** True when the live-suite credentials are present and a real run is wanted. */
export function integrationEnabled(): boolean {
  return Boolean(
    process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN,
  );
}

/** The shared config + AdminClient every integration test builds on. */
export interface IntegrationFixture {
  config: AppConfig;
  client: AdminClient;
}

/** Loads the live-store config and returns a real AdminClient for it. */
export function buildFixture(): IntegrationFixture {
  const config = loadConfig();
  return { config, client: new AdminClient(config.shopify) };
}

/** In-memory audit sink so tests can assert the audit-consistent ledger. */
export class MemorySink implements AuditSink {
  events: AuditEvent[] = [];

  record(event: AuditEvent): undefined {
    this.events.push(event);
    return undefined;
  }
}