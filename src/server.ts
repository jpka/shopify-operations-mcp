import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PlanStore } from "safe-write-mcp-core";
import type { AuditSink } from "safe-write-mcp-core";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AdminClient } from "./graphql/adminClient.js";
import type { Executor } from "./plans/executor.js";
import type { Manifest, ManifestItem, StateReader } from "./plans/manifest.js";
import { PlanManager } from "./plans/planManager.js";
import type { PreviewResult } from "./plans/planManager.js";
import { SnapshotStore } from "./plans/snapshotStore.js";
import { searchProducts } from "./tools/searchProducts.js";
import { listOrders, FINANCIAL_STATUSES, FULFILLMENT_STATUSES } from "./tools/listOrders.js";
import {
  PriceManifestBuilder,
  PriceStateReader,
  PriceExecutor,
} from "./tools/updatePrices.js";
import {
  InventoryManifestBuilder,
  InventoryStateReader,
  InventoryExecutor,
} from "./tools/updateInventory.js";
import type { InventoryManifestItem } from "./tools/updateInventory.js";
import {
  DiscountManifestBuilder,
  DiscountStateReader,
  DiscountExecutor,
} from "./tools/createDiscount.js";
import {
  RefundManifestBuilder,
  RefundStateReader,
  RefundExecutor,
} from "./tools/refundOrder.js";
import {
  TOOL_CANCEL_ORDER,
  CANCEL_REASONS,
  cancelOrder,
  executeCancelOrder,
} from "./tools/cancelOrder.js";
import type { CancelOrderArgs, CancelOrderManifestItem } from "./tools/cancelOrder.js";
import { RollbackPlan } from "./tools/rollbackPlan.js";
import type { ExecutedPlan } from "./tools/rollbackPlan.js";
import { ShopifyRollbackExecutor } from "./tools/rollbackExecutors.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export interface ServerContext {
  client: AdminClient;
  config: AppConfig;
  audit: AuditSink;
  planStore: PlanStore<Manifest<ManifestItem>>;
  snapshotStore: SnapshotStore<unknown>;
}

const searchProductsArgsSchema = z
  .object({
    title: z.string().optional(),
    sku: z.string().optional(),
    vendor: z.string().optional(),
    tag: z.string().optional(),
    first: z.number().int().positive().optional(),
  })
  .strict();

const listOrdersArgsSchema = z
  .object({
    financialStatus: z.enum(FINANCIAL_STATUSES).optional(),
    fulfillmentStatus: z.enum(FULFILLMENT_STATUSES).optional(),
    createdAfter: z.string().optional(),
    createdBefore: z.string().optional(),
    first: z.number().int().positive().optional(),
  })
  .strict();

const priceTransformSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set-absolute"), newPrice: z.number() }),
  z.object({ type: z.literal("adjust-percentage"), percentage: z.number() }),
]);

const updatePricesArgsSchema = z
  .object({
    variantIds: z.array(z.string()).optional(),
    vendor: z.string().optional(),
    tag: z.string().optional(),
    transform: priceTransformSchema,
    reason: z.string().optional(),
  })
  .strict()
  .refine(
    (data) =>
      (data.variantIds !== undefined && data.variantIds.length > 0) ||
      data.vendor !== undefined ||
      data.tag !== undefined,
    {
      message: "At least one of variantIds, vendor, or tag is required.",
      path: ["variantIds"],
    },
  );

const updateInventoryArgsSchema = z
  .object({
    locationId: z.string(),
    adjustments: z
      .array(
        z.object({
          inventoryItemId: z.string(),
          quantity: z.number().int(),
        }),
      )
      .min(1),
    reason: z.string().optional(),
  })
  .strict();

const createDiscountArgsSchema = z
  .object({
    code: z.string(),
    discountType: z.enum(["percentage", "fixed_amount"]),
    value: z.number(),
    usageLimit: z.number().int().nullable().optional(),
    reason: z.string().optional(),
  })
  .strict();

const cancelOrderArgsSchema = z
  .object({
    orderId: z.string(),
    reason: z.enum(CANCEL_REASONS),
    restock: z.boolean(),
    notifyCustomer: z.boolean(),
  })
  .strict();

const refundOrderArgsSchema = z
  .object({
    orderId: z.string(),
    refundLineItems: z
      .array(
        z.object({
          lineItemId: z.string(),
          quantity: z.number().int().positive(),
          restockType: z.enum(["RETURN", "NO_RESTOCK", "CANCEL"]).optional(),
        }),
      )
      .optional(),
    reason: z.string().optional(),
  })
  .strict();

const executePlanArgsSchema = z
  .object({
    plan_token: z.string(),
    manifest: z
      .object({
        items: z.array(
          z
            .object({
              ref: z.string(),
              before: z.unknown(),
              after: z.unknown(),
              payload: z.unknown().optional(),
            })
            .passthrough(),
        ),
        digest: z.string(),
        beforeDigest: z.string(),
      })
      .strict(),
  })
  .strict();

const rollbackPlanArgsSchema = z.object({ planToken: z.string() }).strict();

function text(content: string) {
  return { content: [{ type: "text", text: content }] as const };
}

function errorBody(err: unknown) {
  if (
    err !== null &&
    typeof err === "object" &&
    typeof (err as { code?: unknown }).code === "string" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    const structured = err as { code: string; message: string; hint?: string };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: structured.code,
            message: structured.message,
            hint: structured.hint ?? null,
          }),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "INTERNAL_ERROR",
          message: "Unexpected server error.",
          hint: "Retry the call; if it persists, check the server logs.",
        }),
      },
    ],
    isError: true,
  };
}

function invalidArguments(error: z.ZodError) {
  const details = error.issues
    .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
    .join("; ");
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "INVALID_ARGUMENTS",
          message: `Invalid arguments: ${details}`,
          hint: "Check the tool's input schema and retry.",
        }),
      },
    ],
    isError: true,
  };
}

function unknownToolError(name: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "UNKNOWN_TOOL",
          message: `Unknown tool: ${name}`,
          hint: "List available tools and retry with a known tool name.",
        }),
      },
    ],
    isError: true,
  };
}

function previewResponse(
  preview: PreviewResult<ManifestItem>,
  config: AppConfig,
  tool: string,
) {
  const message =
    preview.status === "awaiting_approval"
      ? "This plan requires human approval through the localhost approval UI before it will execute. Call execute_plan with this plan_token and the exact manifest above to await the human's decision: the call waits until a human approves it (it then executes), rejects it (you receive a structured PLAN_REJECTED error — adjust the operation and re-preview), or the plan expires."
      : null;
  return text(
    JSON.stringify(
      {
        status: preview.status,
        plan_token: preview.planToken,
        item_count: preview.itemCount,
        expires_at: preview.expiresAt,
        manifest: preview.manifest,
        message,
      },
      null,
      2,
    ),
  );
}

export function createServer(ctx: ServerContext): Server {
  const callerId = ctx.config.callerId;

  const priceManager = new PlanManager<ManifestItem, unknown, unknown>({
    store: ctx.planStore,
    executor: new PriceExecutor(ctx.client),
    stateReader: new PriceStateReader(ctx.client),
    snapshotStore: ctx.snapshotStore,
    audit: ctx.audit,
    callerId,
    planTtlMs: ctx.config.plans.planTtlMs,
    approvalRequiredAboveItems: ctx.config.plans.approvalRequiredAboveItems,
    hardMaxItems: ctx.config.plans.hardMaxItems,
  });

  const inventoryLocationsByRef = new Map<string, string>();

  const inventoryExecutorAdapter: Executor<ManifestItem, unknown> = {
    execute: (item) => {
      const inv = item as InventoryManifestItem;
      const locationId = inventoryLocationsByRef.get(inv.ref) ?? "";
      return new InventoryExecutor(ctx.client, locationId).execute(inv);
    },
  };

  const inventoryStateReaderAdapter: StateReader<unknown> = {
    readCurrent: async (refs) => {
      const byLocation = new Map<string, string[]>();
      for (const ref of refs) {
        const locationId = inventoryLocationsByRef.get(ref) ?? "";
        const bucket = byLocation.get(locationId) ?? [];
        bucket.push(ref);
        byLocation.set(locationId, bucket);
      }
      const out: Record<string, unknown> = {};
      for (const [locationId, locationRefs] of byLocation) {
        const levels = await new InventoryStateReader(
          ctx.client,
          locationId,
        ).readCurrent(locationRefs);
        for (const [ref, level] of Object.entries(levels)) {
          out[ref] = level;
        }
      }
      return out;
    },
  };

  const inventoryManager = new PlanManager<ManifestItem, unknown, unknown>({
    store: ctx.planStore,
    executor: inventoryExecutorAdapter,
    stateReader: inventoryStateReaderAdapter,
    snapshotStore: ctx.snapshotStore,
    audit: ctx.audit,
    callerId,
    planTtlMs: ctx.config.plans.planTtlMs,
    approvalRequiredAboveItems: ctx.config.plans.approvalRequiredAboveItems,
    hardMaxItems: ctx.config.plans.hardMaxItems,
  });

  const discountManager = new PlanManager<ManifestItem, unknown, unknown>({
    store: ctx.planStore,
    executor: new DiscountExecutor(ctx.client),
    stateReader: new DiscountStateReader(ctx.client),
    snapshotStore: ctx.snapshotStore,
    audit: ctx.audit,
    callerId,
    planTtlMs: ctx.config.plans.planTtlMs,
    approvalRequiredAboveItems: ctx.config.plans.approvalRequiredAboveItems,
    hardMaxItems: ctx.config.plans.hardMaxItems,
  });

  const refundManager = new PlanManager<ManifestItem, unknown, unknown>({
    store: ctx.planStore,
    executor: new RefundExecutor(ctx.client),
    stateReader: new RefundStateReader(ctx.client),
    snapshotStore: ctx.snapshotStore,
    audit: ctx.audit,
    callerId,
    planTtlMs: ctx.config.plans.planTtlMs,
    approvalRequiredAboveItems: ctx.config.plans.approvalRequiredAboveItems,
    hardMaxItems: ctx.config.plans.hardMaxItems,
  });

  const managers = new Map<string, PlanManager<ManifestItem, unknown, unknown>>([
    ["update_prices", priceManager],
    ["update_inventory", inventoryManager],
    ["create_discount", discountManager],
    ["refund_order", refundManager],
  ]);

  const planKinds = new Map<string, string>();
  const cancelArgs = new Map<string, CancelOrderArgs>();
  const executedPlans = new Map<string, ExecutedPlan>();

  const rollbackPlan = new RollbackPlan<unknown, void>({
    snapshotStore: ctx.snapshotStore,
    executedOf: (token) => executedPlans.get(token) ?? null,
    supportedKinds: ["update_prices", "update_inventory", "create_discount"],
    executor: new ShopifyRollbackExecutor(ctx.client),
    audit: ctx.audit,
    callerId,
  });

  const server = new Server(
    { name: pkg.name, version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_products",
        description:
          "Search products by title, sku, vendor, or tag and return variant pricing and per-location inventory references. Read-only: composes a Shopify search string, walks the cursor-paginated products connection to completion, and flags any product carrying a configured protected tag so a later write plan touching it is refused at preview time.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Matches products whose title contains the term (Shopify fuzzy search).",
            },
            sku: {
              type: "string",
              description: "Matches products with a variant whose SKU equals the term.",
            },
            vendor: { type: "string", description: "Matches products from this vendor." },
            tag: { type: "string", description: "Matches products carrying this tag." },
            first: {
              type: "number",
              description:
                "Optional page size for the internal cursor walk (default 50). Must be a positive integer.",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: "list_orders",
        description:
          "List cancellable and refundable orders (id, name, financial and fulfillment status, total price, line items), optionally filtered by financial status, fulfillment status, and created-date range. Read-only: a single GraphQL query over the orders connection with no mutation.",
        inputSchema: {
          type: "object",
          properties: {
            financialStatus: {
              type: "string",
              enum: [...FINANCIAL_STATUSES],
              description:
                "Only orders with this financial status (e.g. \"paid\", \"refunded\"). Maps to financial_status: in the Admin API search query.",
            },
            fulfillmentStatus: {
              type: "string",
              enum: [...FULFILLMENT_STATUSES],
              description:
                "Only orders with this fulfillment status (e.g. \"unfulfilled\"). Maps to fulfillment_status: in the Admin API search query.",
            },
            createdAfter: {
              type: "string",
              description:
                "Only orders created at or after this ISO-8601 date or datetime (inclusive). Maps to created_at:>=.",
            },
            createdBefore: {
              type: "string",
              description:
                "Only orders created at or before this ISO-8601 date or datetime (inclusive). Maps to created_at:<=.",
            },
            first: {
              type: "number",
              description:
                "Optional page size passed as `first` to the orders connection (default 250). Must be a positive integer.",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: "update_prices",
        description:
          "Preview and execute bulk variant price changes (two-phase). Previews the exact price change for every matched variant (pure reads, zero mutation) and returns a plan_token; nothing changes until execute_plan runs with that token. A plan that changes any single variant's price by more than plans.maxPriceChangePct (default 30%), or that touches at least plans.approvalRequiredAboveItems variants, requires human approval through the localhost approval UI before it executes. Variants belonging to a product carrying a protected tag are refused at preview time.",
        inputSchema: {
          type: "object",
          properties: {
            variantIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Explicit variant IDs to update; use when not filtering by vendor/tag. Mutually exclusive with the vendor/tag filters.",
            },
            vendor: {
              type: "string",
              description:
                "Vendor filter: selects variants from products with this vendor. Use with tag for AND filtering.",
            },
            tag: {
              type: "string",
              description:
                "Tag filter: selects variants from products with this tag. Use with vendor for AND filtering.",
            },
            transform: {
              type: "object",
              description: "The price transform applied to every matched variant.",
              oneOf: [
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["set-absolute"] },
                    newPrice: { type: "number" },
                  },
                  required: ["type", "newPrice"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["adjust-percentage"] },
                    percentage: { type: "number" },
                  },
                  required: ["type", "percentage"],
                  additionalProperties: false,
                },
              ],
            },
            reason: {
              type: "string",
              description: "Why the agent is performing this price change. Recorded for audit.",
            },
          },
          required: ["transform"],
          additionalProperties: false,
        },
      },
      {
        name: "update_inventory",
        description:
          "Preview and execute bulk inventory quantity changes at one location (two-phase). Sets the available quantity of each inventory item at the location to the absolute value supplied (not a delta). Previews planned changes (pure reads, zero mutation) and returns a plan_token; nothing changes until execute_plan runs with that token. A plan touching at least plans.approvalRequiredAboveItems items requires human approval through the localhost approval UI before it executes. Inventory items belonging to a product carrying a protected tag are refused at preview time.",
        inputSchema: {
          type: "object",
          properties: {
            locationId: {
              type: "string",
              description: "The gid://shopify/Location/... id where quantities are set.",
            },
            adjustments: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  inventoryItemId: {
                    type: "string",
                    description:
                      "gid://shopify/InventoryItem/... id (from search_products variant inventory references).",
                  },
                  quantity: {
                    type: "number",
                    description:
                      "The quantity to set at the location after this plan executes (absolute, not a delta).",
                  },
                },
                required: ["inventoryItemId", "quantity"],
                additionalProperties: false,
              },
              description: "Per-inventory-item quantity adjustments.",
            },
            reason: {
              type: "string",
              description: "Why the agent is performing this inventory change. Recorded for audit.",
            },
          },
          required: ["locationId", "adjustments"],
          additionalProperties: false,
        },
      },
      {
        name: "create_discount",
        description:
          "Preview and execute the creation of a discount code (two-phase). Previews the planned discount (pure reads, zero mutation) and returns a plan_token; nothing changes until execute_plan runs with that token. A plan touching at least plans.approvalRequiredAboveItems items requires human approval through the localhost approval UI before it executes. Discount creation is reversible via rollback_plan, which deactivates the created code.",
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string", description: "The discount code to create (e.g. \"SUMMER20\")." },
            discountType: {
              type: "string",
              enum: ["percentage", "fixed_amount"],
              description:
                "\"percentage\" for a percentage discount, or \"fixed_amount\" for a fixed monetary amount off.",
            },
            value: {
              type: "number",
              description:
                "The value of the discount: for \"percentage\" a number between 0 and 100 (e.g. 20 for 20% off); for \"fixed_amount\" a decimal amount in the shop's currency (e.g. 10.00 for $10 off).",
            },
            usageLimit: {
              type: "number",
              description:
                "Optional maximum number of times this discount can be used in total. Null means unlimited usage.",
            },
            reason: {
              type: "string",
              description: "Why the agent is creating this discount. Recorded for audit.",
            },
          },
          required: ["code", "discountType", "value"],
          additionalProperties: false,
        },
      },
      {
        name: "refund_order",
        description:
          "Preview and execute an order refund (two-phase). Previews via Shopify's refundCalculate (zero writes) to obtain exact suggested refund amounts, then — only after a human approves through the localhost approval UI — executes via refundCreate. ALWAYS requires human approval regardless of item count, because a refund is irreversible and unwinds a payment. Refunds cannot be rolled back (refund_order is not among rollback_plan's supported kinds).",
        inputSchema: {
          type: "object",
          properties: {
            orderId: {
              type: "string",
              description: "GID of the order to refund (e.g. gid://shopify/Order/123).",
            },
            refundLineItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  lineItemId: {
                    type: "string",
                    description: "GID of the line item to refund (variant or product).",
                  },
                  quantity: { type: "number", description: "How many units to refund." },
                  restockType: {
                    type: "string",
                    enum: ["RETURN", "NO_RESTOCK", "CANCEL"],
                    description:
                      "What to do with the returned inventory: \"RETURN\" (restock), \"NO_RESTOCK\" (discard), \"CANCEL\" (no restock, adjusts fulfilment). Defaults to \"RETURN\".",
                  },
                },
                required: ["lineItemId", "quantity"],
                additionalProperties: false,
              },
              description:
                "Which line items to refund and in what quantity. When absent, Shopify suggests a full refund of all fulfilled line items.",
            },
            reason: {
              type: "string",
              description:
                "A plaintext human reason for the refund, shown to the approver and recorded on the audit log.",
            },
          },
          required: ["orderId"],
          additionalProperties: false,
        },
      },
      {
        name: "cancel_order",
        description:
          "Preview and execute order cancellation (two-phase). Cancellation is permanent — an order cannot be uncancelled — so every cancel plan ALWAYS requires human approval through the localhost approval UI, regardless of item count, and cancel_order can never be rolled back. The preview is a zero-write call that returns the refund implication and flags the human sees before granting or denying; execute applies the cancellation with the supplied restock and notifyCustomer flags.",
        inputSchema: {
          type: "object",
          properties: {
            orderId: {
              type: "string",
              description: "The order id in GID format (e.g. gid://shopify/Order/123).",
            },
            reason: {
              type: "string",
              enum: [...CANCEL_REASONS],
              description:
                "Why the order is being cancelled; recorded on the audit row and passed to the Shopify orderCancel mutation.",
            },
            restock: {
              type: "boolean",
              description: "Whether to return items to inventory (restockLineItems).",
            },
            notifyCustomer: {
              type: "boolean",
              description:
                "Whether to send an email notification to the customer (notifyCustomer).",
            },
          },
          required: ["orderId", "reason", "restock", "notifyCustomer"],
          additionalProperties: false,
        },
      },
      {
        name: "execute_plan",
        description:
          "Execute a previously previewed write (update_prices, update_inventory, create_discount, refund_order, or cancel_order). Pass back the exact plan_token and the exact manifest from the preview response. The token is single-use, expires, and refuses any manifest that does not fingerprint-match the preview; write plans also refuse when the current data drifted since the preview (STATE_CHANGED). Plans awaiting approval wait until a human approves or rejects them through the out-of-band localhost approval UI (never through this MCP tool set): an approval lets the plan execute, a rejection returns a structured PLAN_REJECTED error, and an expired plan returns a structured error telling you to re-preview.",
        inputSchema: {
          type: "object",
          properties: {
            plan_token: {
              type: "string",
              description: "The plan_token returned by the preview.",
            },
            manifest: {
              type: "object",
              description:
                "The exact manifest returned by the preview; must fingerprint-match the token's plan.",
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      ref: {
                        type: "string",
                        description: "Stable identifier of the item being changed.",
                      },
                      before: { description: "The item's state at preview time." },
                      after: { description: "The item's state after the change." },
                      payload: {
                        description: "Opaque per-item execution instructions.",
                      },
                    },
                    required: ["ref", "before", "after"],
                    additionalProperties: false,
                  },
                  description: "The manifest items from the preview response.",
                },
                digest: { type: "string", description: "The manifest digest from the preview response." },
                beforeDigest: {
                  type: "string",
                  description: "The ref-to-before digest from the preview response.",
                },
              },
              required: ["items", "digest", "beforeDigest"],
              additionalProperties: false,
            },
          },
          required: ["plan_token", "manifest"],
          additionalProperties: false,
        },
      },
      {
        name: "rollback_plan",
        description:
          "Undo a previously executed reversible plan (update_prices, update_inventory, or create_discount) in one call: restores each item to its previewed before-state by re-applying inverse mutations. Requires no approval — restoring prior state is the safe direction. Refused with ROLLBACK_UNSUPPORTED for non-reversible kinds (cancel_order, refund_order) or unknown tokens, and ROLLBACK_WINDOW_EXPIRED once the rollback window (plans.rollbackTtlMs, default 24 hours) has passed.",
        inputSchema: {
          type: "object",
          properties: {
            planToken: {
              type: "string",
              description: "The plan_token of an executed plan to undo.",
            },
          },
          required: ["planToken"],
          additionalProperties: false,
        },
      },
      // Deliberately no approve/reject tool here: approval must come from the
      // out-of-band localhost approval UI, never through this agent-facing MCP
      // surface — an agent must never be able to approve its own gated writes.
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};

    if (name === "search_products") {
      const parsed = searchProductsArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const result = await searchProducts(ctx.client, parsed.data, ctx.config);
        return text(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "list_orders") {
      const parsed = listOrdersArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const result = await listOrders(ctx.client, parsed.data);
        return text(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "update_prices") {
      const parsed = updatePricesArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const builder = new PriceManifestBuilder(ctx.client, parsed.data, ctx.config);
        const { manifest, maxPriceChangePct } = await builder.buildWithMaxPriceChangePct();
        const preview = await priceManager.preview(
          { build: () => Promise.resolve(manifest) },
          {
            tool: "update_prices",
            reason: parsed.data.reason ?? null,
            alwaysRequireApproval:
              maxPriceChangePct > ctx.config.plans.maxPriceChangePct,
          },
        );
        planKinds.set(preview.planToken, "update_prices");
        return previewResponse(preview, ctx.config, "update_prices");
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "update_inventory") {
      const parsed = updateInventoryArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const builder = new InventoryManifestBuilder(ctx.client, parsed.data, ctx.config);
        const manifest = await builder.build();
        for (const item of manifest.items) {
          inventoryLocationsByRef.set(item.ref, parsed.data.locationId);
        }
        const preview = await inventoryManager.preview(
          { build: () => Promise.resolve(manifest) },
          { tool: "update_inventory", reason: parsed.data.reason ?? null },
        );
        planKinds.set(preview.planToken, "update_inventory");
        return previewResponse(preview, ctx.config, "update_inventory");
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "create_discount") {
      const parsed = createDiscountArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const preview = await discountManager.preview(
          new DiscountManifestBuilder(ctx.client, parsed.data, ctx.config),
          { tool: "create_discount", reason: parsed.data.reason ?? null },
        );
        planKinds.set(preview.planToken, "create_discount");
        return previewResponse(preview, ctx.config, "create_discount");
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "refund_order") {
      const parsed = refundOrderArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const preview = await refundManager.preview(
          new RefundManifestBuilder(ctx.client, {
            ...parsed.data,
            reason: parsed.data.reason ?? "refund order",
          }),
          {
            tool: "refund_order",
            reason: parsed.data.reason ?? null,
            alwaysRequireApproval: true,
          },
        );
        planKinds.set(preview.planToken, "refund_order");
        return previewResponse(preview, ctx.config, "refund_order");
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "cancel_order") {
      const parsed = cancelOrderArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const result = await cancelOrder(
          ctx.client,
          ctx.planStore,
          ctx.audit,
          parsed.data,
          callerId,
        );
        planKinds.set(result.planToken, TOOL_CANCEL_ORDER);
        cancelArgs.set(result.planToken, parsed.data);
        return text(
          JSON.stringify(
            {
              status: result.status,
              plan_token: result.planToken,
              order_id: parsed.data.orderId,
              manifest: result.preview,
              message:
                "Cancelling an order always requires human approval through the localhost approval UI before it will execute. Call execute_plan with this plan_token and the exact manifest above to await the human's decision.",
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "execute_plan") {
      const parsed = executePlanArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const planToken = parsed.data.plan_token;
        const kind = planKinds.get(planToken);
        if (kind === undefined) {
          throw {
            code: "UNKNOWN_PLAN_TOKEN",
            message: `No plan matches token ${planToken} on this server.`,
            hint: "Plan tokens are only valid after a preview on this server; re-run the preview to obtain a fresh plan_token.",
          };
        }
        if (kind === TOOL_CANCEL_ORDER) {
          const cancelOrderArgsForToken = cancelArgs.get(planToken);
          if (cancelOrderArgsForToken === undefined) {
            throw {
              code: "UNKNOWN_PLAN_TOKEN",
              message: `No cancel_order plan matches token ${planToken} on this server.`,
              hint: "Re-run the cancel_order preview to obtain a fresh plan_token.",
            };
          }
          const result = await executeCancelOrder(
            ctx.client,
            ctx.planStore,
            ctx.audit,
            planToken,
            parsed.data.manifest as Manifest<CancelOrderManifestItem>,
            cancelOrderArgsForToken,
            callerId,
          );
          executedPlans.set(planToken, {
            kind: TOOL_CANCEL_ORDER,
            executedRefs: result.succeededCount > 0 ? [cancelOrderArgsForToken.orderId] : [],
          });
          return text(
            JSON.stringify(
              {
                status: "executed",
                order_id: result.orderId,
                order_name: result.orderName,
                succeeded_count: result.succeededCount,
                failed_count: result.failedCount,
              },
              null,
              2,
            ),
          );
        }
        const manager = managers.get(kind);
        if (manager === undefined) {
          throw {
            code: "UNKNOWN_PLAN_KIND",
            message: `No execution path is registered for plan kind "${kind}".`,
            hint: "This plan kind cannot be executed through execute_plan; re-run the operation to obtain a fresh plan_token.",
          };
        }
        const result = await manager.executePlan(
          planToken,
          parsed.data.manifest as Manifest<ManifestItem>,
        );
        executedPlans.set(planToken, {
          kind,
          executedRefs: result.ledger.succeeded.map((o) => o.ref),
        });
        return text(
          JSON.stringify(
            {
              status: "executed",
              item_count: result.itemCount,
              succeeded_count: result.succeededCount,
              failed_count: result.failedCount,
              refs: [...result.refs],
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorBody(err);
      }
    }

    if (name === "rollback_plan") {
      const parsed = rollbackPlanArgsSchema.safeParse(args);
      if (!parsed.success) return invalidArguments(parsed.error);
      try {
        const result = await rollbackPlan.rollback(parsed.data.planToken);
        return text(
          JSON.stringify(
            {
              status: result.status,
              item_count: result.itemCount,
              succeeded_count: result.succeededCount,
              failed_count: result.failedCount,
              refs: [...result.refs],
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorBody(err);
      }
    }

    return unknownToolError(name);
  });

  return server;
}

export async function startServer(ctx: ServerContext): Promise<void> {
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}