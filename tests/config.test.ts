import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_API_VERSION,
  DEFAULT_APPROVAL_SERVER_CONFIG,
  DEFAULT_PLANS_CONFIG,
  DEFAULT_PROTECTED_TAGS,
  loadConfig,
} from "../src/config.js";
import type { AppConfig } from "../src/config.js";

const SHOPIFY_ENV_KEYS = [
  "SHOPIFY_ADMIN_TOKEN",
  "SHOPIFY_STORE_DOMAIN",
  "SHOPIFY_API_VERSION",
  "SHOPIFY_PLAN_TTL_MS",
  "SHOPIFY_APPROVAL_REQUIRED_ABOVE_ITEMS",
  "SHOPIFY_HARD_MAX_ITEMS",
  "SHOPIFY_MAX_PRICE_CHANGE_PCT",
  "SHOPIFY_ROLLBACK_TTL_MS",
  "SHOPIFY_APPROVAL_SERVER_ENABLED",
  "SHOPIFY_APPROVAL_SERVER_PORT",
  "SHOPIFY_PROTECTED_TAGS",
  "SHOPIFY_CALLER_ID",
  "SHOPIFY_CONFIG",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of SHOPIFY_ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of SHOPIFY_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of SHOPIFY_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function writeTempConfig(overrides: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "shopify-config-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      shopify: { storeDomain: "d.myshopify.com" },
      ...overrides,
    }),
  );
  return path;
}

const TOKEN = "shpat_testtoken123";

describe("config loader (ticket #4)", () => {
  it("applies defaults when the file and env omit optional fields", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    const config = loadConfig(writeTempConfig({ shopify: { storeDomain: "d.myshopify.com" } }));

    expect(config.shopify.storeDomain).toBe("d.myshopify.com");
    expect(config.shopify.apiVersion).toBe(DEFAULT_API_VERSION);
    expect(config.shopify.adminToken).toBe(TOKEN);
    expect(config.plans).toEqual(DEFAULT_PLANS_CONFIG);
    expect(config.approvalServer).toEqual(DEFAULT_APPROVAL_SERVER_CONFIG);
    expect(config.protectedTags).toEqual(DEFAULT_PROTECTED_TAGS);
    expect(config.callerId).toBe("unknown");
  });

  it("env beats file beats defaults for storeDomain and token", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    process.env.SHOPIFY_STORE_DOMAIN = "env.myshopify.com";
    process.env.SHOPIFY_PLAN_TTL_MS = "120000";
    const config = loadConfig(
      writeTempConfig({
        shopify: { storeDomain: "file.myshopify.com" },
        plans: { planTtlMs: 30_000 },
      }),
    );

    expect(config.shopify.storeDomain).toBe("env.myshopify.com");
    expect(config.shopify.adminToken).toBe(TOKEN);
    expect(config.shopify.apiVersion).toBe(DEFAULT_API_VERSION);
    expect(config.plans.planTtlMs).toBe(120_000);
  });

  it("throws when SHOPIFY_ADMIN_TOKEN is missing", () => {
    expect(() => loadConfig(writeTempConfig({}))).toThrow(/SHOPIFY_ADMIN_TOKEN/);
    expect(() => loadConfig()).toThrow(/SHOPIFY_ADMIN_TOKEN/);
  });

  it("throws when hardMaxItems < approvalRequiredAboveItems", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    expect(() =>
      loadConfig(
        writeTempConfig({
          plans: { approvalRequiredAboveItems: 200, hardMaxItems: 50 },
        }),
      ),
    ).toThrow(/hardMaxItems.*approvalRequiredAboveItems/);
  });

  it("allows hardMaxItems equal to approvalRequiredAboveItems", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    const config = loadConfig(
      writeTempConfig({
        plans: { approvalRequiredAboveItems: 100, hardMaxItems: 100 },
      }),
    );
    expect(config.plans.approvalRequiredAboveItems).toBe(100);
    expect(config.plans.hardMaxItems).toBe(100);
  });

  it("loads a full config from a file path", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    const config = loadConfig(
      writeTempConfig({
        shopify: { storeDomain: "full.myshopify.com", apiVersion: "2025-10" },
        plans: {
          planTtlMs: 5_000,
          approvalRequiredAboveItems: 10,
          hardMaxItems: 400,
          maxPriceChangePct: 15,
          rollbackTtlMs: 3_600_000,
        },
        approvalServer: { enabled: false, port: 9999 },
        protectedTags: ["do-not-touch", "archived"],
        callerId: "ci-agent",
      }),
    );

    expect(config.shopify).toEqual({
      storeDomain: "full.myshopify.com",
      apiVersion: "2025-10",
      adminToken: TOKEN,
    });
    expect(config.plans).toEqual({
      planTtlMs: 5_000,
      approvalRequiredAboveItems: 10,
      hardMaxItems: 400,
      maxPriceChangePct: 15,
      rollbackTtlMs: 3_600_000,
    });
    expect(config.approvalServer).toEqual({ enabled: false, port: 9999 });
    expect(config.protectedTags).toEqual(["do-not-touch", "archived"]);
    expect(config.callerId).toBe("ci-agent");
  });

  it("accepts numeric env overrides as strings", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    process.env.SHOPIFY_APPROVAL_REQUIRED_ABOVE_ITEMS = "7";
    process.env.SHOPIFY_HARD_MAX_ITEMS = "700";
    process.env.SHOPIFY_ROLLBACK_TTL_MS = "86400000";
    process.env.SHOPIFY_APPROVAL_SERVER_ENABLED = "false";
    process.env.SHOPIFY_APPROVAL_SERVER_PORT = "8080";
    process.env.SHOPIFY_PROTECTED_TAGS = "do-not-touch, production";
    process.env.SHOPIFY_CALLER_ID = "nightly-batch";

    const config = loadConfig(writeTempConfig({}));

    expect(config.plans.approvalRequiredAboveItems).toBe(7);
    expect(config.plans.hardMaxItems).toBe(700);
    expect(config.plans.rollbackTtlMs).toBe(86_400_000);
    expect(config.approvalServer.enabled).toBe(false);
    expect(config.approvalServer.port).toBe(8080);
    expect(config.protectedTags).toEqual(["do-not-touch", "production"]);
    expect(config.callerId).toBe("nightly-batch");
  });

  it("rejects invalid env override values", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    process.env.SHOPIFY_PLAN_TTL_MS = "12ms";
    expect(() => loadConfig(writeTempConfig({}))).toThrow(/planTtlMs/);

    process.env.SHOPIFY_PLAN_TTL_MS = "-5";
    expect(() => loadConfig(writeTempConfig({}))).toThrow(/planTtlMs/);

    delete process.env.SHOPIFY_PLAN_TTL_MS;
    process.env.SHOPIFY_APPROVAL_SERVER_ENABLED = "yes";
    expect(() => loadConfig(writeTempConfig({}))).toThrow(/enabled/);
  });

  it("rejects unknown config keys (typo protection)", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    expect(() =>
      loadConfig(writeTempConfig({ plans: { hradMaxItems: 100 } })),
    ).toThrow(/hradMaxItems/);
  });

  it("rejects invalid file values", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    expect(() =>
      loadConfig(writeTempConfig({ plans: { planTtlMs: 0 } })),
    ).toThrow(/planTtlMs/);
    expect(() =>
      loadConfig(writeTempConfig({ plans: { hardMaxItems: 1.5 } })),
    ).toThrow(/hardMaxItems/);
    expect(() =>
      loadConfig(writeTempConfig({ approvalServer: { port: 70_000 } })),
    ).toThrow(/port/);
    expect(() =>
      loadConfig(writeTempConfig({ shopify: { storeDomain: "" } })),
    ).toThrow(/storeDomain/);
  });

  it("throws a clear error for an unparseable config file", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    const dir = mkdtempSync(join(tmpdir(), "shopify-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{ not json");
    expect(() => loadConfig(path)).toThrow(/Failed to parse config file/);
  });

  it("returns a deeply frozen config", () => {
    process.env.SHOPIFY_ADMIN_TOKEN = TOKEN;
    const config = loadConfig(writeTempConfig({}));
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.plans)).toBe(true);
    expect(Object.isFrozen(config.shopify)).toBe(true);
    expect(() => {
      (config as AppConfig).shopify.storeDomain = "mutated";
    }).toThrow(TypeError);
    expect(() => {
      config.protectedTags.push("x");
    }).toThrow(TypeError);
  });
});
