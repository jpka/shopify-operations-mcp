import { describe, expect, it } from "vitest";
import type { AppConfig, ShopifyConfig } from "../../src/config.ts";
import { AdminClient } from "../../src/graphql/adminClient.ts";
import type {
  AdminClientOptions,
  GraphQLResponse,
} from "../../src/graphql/adminClient.ts";
import {
  buildProductSearchQuery,
  searchProducts,
} from "../../src/tools/searchProducts.ts";

type FetchLike = NonNullable<AdminClientOptions["fetch"]>;

function shopifyConfig(overrides: Partial<ShopifyConfig> = {}): ShopifyConfig {
  return {
    storeDomain: "test.myshopify.com",
    apiVersion: "2026-04",
    adminToken: "shpat_testtoken123",
    ...overrides,
  };
}

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    shopify: shopifyConfig(),
    plans: {
      planTtlMs: 60_000,
      approvalRequiredAboveItems: 25,
      hardMaxItems: 250,
      maxPriceChangePct: 30,
      rollbackTtlMs: 86_400_000,
    },
    approvalServer: { enabled: true, port: 4319 },
    protectedTags: ["do-not-touch"],
    callerId: "unknown",
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RawVariant {
  id: string;
  sku: string | null;
  price: string;
  inventoryItem: {
    id: string;
    inventoryLevels: {
      edges: Array<{
        node: {
          id: string;
          quantities: Array<{ name: string; quantity: number }>;
          location: { id: string; name: string };
        };
      }>;
    };
  };
}

interface RawProduct {
  id: string;
  title: string;
  vendor: string | null;
  tags: string[];
  variants: { edges: Array<{ node: RawVariant }> };
}

function rawVariant(
  id: number,
  sku: string,
  price: string,
  levels: Array<{ available: number; location: { id: string; name: string } }>,
): { node: RawVariant } {
  return {
    node: {
      id: `gid://shopify/ProductVariant/${id}`,
      sku,
      price,
      inventoryItem: {
        id: `gid://shopify/InventoryItem/${id}`,
        inventoryLevels: {
          edges: levels.map((level, i) => ({
            node: {
              id: `gid://shopify/InventoryLevel/${id}_${i}`,
              quantities: [{ name: "available", quantity: level.available }],
              location: level.location,
            },
          })),
        },
      },
    },
  };
}

function rawProduct(
  id: number,
  title: string,
  opts: { vendor?: string | null; tags?: string[]; variants?: Array<{ node: RawVariant }> } = {},
): RawProduct {
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    vendor: opts.vendor ?? "Acme",
    tags: opts.tags ?? [],
    variants: {
      edges: opts.variants ?? [rawVariant(id, `SKU-${id}`, "19.99", [])],
    },
  };
}

/** Fake fetch that answers products pages selected by the `cursor` variable. */
function productPaginator(pages: RawProduct[][]) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const fetchImpl: FetchLike = async (_input, init) => {
    const raw = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    calls.push({ query: raw.query, variables: raw.variables });
    const variables = raw.variables ?? {};
    const cursor = variables.cursor ?? null;
    const pageIndex = pages.findIndex((_p, i) => {
      const prev = i === 0 ? null : `page${i}`;
      return prev === cursor;
    });
    const idx = pageIndex === -1 ? pages.length - 1 : pageIndex;
    const page = pages[idx]!;
    const hasNextPage = idx < pages.length - 1;
    return jsonResponse({
      data: {
        products: {
          edges: page.map((node) => ({ node })),
          pageInfo: {
            hasNextPage,
            endCursor: hasNextPage ? `page${idx + 1}` : null,
          },
        },
      },
    });
  };
  return { fetchImpl, calls };
}

function buildClient(fetchImpl: FetchLike): AdminClient {
  return new AdminClient(shopifyConfig(), { fetch: fetchImpl });
}

describe("searchProducts (ticket #7)", () => {
  it("returns every product across cursor pages until hasNextPage is false", async () => {
    const page1 = [rawProduct(1, "Tea"), rawProduct(2, "Mug")];
    const page2 = [rawProduct(3, "Kettle")];
    const { fetchImpl, calls } = productPaginator([page1, page2]);
    const client = buildClient(fetchImpl);

    const result = await searchProducts(client, { first: 2 }, appConfig());

    expect(result.count).toBe(3);
    expect(result.first).toBe(2);
    expect(result.products.map((p) => p.title)).toEqual(["Tea", "Mug", "Kettle"]);
    expect(calls.length).toBe(2);
    expect(calls[0]!.variables).toMatchObject({ first: 2, cursor: null });
    expect(calls[1]!.variables).toMatchObject({ cursor: "page1" });
    // every page carries the same merged search variable
    expect(calls[0]!.variables).toHaveProperty("searchQuery");
    expect(calls[1]!.variables).toHaveProperty("searchQuery");
  });

  it("composes title, sku, vendor and tag filters into the search query argument", async () => {
    const { fetchImpl, calls } = productPaginator([[rawProduct(1, "Tea")]]);
    const client = buildClient(fetchImpl);

    await searchProducts(
      client,
      { title: "Loose Leaf", sku: "T-100", vendor: "Acme", tag: "organic" },
      appConfig(),
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.variables).toMatchObject({
      searchQuery: "title:'Loose Leaf' sku:'T-100' vendor:'Acme' tag:'organic'",
    });
  });

  it("drops empty filters and reads everything when none are given", async () => {
    const { fetchImpl, calls } = productPaginator([[rawProduct(1, "Tea")]]);
    const client = buildClient(fetchImpl);

    await searchProducts(client, { title: "", sku: "", vendor: "Acme", tag: undefined }, appConfig());

    expect(calls[0]!.variables).toMatchObject({ searchQuery: "vendor:'Acme'" });
  });

  it("sends a GraphQL query selecting the products connection for pagination", async () => {
    const { fetchImpl, calls } = productPaginator([[rawProduct(1, "Tea")]]);
    const client = buildClient(fetchImpl);

    await searchProducts(client, {}, appConfig());

    expect(calls[0]!.query).toContain("products(first: $first, after: $cursor");
    expect(calls[0]!.query).toContain("pageInfo {");
  });

  it("maps variant pricing and per-location inventory references", async () => {
    const product = rawProduct(1, "Tea", {
      variants: [
        rawVariant(11, "T-L", "12.50", [
          { available: 4, location: { id: "gid://shopify/Location/1", name: "Main" } },
          { available: 0, location: { id: "gid://shopify/Location/2", name: "Annex" } },
        ]),
        rawVariant(12, "T-M", "15.00", []),
      ],
    });
    const { fetchImpl } = productPaginator([[product]]);
    const client = buildClient(fetchImpl);

    const result = await searchProducts(client, {}, appConfig());
    const [first, second] = result.products[0]!.variants;

    expect(first).toEqual({
      id: "gid://shopify/ProductVariant/11",
      sku: "T-L",
      price: "12.50",
      inventoryItemId: "gid://shopify/InventoryItem/11",
      inventoryLevels: [
        { id: "gid://shopify/InventoryLevel/11_0", available: 4, locationId: "gid://shopify/Location/1", locationName: "Main" },
        { id: "gid://shopify/InventoryLevel/11_1", available: 0, locationId: "gid://shopify/Location/2", locationName: "Annex" },
      ],
      flags: { protected: false, protectedTags: [] },
    });
    expect(second!.inventoryLevels).toEqual([]);
  });

  it("annotates products and variants carrying a protected tag without filtering them out", async () => {
    const protectedProduct = rawProduct(1, "VIP Product", {
      tags: ["do-not-touch", "sale"],
      variants: [rawVariant(11, "VIP-1", "99.00", [])],
    });
    const safeProduct = rawProduct(2, "Normal Product", {
      tags: ["sale"],
      variants: [rawVariant(12, "N-1", "5.00", [])],
    });
    const { fetchImpl } = productPaginator([[protectedProduct, safeProduct]]);
    const client = buildClient(fetchImpl);

    const result = await searchProducts(client, {}, appConfig());

    const [flagged, safe] = result.products;
    expect(result.count).toBe(2);
    expect(flagged!.flags).toEqual({ protected: true, protectedTags: ["do-not-touch"] });
    expect(flagged!.variants[0]!.flags).toEqual({
      protected: true,
      protectedTags: ["do-not-touch"],
    });
    expect(safe!.flags).toEqual({ protected: false, protectedTags: [] });
    expect(safe!.variants[0]!.flags).toEqual({ protected: false, protectedTags: [] });
  });

  it("honors a custom protectedTags config for annotation", async () => {
    const product = rawProduct(1, "Managed", { tags: ["fragile"] });
    const { fetchImpl } = productPaginator([[product]]);
    const client = buildClient(fetchImpl);

    const result = await searchProducts(
      client,
      {},
      appConfig({ protectedTags: ["fragile"] }),
    );

    expect(result.products[0]!.flags).toEqual({
      protected: true,
      protectedTags: ["fragile"],
    });
  });
});

describe("buildProductSearchQuery (ticket #7)", () => {
  it("returns an empty string with no filters and quotes values with spaces", () => {
    expect(buildProductSearchQuery({})).toBe("");
    expect(buildProductSearchQuery({ title: "Loose Leaf" })).toBe("title:'Loose Leaf'");
  });

  it("ANDs multiple filters in a stable order", () => {
    expect(
      buildProductSearchQuery({ title: "Tea", sku: "T-100", vendor: "Acme", tag: "organic" }),
    ).toBe("title:'Tea' sku:'T-100' vendor:'Acme' tag:'organic'");
  });

  it("ignores empty-string filters", () => {
    expect(buildProductSearchQuery({ title: "Tea", sku: "" })).toBe("title:'Tea'");
  });
});

describe("searchProducts error surfacing (ticket #7)", () => {
  it("propagates a SHOPIFY_API_ERROR when the products path is missing", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ data: { other: { edges: [] } } } as GraphQLResponse<unknown>);
    const client = buildClient(fetchImpl);

    await expect(searchProducts(client, {}, appConfig())).rejects.toMatchObject({
      code: "SHOPIFY_API_ERROR",
      message: expect.stringContaining("products"),
    });
  });

  it("propagates GraphQL-level errors from the Admin API", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ errors: [{ message: "Field 'querey' doesn't exist" }] });
    const client = buildClient(fetchImpl);

    await expect(searchProducts(client, {}, appConfig())).rejects.toMatchObject({
      code: "SHOPIFY_API_ERROR",
    });
  });
});