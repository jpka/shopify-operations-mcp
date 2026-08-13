/**
 * update_prices: two-phase bulk variant price-change tool.
 *
 * Previews planned price changes (pure reads, zero mutation), then executes
 * via the chunked `productVariantsBulkUpdate` Shopify mutation.  Protected-
 * tagged products are refused at preview time with PROTECTED_RESOURCE before
 * a token is issued. A plan where any single variant's price change exceeds
 * maxPriceChangePct forces awaiting_approval regardless of item count.
 */
import type { AdminClient } from "../graphql/adminClient.js";
import { chunk, DEFAULT_CHUNK_SIZE } from "../graphql/adminClient.js";
import type { AppConfig } from "../config.js";
import {
  assembleManifest,
  type Manifest,
  type ManifestBuilder,
  type ManifestItem,
  type StateReader,
} from "../plans/manifest.js";
import type { Executor, ItemOutcome } from "../plans/executor.js";

export const PROTECTED_RESOURCE_CODE = "PROTECTED_RESOURCE";

export type PriceTransformType = "set-absolute" | "adjust-percentage";

export interface UpdatePricesArgs {
  /**
   * Explicit variant IDs to update. Use when not filtering by vendor/tag.
   * Mutually exclusive with vendor/tag filters.
   */
  variantIds?: readonly string[];
  /**
   * Vendor filter: selects variants from products with this vendor.
   * Use with tag for AND filtering; alone for vendor-only filter.
   */
  vendor?: string;
  /**
   * Tag filter: selects variants from products with this tag.
   * Use with vendor for AND filtering; alone for tag-only filter.
   */
  tag?: string;
  /**
   * The price transform applied to every matched variant.
   */
  transform: PriceTransform;
}

export type PriceTransform =
  | { type: "set-absolute"; newPrice: number }
  | { type: "adjust-percentage"; percentage: number };

export interface PriceSnapshot {
  variantId: string;
  productId: string;
  title: string;
  price: string;
  tags: string[];
  vendor: string | null;
}

export interface PriceManifestItem
  extends ManifestItem<PriceSnapshot, PriceSnapshot, PriceManifestPayload> {
  ref: string;
  before: PriceSnapshot;
  after: PriceSnapshot;
  payload: PriceManifestPayload;
}

export interface PriceManifestPayload {
  variantId: string;
  price: string;
}

export interface PriceBuildResult {
  manifest: Manifest<PriceManifestItem>;
  maxPriceChangePct: number;
}

interface RawVariantNode {
  id: string;
  title: string;
  price: string;
  product: {
    id: string;
    vendor: string | null;
    tags: string[];
  } | null;
}

interface RawProductNode {
  id: string;
  vendor: string | null;
  tags: string[];
  variants: {
    edges: Array<{ node: RawVariantNode }>;
  };
}

const GET_VARIANTS_QUERY = /* GraphQL */ `
  query GetVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        price
        product {
          id
          vendor
          tags
        }
      }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = /* GraphQL */ `
  mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function parsePrice(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseFloat(value);
  return 0;
}

function formatPrice(value: number): string {
  return value.toFixed(2);
}

function calculateNewPrice(
  currentPrice: number,
  transform: PriceTransform,
): number {
  if (transform.type === "set-absolute") {
    return transform.newPrice;
  }
  return currentPrice * (1 + transform.percentage / 100);
}

function priceChangePct(currentPrice: number, newPrice: number): number {
  if (currentPrice === 0) return newPrice > 0 ? 100 : 0;
  return Math.round(Math.abs((newPrice - currentPrice) / currentPrice) * 100);
}

async function fetchVariantsByIds(
  client: AdminClient,
  variantIds: string[],
): Promise<Map<string, RawVariantNode>> {
  if (variantIds.length === 0) return new Map();

  const data = await client.graphql<{ nodes: RawVariantNode[] }>({
    query: GET_VARIANTS_QUERY,
    variables: { ids: variantIds },
    cost: variantIds.length,
  });

  const map = new Map<string, RawVariantNode>();
  for (const node of data.nodes) {
    if (node) map.set(node.id, node);
  }
  return map;
}

async function fetchVariantsBySearch(
  client: AdminClient,
  vendor?: string,
  tag?: string,
): Promise<RawVariantNode[]> {
  const terms: string[] = [];
  if (vendor) terms.push(`vendor:'${vendor}'`);
  if (tag) terms.push(`tag:'${tag}'`);
  const searchQuery = terms.join(" ");

  const SEARCH_QUERY = /* GraphQL */ `
    query SearchProductsForVariants($first: Int!, $cursor: String, $searchQuery: String) {
      products(first: $first, after: $cursor, query: $searchQuery) {
        edges {
          node {
            id
            vendor
            tags
            variants(first: 250) {
              edges {
                node {
                  id
                  title
                  price
                  product {
                    id
                    vendor
                    tags
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const { paginateConnection } = await import("../graphql/adminClient.js");
  const rawProducts = await paginateConnection<RawProductNode>(client, {
    query: SEARCH_QUERY,
    variables: { searchQuery },
    first: 50,
    path: "products",
  });

  const variants: RawVariantNode[] = [];
  for (const product of rawProducts) {
    for (const edge of product.variants.edges) {
      variants.push({
        ...edge.node,
        product: {
          id: product.id,
          vendor: product.vendor,
          tags: product.tags,
        },
      });
    }
  }
  return variants;
}

function assertNotProtected(
  variant: RawVariantNode,
  protectedTags: readonly string[],
): void {
  const tags = variant.product?.tags ?? [];
  const matched = protectedTags.filter((t) => tags.includes(t));
  if (matched.length > 0) {
    const hint =
      "Remove the protected tag from the product, or exclude this variant from the plan.";
    throw new ProtectedResourceError(variant.id, matched, hint);
  }
}

export class ProtectedResourceError extends Error {
  readonly code: string;
  readonly hint: string;

  constructor(variantId: string, matched: readonly string[], hint: string) {
    super(
      `Variant ${variantId} belongs to a product carrying protected tag(s): ${matched.join(", ")}. ` +
        `This plan is refused. ${hint}`,
    );
    this.name = "ProtectedResourceError";
    this.code = PROTECTED_RESOURCE_CODE;
    this.hint = hint;
  }
}

/**
 * Builds a price-change manifest by reading current variant prices and
 * validating protected-tag status. Performs zero mutation calls.
 */
export class PriceManifestBuilder implements ManifestBuilder<PriceManifestItem> {
  constructor(
    private client: AdminClient,
    private args: UpdatePricesArgs,
    private config: AppConfig,
  ) {}

  async build(): Promise<Manifest<PriceManifestItem>> {
    const result = await this.buildWithMaxPriceChangePct();
    return result.manifest;
  }

  /**
   * Builds the manifest and returns the maximum price-change percentage
   * detected across all variants. The tool layer uses this to decide
   * whether to set `alwaysRequireApproval` when calling `preview()`.
   */
  async buildWithMaxPriceChangePct(): Promise<PriceBuildResult> {
    let rawVariants: RawVariantNode[];

    if (this.args.variantIds !== undefined && this.args.variantIds.length > 0) {
      const variantMap = await fetchVariantsByIds(
        this.client,
        [...this.args.variantIds],
      );
      rawVariants = [...variantMap.values()];
      const foundIds = new Set(rawVariants.map((v) => v.id));
      const missing = this.args.variantIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new Error(
          `Variant(s) not found: ${missing.join(", ")}. ` +
            `Verify the variant ids are correct and exist in Shopify.`,
        );
      }
    } else {
      rawVariants = await fetchVariantsBySearch(
        this.client,
        this.args.vendor,
        this.args.tag,
      );
      if (rawVariants.length === 0) {
        throw new Error(
          `No variants found for the given criteria. ` +
            `Verify the vendor/tag filters match products in Shopify.`,
        );
      }
    }

    const manifestItems: PriceManifestItem[] = [];
    let maxPriceChangePct = 0;

    for (const variant of rawVariants) {
      assertNotProtected(variant, this.config.protectedTags);

      const currentPrice = parsePrice(variant.price);
      const newPrice = calculateNewPrice(currentPrice, this.args.transform);
      const changePct = priceChangePct(currentPrice, newPrice);
      if (changePct > maxPriceChangePct) {
        maxPriceChangePct = changePct;
      }

      manifestItems.push({
        ref: variant.id,
        before: {
          variantId: variant.id,
          productId: variant.product?.id ?? "",
          title: variant.title,
          price: variant.price,
          tags: variant.product?.tags ?? [],
          vendor: variant.product?.vendor ?? null,
        },
        after: {
          variantId: variant.id,
          productId: variant.product?.id ?? "",
          title: variant.title,
          price: formatPrice(newPrice),
          tags: variant.product?.tags ?? [],
          vendor: variant.product?.vendor ?? null,
        },
        payload: {
          variantId: variant.id,
          price: formatPrice(newPrice),
        },
      });
    }

    return {
      manifest: assembleManifest(manifestItems),
      maxPriceChangePct,
    };
  }
}

/**
 * Re-reads current variant prices at execute time for the STATE_CHANGED
 * drift check.
 */
export class PriceStateReader implements StateReader<PriceSnapshot> {
  constructor(private client: AdminClient) {}

  async readCurrent(
    refs: readonly string[],
  ): Promise<Readonly<Record<string, PriceSnapshot>>> {
    if (refs.length === 0) return {};

    const variantMap = await fetchVariantsByIds(this.client, [...refs]);
    const out: Record<string, PriceSnapshot> = {};

    for (const [id, variant] of variantMap) {
      out[id] = {
        variantId: variant.id,
        productId: variant.product?.id ?? "",
        title: variant.title,
        price: variant.price,
        tags: variant.product?.tags ?? [],
        vendor: variant.product?.vendor ?? null,
      };
    }
    return out;
  }
}

/**
 * Executes price changes via the `productVariantsBulkUpdate` Shopify mutation,
 * chunked into batches of `chunkSize` (default 50).
 */
export class PriceExecutor implements Executor<PriceManifestItem, void> {
  private readonly chunkSize: number;

  constructor(
    private client: AdminClient,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
  ) {
    this.chunkSize = chunkSize;
  }

  async execute(item: PriceManifestItem): Promise<ItemOutcome<void>> {
    return this.executeBatch([item]).then((b) => b[0]!);
  }

  private async executeBatch(
    items: readonly PriceManifestItem[],
  ): Promise<ItemOutcome<void>[]> {
    const ledger: ItemOutcome<void>[] = [];
    const batches = chunk(items, this.chunkSize);

    for (const batch of batches) {
      const byProduct = new Map<string, PriceManifestItem[]>();
      for (const item of batch) {
        const productId = item.before.productId;
        if (!byProduct.has(productId)) {
          byProduct.set(productId, []);
        }
        byProduct.get(productId)!.push(item);
      }

      for (const [productId, productItems] of byProduct) {
        const variantsInput = productItems.map((item) => ({
          id: item.payload.variantId,
          price: item.payload.price,
        }));

        try {
          const data = await this.client.graphql<{
            productVariantsBulkUpdate: {
              productVariants: Array<{ id: string; price: string }>;
              userErrors: Array<{ field: string[]; message: string }>;
            };
          }>({
            query: PRODUCT_VARIANTS_BULK_UPDATE_MUTATION,
            variables: { productId, variants: variantsInput },
            cost: productItems.length,
          });

          const result = data.productVariantsBulkUpdate;

          if (result.userErrors.length > 0) {
            for (const item of productItems) {
              ledger.push({
                ref: item.ref,
                ok: false,
                error: {
                  code: "SHOPIFY_USER_ERROR",
                  message: result.userErrors[0]!.message,
                  hint: `Field: ${result.userErrors[0]!.field.join(".")}`,
                },
              });
            }
            continue;
          }

          for (const item of productItems) {
            ledger.push({ ref: item.ref, ok: true });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          for (const item of productItems) {
            ledger.push({
              ref: item.ref,
              ok: false,
              error: { code: "SHOPIFY_API_ERROR", message },
            });
          }
        }
      }
    }

    return ledger;
  }
}
