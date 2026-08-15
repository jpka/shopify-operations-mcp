/**
 * Live integration suite: read tools (search_products, list_orders) against
 * the real Admin API and the seeded dev store (seed 42, `npm run seed`).
 *
 * Env-gated: skipped entirely (describe.skip) unless both
 * SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN are set, so `npm test` and
 * `npm run test:integration` pass as a no-op without credentials.
 *
 * Product counts are exact seed-42 constants (products only move on a
 * re-seed). Order counts are asserted as tolerant bands: the destructive
 * cancel/refund suite in this directory consumes paid/unfulfilled orders, so
 * a store that has already been exercised once will have fewer of them. A
 * freshly seeded store reports exactly 116 paid and 80 unfulfilled.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { SEED_MARKER_TAG } from "../../scripts/seed-data.js";
import { listOrders } from "../../src/tools/listOrders.js";
import { searchProducts } from "../../src/tools/searchProducts.js";
import {
  buildFixture,
  integrationEnabled,
  type IntegrationFixture,
} from "./helpers.js";

const enabled = integrationEnabled();
if (!enabled) {
  console.warn(
    "[integration:readTools] SKIPPED — set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN and run `npm run seed` first.",
  );
}
const describeSuite = enabled ? describe : describe.skip;

describeSuite("integration: read tools against the seeded dev store", () => {
  let fx: IntegrationFixture;

  beforeAll(() => {
    fx = buildFixture();
  });

  it("search_products by vendor returns a real subset of the 300 seeded products", async () => {
    const result = await searchProducts(fx.client, { vendor: "Northwind Supply" }, fx.config);

    expect(result.count).toBeGreaterThan(0);
    expect(result.count).toBeLessThan(300);
    for (const product of result.products) {
      expect(product.vendor).toBe("Northwind Supply");
      expect(product.tags).toContain(SEED_MARKER_TAG);
      expect(product.id).toMatch(/^gid:\/\/shopify\/Product\//);
    }
  });

  it("search_products by the seeded-store tag returns all 300 seeded products", async () => {
    const result = await searchProducts(fx.client, { tag: SEED_MARKER_TAG }, fx.config);

    expect(result.count).toBe(300);
    expect(result.products).toHaveLength(300);
  });

  it("search_products by exact sku resolves to the single product carrying that variant", async () => {
    const result = await searchProducts(fx.client, { sku: "SEED-1-1" }, fx.config);

    expect(result.count).toBe(1);
    const variant = result.products[0]!.variants.find((v) => v.sku === "SEED-1-1");
    expect(variant).toBeDefined();
    expect(variant!.id).toMatch(/^gid:\/\/shopify\/ProductVariant\//);
    expect(variant!.inventoryItemId).toMatch(/^gid:\/\/shopify\/InventoryItem\//);
    expect(variant!.price).toMatch(/^\d+\.\d{2}$/);
    // the seeder stocks every variant at both locations
    expect(variant!.inventoryLevels).toHaveLength(2);
  });

  it("search_products by exact title finds the seeded product", async () => {
    const result = await searchProducts(fx.client, { title: "Seeded Product 1" }, fx.config);

    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.products.some((p) => p.title === "Seeded Product 1")).toBe(true);
  });

  it("search_products flags seeded products as unprotected (no protected-tag annotation)", async () => {
    const result = await searchProducts(fx.client, { tag: SEED_MARKER_TAG, first: 50 }, fx.config);

    expect(result.products.length).toBeGreaterThan(0);
    for (const product of result.products) {
      expect(product.flags.protected).toBe(false);
      expect(product.flags.protectedTags).toEqual([]);
      for (const variant of product.variants) {
        expect(variant.flags.protected).toBe(false);
      }
    }
  });

  it("list_orders financial_status:paid returns the paid seeded orders (116 fresh, tolerant otherwise)", async () => {
    const result = await listOrders(fx.client, { financialStatus: "paid" });

    expect(result.orders.length).toBeGreaterThanOrEqual(112);
    expect(result.orders.length).toBeLessThanOrEqual(116);
    for (const order of result.orders) {
      expect(order.financialStatus).toBe("paid");
      expect(order.id).toMatch(/^gid:\/\/shopify\/Order\//);
      expect(order.name).toBeTruthy();
      expect(order.totalPrice).toMatch(/^\d+\.\d{2}$/);
      expect(order.lineItems.length).toBeGreaterThan(0);
    }
  });

  it("list_orders fulfillment_status:unfulfilled returns the unfulfilled seeded orders (80 fresh, tolerant otherwise)", async () => {
    const result = await listOrders(fx.client, { fulfillmentStatus: "unfulfilled" });

    expect(result.orders.length).toBeGreaterThanOrEqual(76);
    expect(result.orders.length).toBeLessThanOrEqual(80);
    for (const order of result.orders) {
      expect(order.fulfillmentStatus).toBe("unfulfilled");
    }
  });

  it("list_orders combines financial and fulfillment filters into one query", async () => {
    const result = await listOrders(fx.client, {
      financialStatus: "paid",
      fulfillmentStatus: "unfulfilled",
    });

    expect(result.orders.length).toBeGreaterThan(0);
    expect(result.orders.length).toBeLessThan(116);
    for (const order of result.orders) {
      expect(order.financialStatus).toBe("paid");
      expect(order.fulfillmentStatus).toBe("unfulfilled");
    }
  });
});