import { describe, expect, it } from "vitest";
import type { ShopifyConfig } from "../../src/config.js";
import {
  AdminClient,
  type AdminClientOptions,
} from "../../src/graphql/adminClient.js";
import {
  buildOrderSearchQuery,
  listOrders,
  type FulfillmentStatus,
  type ListOrdersArgs,
  type OrderLineItem,
} from "../../src/tools/listOrders.js";

type FetchLike = NonNullable<AdminClientOptions["fetch"]>;

interface FakeOrder {
  id: string;
  name: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  totalPrice: string;
  lineItems: OrderLineItem[];
}

interface CapturedCall {
  query: string;
  variables: {
    first?: number;
    cursor?: string | null;
    query?: string;
  };
}

/**
 * Fake Admin API that serves `orders` pages from an in-memory list. The page to
 * return is chosen by the `cursor` variable (an index into the list, encoded in
 * endCursor), so a caller walking cursors with paginateConnection sees exactly
 * the multi-page behavior the real API has.
 */
function orderFetch(
  orders: FakeOrder[],
): { fetch: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: FetchLike = async (_input, init) => {
    const raw = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const variables = (raw.variables ?? {}) as CapturedCall["variables"];
    calls.push({ query: raw.query, variables });
    const pageSize = variables.first ?? 250;
    const start = variables.cursor == null ? 0 : Number(variables.cursor);
    const slice = orders.slice(start, start + pageSize);
    const next = start + pageSize;
    const hasNext = next < orders.length;
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            edges: slice.map((order) => ({
              node: {
                id: order.id,
                name: order.name,
                financialStatus: order.financialStatus,
                fulfillmentStatus: order.fulfillmentStatus,
                totalPrice: order.totalPrice,
                lineItems: { edges: order.lineItems.map((item) => ({ node: item })) },
              },
            })),
            pageInfo: {
              hasNextPage: hasNext,
              endCursor: hasNext ? String(next) : null,
            },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return { fetch: fetchImpl, calls };
}

function shopifyConfig(): ShopifyConfig {
  return {
    storeDomain: "test.myshopify.com",
    apiVersion: "2026-04",
    adminToken: "shpat_testtoken123",
  };
}

function buildClient(fetchImpl: FetchLike): AdminClient {
  return new AdminClient(shopifyConfig(), { fetch: fetchImpl });
}

function sampleOrder(id: string, overrides: Partial<FakeOrder> = {}): FakeOrder {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#100${id}`,
    financialStatus: "paid",
    fulfillmentStatus: "unfulfilled",
    totalPrice: "42.00",
    lineItems: [
      {
        id: `gid://shopify/LineItem/${id}`,
        title: "Widget",
        quantity: 2,
      },
    ],
    ...overrides,
  };
}

describe("listOrders (ticket #8)", () => {
  it("returns every order field mapped from the mocked Admin API", async () => {
    const order = sampleOrder("1");
    const { fetch, calls } = orderFetch([order]);
    const client = buildClient(fetch);

    const result = await listOrders(client);

    expect(result.orders).toEqual([
      {
        id: order.id,
        name: order.name,
        financialStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        totalPrice: "42.00",
        lineItems: [{ id: order.lineItems[0]!.id, title: "Widget", quantity: 2 }],
      },
    ]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.query).toContain("orders(");
    expect(calls[0]!.query).toContain("hasNextPage");
    expect(calls[0]!.query).toContain("endCursor");
    expect(calls[0]!.variables.first).toBe(250);
    expect(calls[0]!.variables.cursor).toBeNull();
  });

  it("normalizes missing optional fields to null and empty line items", async () => {
    const { fetch } = orderFetch([
      { ...sampleOrder("2"), financialStatus: null, fulfillmentStatus: null, lineItems: [] },
    ]);
    const client = buildClient(fetch);

    const result = await listOrders(client);

    expect(result.orders[0]).toMatchObject({
      financialStatus: null,
      fulfillmentStatus: null,
      lineItems: [],
    });
  });

  it("translates financialStatus into the financial_status search filter", async () => {
    const { fetch, calls } = orderFetch([sampleOrder("1")]);
    const client = buildClient(fetch);

    await listOrders(client, { financialStatus: "paid" });

    expect(calls[0]!.variables.query).toBe("financial_status:paid");
  });

  it("translates fulfillmentStatus into the fulfillment_status search filter", async () => {
    const { fetch, calls } = orderFetch([sampleOrder("1")]);
    const client = buildClient(fetch);

    await listOrders(client, { fulfillmentStatus: "unfulfilled" });

    expect(calls[0]!.variables.query).toBe("fulfillment_status:unfulfilled");
  });

  it("translates the created-date range into created_at filters", async () => {
    const { fetch, calls } = orderFetch([sampleOrder("1")]);
    const client = buildClient(fetch);

    await listOrders(client, { createdAfter: "2026-01-01", createdBefore: "2026-01-31" });

    expect(calls[0]!.variables.query).toBe(
      "created_at:>=2026-01-01 created_at:<=2026-01-31",
    );
  });

  it("combines every provided filter into one space-joined search query", async () => {
    const { fetch, calls } = orderFetch([sampleOrder("1")]);
    const client = buildClient(fetch);

    await listOrders(client, {
      financialStatus: "refunded",
      fulfillmentStatus: "fulfilled",
      createdAfter: "2025-12-01",
    });

    expect(calls[0]!.variables.query).toBe(
      "financial_status:refunded fulfillment_status:fulfilled created_at:>=2025-12-01",
    );
  });

  it("omits the query filter entirely when no filters are given", async () => {
    const { fetch, calls } = orderFetch([sampleOrder("1")]);
    const client = buildClient(fetch);

    await listOrders(client);

    expect(calls[0]!.variables.query).toBeUndefined();
  });

  it("rejects a non-positive page size", async () => {
    const { fetch } = orderFetch([]);
    const client = buildClient(fetch);

    await expect(listOrders(client, { first: 0 })).rejects.toThrow(RangeError);
    await expect(listOrders(client, { first: -5 })).rejects.toThrow(RangeError);
  });

  it("walks cursors across multiple pages and returns every order", async () => {
    const orders = Array.from({ length: 5 }, (_, i) => sampleOrder(String(i + 1)));
    const { fetch, calls } = orderFetch(orders);
    const client = buildClient(fetch);

    const result = await listOrders(client, { first: 2 });

    expect(result.orders.map((o) => o.id)).toEqual(
      ["1", "2", "3", "4", "5"].map((id) => `gid://shopify/Order/${id}`),
    );
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.variables.cursor)).toEqual([null, "2", "4"]);
    // every page carried the same filters so the result set stays stable
    for (const call of calls) {
      expect(call.variables.first).toBe(2);
      expect(call.variables.query).toBeUndefined();
    }
  });

  it("carries the search filter onto every paginated page", async () => {
    const orders = Array.from({ length: 5 }, (_, i) => sampleOrder(String(i + 1)));
    const { fetch, calls } = orderFetch(orders);
    const client = buildClient(fetch);

    const args: ListOrdersArgs = {
      financialStatus: "paid",
      fulfillmentStatus: "unfulfilled",
      createdAfter: "2026-01-01",
      createdBefore: "2026-01-31",
      first: 3,
    };
    await listOrders(client, args);

    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.variables.query).toBe(
        "financial_status:paid fulfillment_status:unfulfilled created_at:>=2026-01-01 created_at:<=2026-01-31",
      );
    }
  });

  it("returns refundable orders when filtered to refunded financial status", async () => {
    const refundable = sampleOrder("7", { financialStatus: "refunded" });
    const paid = sampleOrder("8", { financialStatus: "paid" });
    const { fetch, calls } = orderFetch([refundable, paid]);
    const client = buildClient(fetch);

    const result = await listOrders(client, {
      financialStatus: "refunded",
      fulfillmentStatus: "unfulfilled" as FulfillmentStatus,
    });

    expect(calls[0]!.variables.query).toBe(
      "financial_status:refunded fulfillment_status:unfulfilled",
    );
    expect(result.orders.map((o) => o.id)).toEqual([
      "gid://shopify/Order/7",
      "gid://shopify/Order/8",
    ]);
  });
});

describe("buildOrderSearchQuery (ticket #8)", () => {
  it("joins the configured filters with single spaces", () => {
    expect(
      buildOrderSearchQuery({
        financialStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        createdAfter: "2026-01-01",
        createdBefore: "2026-01-31",
      }),
    ).toBe(
      "financial_status:paid fulfillment_status:unfulfilled created_at:>=2026-01-01 created_at:<=2026-01-31",
    );
  });

  it("returns an empty string when no filters are set", () => {
    expect(buildOrderSearchQuery({})).toBe("");
  });

  it("supports a created-before-only bound", () => {
    expect(buildOrderSearchQuery({ createdBefore: "2026-06-30" })).toBe(
      "created_at:<=2026-06-30",
    );
  });
});