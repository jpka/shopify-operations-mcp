import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Pinned quarterly Shopify API version used when neither the config file nor
 * SHOPIFY_API_VERSION sets one.
 */
export const DEFAULT_API_VERSION = "2026-04";

export const DEFAULT_PLAN_TTL_MS = 60_000;
export const DEFAULT_APPROVAL_REQUIRED_ABOVE_ITEMS = 25;
export const DEFAULT_HARD_MAX_ITEMS = 250;
export const DEFAULT_MAX_PRICE_CHANGE_PCT = 30;
/** 24 hours in milliseconds. */
export const DEFAULT_ROLLBACK_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_PLANS_CONFIG = {
  planTtlMs: DEFAULT_PLAN_TTL_MS,
  approvalRequiredAboveItems: DEFAULT_APPROVAL_REQUIRED_ABOVE_ITEMS,
  hardMaxItems: DEFAULT_HARD_MAX_ITEMS,
  maxPriceChangePct: DEFAULT_MAX_PRICE_CHANGE_PCT,
  rollbackTtlMs: DEFAULT_ROLLBACK_TTL_MS,
} as const;

export const DEFAULT_APPROVAL_SERVER_PORT = 4319;

export const DEFAULT_APPROVAL_SERVER_CONFIG = {
  enabled: true,
  port: DEFAULT_APPROVAL_SERVER_PORT,
} as const;

export const DEFAULT_PROTECTED_TAGS = ["do-not-touch"] as const;

export const DEFAULT_CALLER_ID = "unknown";

export interface ShopifyConfig {
  /**
   * The myshopify.com domain (e.g. "my-store.myshopify.com"). Required:
   * from the config file's shopify.storeDomain or SHOPIFY_STORE_DOMAIN.
   */
  storeDomain: string;
  /**
   * Pinned quarterly Admin API version (e.g. "2026-04"). Default
   * DEFAULT_API_VERSION.
   */
  apiVersion: string;
  /**
   * Admin API access token. Deliberately only ever sourced from the
   * SHOPIFY_ADMIN_TOKEN environment variable — never from the config file.
   */
  adminToken: string;
}

export interface PlansConfig {
  /**
   * How long a plan token stays valid before it must be executed or expires,
   * in milliseconds. Default 60_000.
   */
  planTtlMs: number;
  /**
   * A plan touching at least this many items requires out-of-band human
   * approval before it may be executed. Default 25.
   */
  approvalRequiredAboveItems: number;
  /**
   * A plan touching more than this many items is refused outright — no plan
   * token is issued and there is no approval path. Default 250. Invariant:
   * must be >= approvalRequiredAboveItems.
   */
  hardMaxItems: number;
  /**
   * A plan that changes an item's price by more than this percentage
   * (relative to the current price) requires approval. Default 30.
   */
  maxPriceChangePct: number;
  /**
   * How long a rollback stays possible after a write, in milliseconds.
   * Default 24 hours.
   */
  rollbackTtlMs: number;
}

export interface ApprovalServerConfig {
  /**
   * Whether the localhost human-approval HTTP server starts alongside the
   * MCP stdio server. Default true. Overridable with
   * SHOPIFY_APPROVAL_SERVER_ENABLED.
   */
  enabled: boolean;
  /**
   * Port the localhost approval server binds to (127.0.0.1 only). Default
   * 4319. Overridable with SHOPIFY_APPROVAL_SERVER_PORT.
   */
  port: number;
}

export interface AppConfig {
  shopify: ShopifyConfig;
  plans: PlansConfig;
  approvalServer: ApprovalServerConfig;
  /**
   * Tags that plans may never modify; any plan touching an item carrying one
   * of these tags is refused. Default ["do-not-touch"]. Overridable with
   * SHOPIFY_PROTECTED_TAGS (comma-separated).
   */
  protectedTags: string[];
  /**
   * Identity recorded as the caller on every audit log row this server
   * instance writes. Default "unknown". Overridable with SHOPIFY_CALLER_ID.
   */
  callerId: string;
}

/**
 * Positive integer, accepting either a JSON number or a string (environment
 * variables are strings). Rejects zero, negatives, non-integers and
 * non-finite values ("12ms", "1.5", "Infinity" all fail).
 */
const positiveInt = z.coerce.number().int().positive();

/**
 * Boolean, accepting a JSON boolean or the strings "true"/"false" (the only
 * two forms environment variables can express). Anything else fails.
 */
const booleanField = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((v) => (v === "true" ? true : v === "false" ? false : v));

const nonEmptyString = z.string().trim().min(1);

const configSchema = z
  .object({
    shopify: z
      .object({
        storeDomain: nonEmptyString,
        apiVersion: nonEmptyString.default(DEFAULT_API_VERSION),
      })
      .strict(),
    plans: z
      .object({
        planTtlMs: positiveInt.default(DEFAULT_PLAN_TTL_MS),
        approvalRequiredAboveItems: positiveInt.default(
          DEFAULT_APPROVAL_REQUIRED_ABOVE_ITEMS,
        ),
        hardMaxItems: positiveInt.default(DEFAULT_HARD_MAX_ITEMS),
        maxPriceChangePct: positiveInt.default(DEFAULT_MAX_PRICE_CHANGE_PCT),
        rollbackTtlMs: positiveInt.default(DEFAULT_ROLLBACK_TTL_MS),
      })
      .strict(),
    approvalServer: z
      .object({
        enabled: booleanField.default(DEFAULT_APPROVAL_SERVER_CONFIG.enabled),
        port: positiveInt
          .max(65_535)
          .default(DEFAULT_APPROVAL_SERVER_CONFIG.port),
      })
      .strict(),
    protectedTags: z
      .array(nonEmptyString)
      .default(() => [...DEFAULT_PROTECTED_TAGS]),
    callerId: nonEmptyString.default(DEFAULT_CALLER_ID),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.plans.hardMaxItems < cfg.plans.approvalRequiredAboveItems) {
      ctx.addIssue({
        code: "custom",
        path: ["plans"],
        message: `plans.hardMaxItems (${cfg.plans.hardMaxItems}) must be >= plans.approvalRequiredAboveItems (${cfg.plans.approvalRequiredAboveItems})`,
      });
    }
  });

/**
 * Environment variables this server reads. `SHOPIFY_CONFIG` selects the
 * config file; every other SHOPIFY_* variable overrides the corresponding
 * config-file field. SHOPIFY_ADMIN_TOKEN is required and only ever read from
 * the environment.
 */
export const CONFIG_ENV_VARS = [
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

type Env = Record<string, string | undefined>;

/**
 * First defined value, treating undefined, null and "" as unset so an empty
 * environment variable falls through to the file value and then the default.
 */
function pick(...values: unknown[]): unknown {
  return values.find((v) => v !== undefined && v !== null && v !== "");
}

function deepFreeze<T>(value: T): T {
  for (const v of Object.values(value as object)) {
    if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return Object.freeze(value);
}

/**
 * Loads and validates the server config.
 *
 * Precedence: environment variables > config file (JSON) > defaults. The
 * config file is resolved from `configPath`, else SHOPIFY_CONFIG, else
 * ./config.json in the current working directory; a missing file is fine and
 * means "defaults + environment only". SHOPIFY_ADMIN_TOKEN is required — the
 * loader throws without it.
 *
 * The returned object is deeply frozen and fully validated: unknown config
 * keys, non-positive integers, malformed booleans and the
 * `hardMaxItems >= approvalRequiredAboveItems` invariant all throw.
 */
export function loadConfig(configPath?: string): AppConfig {
  const env: Env = process.env;
  const resolvedPath =
    configPath ?? env.SHOPIFY_CONFIG ?? resolve(process.cwd(), "config.json");

  let raw: Record<string, unknown> = {};
  if (existsSync(resolvedPath)) {
    const content = readFileSync(resolvedPath, "utf-8");
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed !== null && typeof parsed === "object") {
        raw = parsed as Record<string, unknown>;
      }
    } catch (err) {
      throw new Error(
        `Failed to parse config file ${resolvedPath}: ${(err as Error).message}`,
      );
    }
  }

  const rawShopify = (raw.shopify ?? {}) as Record<string, unknown>;
  const rawPlans = (raw.plans ?? {}) as Record<string, unknown>;
  const rawApprovalServer = (raw.approvalServer ?? {}) as Record<string, unknown>;
  const rawProtectedTags = raw.protectedTags;
  const rawCallerId = raw.callerId;

  const input = {
    shopify: {
      ...rawShopify,
      storeDomain: pick(env.SHOPIFY_STORE_DOMAIN, rawShopify.storeDomain),
      apiVersion: pick(env.SHOPIFY_API_VERSION, rawShopify.apiVersion),
    },
    plans: {
      ...rawPlans,
      planTtlMs: pick(env.SHOPIFY_PLAN_TTL_MS, rawPlans.planTtlMs),
      approvalRequiredAboveItems: pick(
        env.SHOPIFY_APPROVAL_REQUIRED_ABOVE_ITEMS,
        rawPlans.approvalRequiredAboveItems,
      ),
      hardMaxItems: pick(env.SHOPIFY_HARD_MAX_ITEMS, rawPlans.hardMaxItems),
      maxPriceChangePct: pick(
        env.SHOPIFY_MAX_PRICE_CHANGE_PCT,
        rawPlans.maxPriceChangePct,
      ),
      rollbackTtlMs: pick(env.SHOPIFY_ROLLBACK_TTL_MS, rawPlans.rollbackTtlMs),
    },
    approvalServer: {
      ...rawApprovalServer,
      enabled: pick(
        env.SHOPIFY_APPROVAL_SERVER_ENABLED,
        rawApprovalServer.enabled,
      ),
      port: pick(env.SHOPIFY_APPROVAL_SERVER_PORT, rawApprovalServer.port),
    },
    protectedTags:
      env.SHOPIFY_PROTECTED_TAGS !== undefined &&
      env.SHOPIFY_PROTECTED_TAGS !== ""
        ? env.SHOPIFY_PROTECTED_TAGS.split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : rawProtectedTags,
    callerId: pick(env.SHOPIFY_CALLER_ID, rawCallerId),
  };

  const adminToken = env.SHOPIFY_ADMIN_TOKEN?.trim();
  if (!adminToken) {
    throw new Error(
      "Missing SHOPIFY_ADMIN_TOKEN: the Admin API token must be provided via the " +
        "SHOPIFY_ADMIN_TOKEN environment variable — it is never read from the " +
        "config file.",
    );
  }

  const result = configSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid config (${resolvedPath} + env): ${issues}`);
  }

  return deepFreeze({
    ...result.data,
    shopify: {
      ...result.data.shopify,
      adminToken,
    },
  });
}