import type { AppConfig } from "../config.js";
import type { AdminClient } from "../graphql/adminClient.js";
import { paginateConnection } from "../graphql/adminClient.js";

/** Default page size for the internal cursor walk. Deliberately smaller than
 * the client's 250 so a search feels snappier and cost stays low. */
export const DEFAULT_SEARCH_PAGE_SIZE = 50;

/**
 * Upper bound for the cursor-walk page size. The nested
 * `variants(first: ...)` × `inventoryLevels(first: ...)` selections multiply
 * the Admin API's per-query cost, so a page larger than this would exceed the
 * 1000-credit single-query limit even with the reduced nested caps.
 */
export const MAX_SEARCH_PAGE_SIZE = 50;

export interface SearchProductsArgs {
  /** Matches products whose title contains the term (Shopify fuzzy search). */
  title?: string;
  /** Matches products with a variant whose SKU equals the term. */
  sku?: string;
  /** Matches products from this vendor. */
  vendor?: string;
  /** Matches products carrying this tag. */
  tag?: string;
  /**
   * Page size passed to the Admin API as `$first` while walking cursors.
   * Default DEFAULT_SEARCH_PAGE_SIZE.
   */
  first?: number;
}

/**
 * Protected-tag annotation, attached to every product and variant in the
 * output. A read tool must not hide protected items — it flags them so a
 * later write plan that touches them is refused by the config invariant.
 */
export interface ProtectedFlags {
  /** True when the item carries at least one configured protected tag. */
  protected: boolean;
  /** The configured protected tags the item carries (empty when safe). */
  protectedTags: string[];
}

export interface InventoryLevelRef {
  /** gid://shopify/InventoryLevel/… */
  id: string;
  /** Units available at the location. */
  available: number;
  locationId: string;
  locationName: string;
}

export interface VariantRef {
  id: string;
  sku: string | null;
  /** String price as Shopify stores it, e.g. "19.99". */
  price: string;
  /** gid://shopify/InventoryItem/… — the handle later write tools update. */
  inventoryItemId: string;
  /** Current per-location inventory references. */
  inventoryLevels: InventoryLevelRef[];
  /** False when the inventoryLevels array was truncated (more levels exist). */
  inventoryLevelsComplete: boolean;
  flags: ProtectedFlags;
}

export interface ProductRef {
  id: string;
  title: string;
  vendor: string | null;
  tags: string[];
  variants: VariantRef[];
  /** False when the variants array was truncated (more variants exist). */
  variantsComplete: boolean;
  flags: ProtectedFlags;
}

export interface SearchProductsResult {
  products: ProductRef[];
  count: number;
  /** Page size used for the internal cursor walk. */
  first: number;
}

interface RawInventoryLevelNode {
  id: string;
  /** Per-name inventory quantities; "available" holds the sellable count. */
  quantities: Array<{ name: string; quantity: number }>;
  location: { id: string; name: string };
}

interface RawVariantNode {
  id: string;
  sku: string | null;
  price: string;
  inventoryItem: {
    id: string;
    inventoryLevels: {
      edges: Array<{ node: RawInventoryLevelNode }>;
      pageInfo?: { hasNextPage: boolean } | null;
    };
  };
}

interface RawProductNode {
  id: string;
  title: string;
  vendor: string | null;
  tags: string[];
  variants: {
    edges: Array<{ node: RawVariantNode }>;
    pageInfo?: { hasNextPage: boolean } | null;
  };
}

/**
 * Query the products connection via `paginateConnection`, so it must select
 * the connection at the root with `$first`/`$cursor` and a search term bound
 * to the nullable `$searchQuery` variable that the caller merges in.
 * Variants and inventory levels are plain (non-cursor) connections with an
 * explicit `first: 250` cap; the Admin API defaults both to 250 anyway.
 */
const SEARCH_PRODUCTS_QUERY = /* GraphQL */ `
  query SearchProducts($first: Int!, $cursor: String, $searchQuery: String) {
    products(first: $first, after: $cursor, query: $searchQuery) {
      edges {
        node {
          id
          title
          vendor
          tags
          variants(first: 50) {
            edges {
              node {
                id
                sku
                price
                inventoryItem {
                  id
                  inventoryLevels(first: 10) {
                    edges {
                      node {
                        id
                        quantities(names: ["available"]) {
                          name
                          quantity
                        }
                        location {
                          id
                          name
                        }
                      }
                    }
                    pageInfo {
                      hasNextPage
                    }
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
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

/**
 * Builds the Shopify Admin search string for the `products(query:)` argument
 * from the provided filters. Terms are ANDed (space-separated) and quoted so
 * values containing spaces match as one token. Empty-string filters are
 * dropped; an empty result means "no filter" (returns every product).
 */
export function buildProductSearchQuery(args: SearchProductsArgs): string {
  const terms: string[] = [];
  if (args.title !== undefined && args.title !== "") terms.push(`title:'${args.title}'`);
  if (args.sku !== undefined && args.sku !== "") terms.push(`sku:'${args.sku}'`);
  if (args.vendor !== undefined && args.vendor !== "") terms.push(`vendor:'${args.vendor}'`);
  if (args.tag !== undefined && args.tag !== "") terms.push(`tag:'${args.tag}'`);
  return terms.join(" ");
}

function protectedFlags(
  tags: readonly string[],
  protectedTags: readonly string[],
): ProtectedFlags {
  const matched = protectedTags.filter((tag) => tags.includes(tag));
  return { protected: matched.length > 0, protectedTags: matched };
}

/**
 * Extracts the sellable ("available") quantity from an inventory level's
 * per-name quantities. Since the API removed the flat `available` field on
 * InventoryLevel, the query selects `quantities { name quantity }`.
 */
function availableOf(
  quantities: Array<{ name: string; quantity: number }>,
): number {
  return quantities.find((q) => q.name === "available")?.quantity ?? 0;
}

function toVariantRef(raw: RawVariantNode, flags: ProtectedFlags): VariantRef {
  const inventoryLevelsComplete = !(raw.inventoryItem.inventoryLevels.pageInfo?.hasNextPage ?? false);
  return {
    id: raw.id,
    sku: raw.sku,
    price: raw.price,
    inventoryItemId: raw.inventoryItem.id,
    inventoryLevels: raw.inventoryItem.inventoryLevels.edges.map(({ node }) => ({
      id: node.id,
      available: availableOf(node.quantities),
      locationId: node.location.id,
      locationName: node.location.name,
    })),
    inventoryLevelsComplete,
    flags,
  };
}

function toProductRef(raw: RawProductNode, protectedTags: readonly string[]): ProductRef {
  const flags = protectedFlags(raw.tags, protectedTags);
  const variantsComplete = !(raw.variants.pageInfo?.hasNextPage ?? false);
  return {
    id: raw.id,
    title: raw.title,
    vendor: raw.vendor,
    tags: raw.tags,
    variants: raw.variants.edges.map(({ node }) => toVariantRef(node, flags)),
    variantsComplete,
    flags,
  };
}

/**
 * Search read tool. Reads only: composes a Shopify search string from the
 * filters, walks the cursor-paginated `products` connection to completion via
 * `paginateConnection`, and maps each product to a shape that exposes variant
 * pricing and per-location inventory references alongside a protected-tag
 * flag. Protected items are returned, never filtered out — a read tool only
 * annotates them.
 */
export async function searchProducts(
  client: AdminClient,
  args: SearchProductsArgs,
  config: AppConfig,
): Promise<SearchProductsResult> {
  const first = Math.min(
    args.first ?? DEFAULT_SEARCH_PAGE_SIZE,
    MAX_SEARCH_PAGE_SIZE,
  );
  const searchQuery = buildProductSearchQuery(args);
  const rawProducts = await paginateConnection<RawProductNode>(client, {
    query: SEARCH_PRODUCTS_QUERY,
    variables: { searchQuery },
    first,
    path: "products",
  });
  const products = rawProducts.map((raw) => toProductRef(raw, config.protectedTags));
  return { products, count: products.length, first };
}