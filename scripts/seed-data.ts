/**
 * Deterministic data generation for the dev-store seeder
 * (scripts/seed-store.ts).
 *
 * The generator is pure: given a seed it produces the full data model —
 * products with variants, customers, and orders — with no network or
 * filesystem access. It is separated from the API layer so the exact counts,
 * IDs and structures can be unit-tested without a Shopify store. Every number
 * is reproducible run-to-run for the same seed via the mulberry32 PRNG.
 */

export const DEFAULT_SEED = 42;
/** Marker tag carried by every resource this seeder creates. */
export const SEED_MARKER_TAG = "seeded-store";
/**
 * The designated single tag used to exercise approval-threshold reprices: a
 * reprice of just this tag's variants must trip `approvalRequiredAboveItems`
 * without tripping `hardMaxItems`.
 */
export const APPROVAL_TRIGGER_TAG = "sale";

export const PRODUCT_COUNT = 300;
export const CUSTOMER_COUNT = 20;
export const ORDER_COUNT = 120;
export const LOCATION_COUNT = 2;
export const MIN_VARIANTS_PER_PRODUCT = 1;
export const MAX_VARIANTS_PER_PRODUCT = 4;
/**
 * Every Nth product (index 0, 5, 10, …) carries APPROVAL_TRIGGER_TAG. With
 * 1-4 variants per product this structurally bounds the tag's variant count to
 * [PRODUCT_COUNT / N, (PRODUCT_COUNT / N) * MAX_VARIANTS_PER_PRODUCT] = [60,
 * 240] — inside [approvalRequiredAboveItems, hardMaxItems] at default 25/250.
 */
export const SALE_TAG_EVERY_NTH_PRODUCT = 5;

const VENDORS = [
  "Northwind Supply",
  "Aurora Goods",
  "Cascade Trading",
  "Meridian House",
  "Ironclad",
  "Harbor & Pine",
  "Vertex Outfitters",
  "Golden Bay",
] as const;

const PRODUCT_TYPES = [
  "Apparel",
  "Footwear",
  "Accessories",
  "Home Goods",
  "Outdoor Gear",
  "Electronics",
  "Kitchen",
  "Fitness",
] as const;

const SECONDARY_TAGS = [
  "clearance",
  "new-arrival",
  "featured",
  "best-seller",
  "gift-idea",
] as const;

const FIRST_NAMES = [
  "Avery",
  "Jordan",
  "Morgan",
  "Riley",
  "Casey",
  "Taylor",
  "Skyler",
  "Quinn",
  "Reese",
  "Drew",
  "Harper",
  "Rowan",
  "Finley",
  "Emerson",
  "Parker",
  "Dakota",
  "Sawyer",
  "Elliot",
  "Camden",
  "Blake",
] as const;

const LAST_NAMES = [
  "Anderson",
  "Beck",
  "Chen",
  "Davis",
  "Ellis",
  "Foster",
  "Garcia",
  "Hayes",
  "Iverson",
  "Jensen",
  "Kim",
  "Larson",
  "Mercer",
  "Nguyen",
  "Okafor",
  "Patel",
  "Quinn",
  "Reed",
  "Sanchez",
  "Turner",
] as const;

/**
 * mulberry32: a small, fast, seeded PRNG returning floats in [0, 1). Seeded
 * with a 32-bit unsigned integer, it produces the same sequence for the same
 * seed on any engine — the determinism guarantee the seeder is built on.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One generated variant. `globalIndex` is its position across all products. */
export interface SeedVariant {
  id: string;
  globalIndex: number;
  productIndex: number;
  variantIndex: number;
  /** Human-facing title; also the "Title" option value in Shopify. */
  title: string;
  sku: string;
  /** Price in cents; e.g. 1999 means $19.99. */
  priceCents: number;
  /** Stock at each of the LOCATION_COUNT locations, in plan order. */
  stock: number[];
}

export interface SeedProduct {
  index: number;
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string[];
  variants: SeedVariant[];
}

export interface SeedCustomer {
  index: number;
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  tags: string[];
}

export interface SeedOrderLineItem {
  /** Global variant index (SeedVariant.globalIndex) the line refers to. */
  variantIndex: number;
  quantity: number;
}

export type SeedOrderFinancialStatus = "PAID" | "PENDING";
export type SeedOrderFulfillmentStatus = "FULFILLED" | "UNFULFILLED";

export interface SeedOrder {
  index: number;
  id: string;
  customerIndex: number;
  lineItems: SeedOrderLineItem[];
  financialStatus: SeedOrderFinancialStatus;
  fulfillmentStatus: SeedOrderFulfillmentStatus;
  /** Fixed-amount order discount in cents; null when the order is undiscounted. */
  discountAmountCents: number | null;
  tags: string[];
}

export interface SeedPlan {
  seed: number;
  products: SeedProduct[];
  customers: SeedCustomer[];
  orders: SeedOrder[];
  /** Total number of variants across all products. */
  totalVariants: number;
  /** Variant count per tag: how many variants a tag-scoped reprice touches. */
  tagVariantCounts: Record<string, number>;
}

/**
 * Generates the full deterministic store plan for a seed. The order of PRNG
 * draws is fixed: products (variant counts, vendors, types, prices, stock),
 * then customers, then orders. Never change the draw sequence without
 * re-recording the expected counts in tests/seed-store.test.ts.
 */
export function generateSeedPlan(seed: number): SeedPlan {
  const rand = mulberry32(seed);
  const products: SeedProduct[] = [];
  let globalVariantIndex = 0;

  for (let i = 0; i < PRODUCT_COUNT; i++) {
    const variantCount =
      MIN_VARIANTS_PER_PRODUCT +
      Math.floor(rand() * MAX_VARIANTS_PER_PRODUCT);

    const tags = [SEED_MARKER_TAG];
    if (i % SALE_TAG_EVERY_NTH_PRODUCT === 0) tags.push(APPROVAL_TRIGGER_TAG);
    tags.push(SECONDARY_TAGS[Math.floor(rand() * SECONDARY_TAGS.length)]!);

    const title = `Seeded Product ${i + 1}`;
    const product: SeedProduct = {
      index: i,
      id: `seed-product-${i}`,
      title,
      handle: `seeded-product-${i + 1}`,
      vendor: VENDORS[Math.floor(rand() * VENDORS.length)]!,
      productType: PRODUCT_TYPES[Math.floor(rand() * PRODUCT_TYPES.length)]!,
      tags,
      variants: [],
    };

    for (let j = 0; j < variantCount; j++) {
      product.variants.push({
        id: `seed-variant-${globalVariantIndex}`,
        globalIndex: globalVariantIndex,
        productIndex: i,
        variantIndex: j,
        title: j === 0 ? "Default Title" : `Variant ${j + 1}`,
        sku: `SEED-${i + 1}-${j + 1}`,
        priceCents: 500 + Math.floor(rand() * 29501),
        stock: Array.from({ length: LOCATION_COUNT }, () =>
          Math.floor(rand() * 100),
        ),
      });
      globalVariantIndex++;
    }
    products.push(product);
  }
  const totalVariants = globalVariantIndex;

  const customers: SeedCustomer[] = Array.from(
    { length: CUSTOMER_COUNT },
    (_, i) => ({
      index: i,
      id: `seed-customer-${i}`,
      firstName: FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)]!,
      lastName: LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)]!,
      email: `seed-customer-${i}@example.com`,
      tags: [SEED_MARKER_TAG],
    }),
  );

  const orders: SeedOrder[] = Array.from({ length: ORDER_COUNT }, (_, i) => {
    const discounted = i % 10 === 0;
    const lineItemCount = 1 + Math.floor(rand() * 3);
    const lineItems: SeedOrderLineItem[] = Array.from(
      { length: lineItemCount },
      () => ({
        variantIndex: Math.floor(rand() * totalVariants),
        quantity: 1 + Math.floor(rand() * 3),
      }),
    );
    return {
      index: i,
      id: `seed-order-${i}`,
      customerIndex: i % CUSTOMER_COUNT,
      lineItems,
      financialStatus:
        discounted || i % 15 !== 0 ? "PAID" : "PENDING",
      fulfillmentStatus: i % 3 === 0 ? "FULFILLED" : "UNFULFILLED",
      discountAmountCents: discounted ? 100 + Math.floor(rand() * 900) : null,
      tags: [SEED_MARKER_TAG],
    };
  });

  const tagVariantCounts: Record<string, number> = {};
  for (const product of products) {
    for (const tag of product.tags) {
      tagVariantCounts[tag] =
        (tagVariantCounts[tag] ?? 0) + product.variants.length;
    }
  }

  return { seed, products, customers, orders, totalVariants, tagVariantCounts };
}

/** The exact counts a plan produces — the numbers a human diffs across runs. */
export interface SeedCounts {
  products: number;
  variants: number;
  locations: number;
  customers: number;
  orders: number;
  /** Tag → number of variants that tag-scoped reprice touches. */
  tagVariantCounts: Record<string, number>;
}

export function seedCounts(plan: SeedPlan): SeedCounts {
  return {
    products: plan.products.length,
    variants: plan.totalVariants,
    locations: LOCATION_COUNT,
    customers: plan.customers.length,
    orders: plan.orders.length,
    tagVariantCounts: { ...plan.tagVariantCounts },
  };
}

export interface SizingThresholds {
  hardMaxItems: number;
  approvalRequiredAboveItems: number;
}

/**
 * The sizing invariants the seeder is designed around: the full variant set
 * must exceed `hardMaxItems` (so a store-wide reprice is refused) and the
 * APPROVAL_TRIGGER_TAG set must be within [approvalRequiredAboveItems,
 * hardMaxItems] (so a single-tag reprice requests approval but is not
 * refused). Throws when a plan violates either, so a mis-sized seed fails
 * fast before any API call.
 */
export function assertSizingInvariants(
  plan: SeedPlan,
  thresholds: SizingThresholds,
): void {
  const full = plan.totalVariants;
  const trigger = plan.tagVariantCounts[APPROVAL_TRIGGER_TAG] ?? 0;

  if (!(full > thresholds.hardMaxItems)) {
    throw new Error(
      `Sizing invariant violated: full variant set is ${full}, must exceed ` +
        `hardMaxItems (${thresholds.hardMaxItems}) so a store-wide reprice is refused.`,
    );
  }
  if (!(trigger >= thresholds.approvalRequiredAboveItems && trigger <= thresholds.hardMaxItems)) {
    throw new Error(
      `Sizing invariant violated: ${APPROVAL_TRIGGER_TAG} tag covers ${trigger} ` +
        `variants, must be within [approvalRequiredAboveItems ` +
        `(${thresholds.approvalRequiredAboveItems}), hardMaxItems ` +
        `(${thresholds.hardMaxItems})] so a single-tag reprice requests approval ` +
        `without being refused.`,
    );
  }
}