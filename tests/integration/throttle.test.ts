/**
 * Live integration suite: cost-aware throttling + retry/backoff against the
 * real Admin API.
 *
 * Deliberately fires bursts that exceed the store's GraphQL cost budget
 * (default dev-store maximum ~1000 points, restore ~50/s): parallel
 * `products(first: 250)` reads are ~250 cost points each, so 6–12 concurrent
 * requests overshoot the budget and force Shopify to throttle. The bursts are
 * kept small (a few duplicate page reads of the same 300 seeded products) and
 * are the heaviest load this suite places on the store.
 *
 * Env-gated: skipped entirely unless both SHOPIFY_STORE_DOMAIN and
 * SHOPIFY_ADMIN_TOKEN are set, so `npm test` and `npm run test:integration`
 * pass as a no-op without credentials.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  AdminClient,
  ShopifyApiError,
} from "../../src/graphql/adminClient.js";
import {
  buildFixture,
  integrationEnabled,
  type IntegrationFixture,
} from "./helpers.js";

const enabled = integrationEnabled();
if (!enabled) {
  console.warn(
    "[integration:throttle] SKIPPED — set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN and run `npm run seed` first.",
  );
}
const describeSuite = enabled ? describe : describe.skip;

/** A page-sized product read, ~250 cost points per call on a seeded store. */
const PRODUCTS_PAGE = /* GraphQL */ `
  query ProductsPage {
    products(first: 250) {
      edges { node { id title } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PAGE_COST = 250;

describeSuite("integration: throttle handling", () => {
  let fx: IntegrationFixture;

  beforeAll(() => {
    fx = buildFixture();
  });

  it("the default client absorbs a budget-exceeding parallel burst via cost sleep + backoff", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        fx.client.graphql<{ products: { edges: Array<{ node: { id: string } }> } }>({
          query: PRODUCTS_PAGE,
          cost: PAGE_COST,
        }),
      ),
    );

    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }

    // The store is still responsive after the burst.
    await expect(
      fx.client.graphql<{ shop: { id: string } }>({
        query: "query ShopId { shop { id } }",
        cost: 1,
      }),
    ).resolves.toMatchObject({ shop: { id: expect.stringContaining("gid://shopify/Shop/") } });
  });

  it("a no-retry client surfaces throttling as a structured SHOPIFY_THROTTLED, never an unknown error", async () => {
    // No retries and a tiny cap so the burst cannot be absorbed: the moment a
    // request is throttled it must surface as ShopifyApiError(SHOPIFY_THROTTLED).
    const burst = new AdminClient(fx.config.shopify, {
      maxRetries: 0,
      baseDelayMs: 1,
      maxDelayMs: 100,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        burst.graphql<{ products: { edges: unknown[] } }>({
          query: PRODUCTS_PAGE,
          cost: PAGE_COST,
        }),
      ),
    );

    const throttled = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof ShopifyApiError,
    );
    expect(throttled.length).toBeGreaterThan(0);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(ShopifyApiError);
        expect((result.reason as ShopifyApiError).code).toBe("SHOPIFY_THROTTLED");
      }
    }

    // A fresh default client recovers immediately afterwards.
    await expect(
      fx.client.graphql<{ shop: { id: string } }>({
        query: "query ShopId { shop { id } }",
        cost: 1,
      }),
    ).resolves.toMatchObject({ shop: { id: expect.stringContaining("gid://shopify/Shop/") } });
  });
});