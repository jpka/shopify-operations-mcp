import { describe, expect, it } from "vitest";
import {
  APPROVAL_TRIGGER_TAG,
  CUSTOMER_COUNT,
  DEFAULT_SEED,
  LOCATION_COUNT,
  ORDER_COUNT,
  PRODUCT_COUNT,
  SALE_TAG_EVERY_NTH_PRODUCT,
  SEED_MARKER_TAG,
  assertSizingInvariants,
  generateSeedPlan,
  mulberry32,
  seedCounts,
} from "../scripts/seed-data.ts";

const DEFAULT_THRESHOLDS = { hardMaxItems: 250, approvalRequiredAboveItems: 25 };

describe("mulberry32 seeded PRNG", () => {
  it("reproduces the same sequence for the same seed", () => {
    const draw = (seed: number) => Array.from({ length: 8 }, mulberry32(seed));
    expect(draw(DEFAULT_SEED)).toEqual(draw(DEFAULT_SEED));
  });

  it("produces different sequences for different seeds", () => {
    const draw = (seed: number) => Array.from({ length: 8 }, mulberry32(seed));
    expect(draw(DEFAULT_SEED)).not.toEqual(draw(DEFAULT_SEED + 1));
  });
});

describe("generateSeedPlan determinism", () => {
  it("produces an identical structure for the same seed", () => {
    expect(generateSeedPlan(DEFAULT_SEED)).toEqual(generateSeedPlan(DEFAULT_SEED));
  });

  it("produces a different structure for a different seed", () => {
    expect(generateSeedPlan(DEFAULT_SEED)).not.toEqual(
      generateSeedPlan(DEFAULT_SEED + 1),
    );
  });

  it("uses stable abstract IDs", () => {
    const plan = generateSeedPlan(DEFAULT_SEED);
    expect(plan.products[0]!.id).toBe("seed-product-0");
    expect(plan.products[0]!.variants[0]!.id).toBe("seed-variant-0");
    expect(plan.customers[0]!.id).toBe("seed-customer-0");
    expect(plan.orders[0]!.id).toBe("seed-order-0");
    expect(plan.products[0]!.handle).toBe("seeded-product-1");
  });

  it("tags every product, customer and order with the marker tag", () => {
    const plan = generateSeedPlan(DEFAULT_SEED);
    expect(plan.products.every((p) => p.tags.includes(SEED_MARKER_TAG))).toBe(true);
    expect(plan.customers.every((c) => c.tags.includes(SEED_MARKER_TAG))).toBe(true);
    expect(plan.orders.every((o) => o.tags.includes(SEED_MARKER_TAG))).toBe(true);
  });
});

describe("exact counts for the default seed", () => {
  const plan = generateSeedPlan(DEFAULT_SEED);

  it("produces the exact resource counts", () => {
    expect(seedCounts(plan)).toMatchObject({
      products: PRODUCT_COUNT,
      variants: 768,
      locations: LOCATION_COUNT,
      customers: CUSTOMER_COUNT,
      orders: ORDER_COUNT,
    });
  });

  it("produces the exact tag variant counts", () => {
    expect(seedCounts(plan).tagVariantCounts).toEqual({
      [SEED_MARKER_TAG]: 768,
      [APPROVAL_TRIGGER_TAG]: 156,
      featured: 163,
      clearance: 153,
      "new-arrival": 162,
      "gift-idea": 151,
      "best-seller": 139,
    });
  });

  it("covers exactly 60 products with the approval trigger tag", () => {
    const saleProducts = plan.products.filter((p) =>
      p.tags.includes(APPROVAL_TRIGGER_TAG),
    );
    expect(saleProducts).toHaveLength(
      Math.ceil(PRODUCT_COUNT / SALE_TAG_EVERY_NTH_PRODUCT),
    );
  });

  it("keeps every product within 1-4 variants and every order within 1-3 line items", () => {
    for (const product of plan.products) {
      expect(product.variants.length).toBeGreaterThanOrEqual(1);
      expect(product.variants.length).toBeLessThanOrEqual(4);
    }
    for (const order of plan.orders) {
      expect(order.lineItems.length).toBeGreaterThanOrEqual(1);
      expect(order.lineItems.length).toBeLessThanOrEqual(3);
    }
  });

  it("produces the exact order-state mix", () => {
    const paid = plan.orders.filter((o) => o.financialStatus === "PAID").length;
    const pending = plan.orders.filter((o) => o.financialStatus === "PENDING").length;
    const fulfilled = plan.orders.filter(
      (o) => o.fulfillmentStatus === "FULFILLED",
    ).length;
    const discounted = plan.orders.filter(
      (o) => o.discountAmountCents !== null,
    ).length;
    expect(paid).toBe(116);
    expect(pending).toBe(4);
    expect(fulfilled).toBe(40);
    expect(discounted).toBe(12);
  });
});

describe("sizing invariants", () => {
  it("holds for the default seed: full set > hardMaxItems, trigger tag in range", () => {
    const plan = generateSeedPlan(DEFAULT_SEED);
    const trigger = plan.tagVariantCounts[APPROVAL_TRIGGER_TAG] ?? 0;

    expect(plan.totalVariants).toBeGreaterThan(DEFAULT_THRESHOLDS.hardMaxItems);
    expect(trigger).toBeGreaterThanOrEqual(
      DEFAULT_THRESHOLDS.approvalRequiredAboveItems,
    );
    expect(trigger).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.hardMaxItems);
    expect(() => assertSizingInvariants(plan, DEFAULT_THRESHOLDS)).not.toThrow();
  });

  it("holds structurally for any seed (60 trigger-tag products x 1-4 variants)", () => {
    for (const seed of [1, 7, 42, 99, 1234, 4294967295]) {
      const plan = generateSeedPlan(seed);
      expect(() => assertSizingInvariants(plan, DEFAULT_THRESHOLDS)).not.toThrow();
    }
  });

  it("assertSizingInvariants throws when the full variant set no longer exceeds hardMaxItems", () => {
    const plan = generateSeedPlan(DEFAULT_SEED);
    expect(() =>
      assertSizingInvariants(plan, {
        hardMaxItems: 1_000,
        approvalRequiredAboveItems: 25,
      }),
    ).toThrow(/Sizing invariant violated/);
  });

  it("assertSizingInvariants throws when the trigger tag leaves the approval band", () => {
    const plan = generateSeedPlan(DEFAULT_SEED);
    expect(() =>
      assertSizingInvariants(plan, {
        hardMaxItems: 250,
        approvalRequiredAboveItems: 200,
      }),
    ).toThrow(/Sizing invariant violated/);
  });
});