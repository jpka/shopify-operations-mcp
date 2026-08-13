import {
  paginateConnection,
  type AdminClient,
} from "../graphql/adminClient.js";

/**
 * Shopify's financial status values as accepted by the `financial_status:`
 * order search filter. The GraphQL enum also has PARTIALLY_PAID, but the
 * search syntax spells it `partially_paid`; the tool exposes the search-filter
 * vocabulary so filters translate verbatim into the Admin API `query` string.
 */
export const FINANCIAL_STATUSES = [
  "pending",
  "authorized",
  "partially_paid",
  "paid",
  "partially_refunded",
  "refunded",
  "voided",
] as const;

export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number];

/**
 * Shopify's fulfillment status values as accepted by the `fulfillment_status:`
 * order search filter.
 */
export const FULFILLMENT_STATUSES = ["fulfilled", "partial", "unfulfilled"] as const;

export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

export interface ListOrdersArgs {
  /**
   * Only orders with this financial status (e.g. "paid", "refunded"). Maps to
   * `financial_status:` in the Admin API order search query.
   */
  financialStatus?: FinancialStatus;
  /**
   * Only orders with this fulfillment status (e.g. "unfulfilled"). Maps to
   * `fulfillment_status:` in the Admin API order search query.
   */
  fulfillmentStatus?: FulfillmentStatus;
  /**
   * Only orders created at or after this ISO-8601 date or datetime (inclusive).
   * Maps to `created_at:>=...` in the Admin API order search query.
   */
  createdAfter?: string;
  /**
   * Only orders created at or before this ISO-8601 date or datetime (inclusive).
   * Maps to `created_at:<=...` in the Admin API order search query.
   */
  createdBefore?: string;
  /**
   * Page size passed as `first` to the orders connection. Default 250 (the
   * paginateConnection default). Must be a positive integer when provided.
   */
  first?: number;
}

export interface OrderLineItem {
  id: string;
  title: string;
  quantity: number;
}

export interface OrderSummary {
  id: string;
  name: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  totalPrice: string;
  lineItems: OrderLineItem[];
}

export interface ListOrdersResult {
  orders: OrderSummary[];
}

/**
 * The raw node shape selected from the `orders` connection before it is mapped
 * to `OrderSummary`. `lineItems` is only present when the order has any.
 */
interface OrderNode {
  id: string;
  name: string;
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  totalPrice: string;
  lineItems?: { edges: Array<{ node: OrderLineItem }> } | null;
}

/**
 * Builds the Admin API order search `query` string from the tool's filters.
 * Each non-empty filter becomes one space-joined term (e.g. `financial_status:paid
 * fulfillment_status:unfulfilled`); no filters yields an empty string, which the
 * caller omits so the connection returns every order.
 */
export function buildOrderSearchQuery(args: ListOrdersArgs): string {
  const parts: string[] = [];
  if (args.financialStatus !== undefined) {
    parts.push(`financial_status:${args.financialStatus}`);
  }
  if (args.fulfillmentStatus !== undefined) {
    parts.push(`fulfillment_status:${args.fulfillmentStatus}`);
  }
  if (args.createdAfter !== undefined) {
    parts.push(`created_at:>=${args.createdAfter}`);
  }
  if (args.createdBefore !== undefined) {
    parts.push(`created_at:<=${args.createdBefore}`);
  }
  return parts.join(" ");
}

/**
 * GraphQL page over the `orders` connection. Uses the paginateConnection
 * contract: `$first`/`$cursor` reserved variables, the connection (and its
 * `edges { node }` / `pageInfo`) selected at the root, and the search filter
 * passed through `$query` so filters and pagination compose in one round trip.
 */
const ORDERS_QUERY = `
query OrdersPage($first: Int!, $cursor: String, $query: String) {
  orders(first: $first, after: $cursor, query: $query) {
    edges {
      node {
        id
        name
        financialStatus
        fulfillmentStatus
        totalPrice
        lineItems(first: 250) {
          edges {
            node {
              id
              title
              quantity
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
}`;

/**
 * Lists cancellable/refundable orders: id, name, financial and fulfillment
 * status, total price and line items, filtered by financial status, fulfillment
 * status and created-date range. Pure read — a single GraphQL query with no
 * mutation; read-only by construction of what it sends.
 *
 * Fetches every page of the connection via the client's cursor-pagination
 * helper; the page size defaults to 250.
 */
export async function listOrders(
  client: AdminClient,
  args: ListOrdersArgs = {},
): Promise<ListOrdersResult> {
  if (args.first !== undefined && (!Number.isInteger(args.first) || args.first < 1)) {
    throw new RangeError(
      "listOrders: `first` must be a positive integer page size.",
    );
  }

  const filter = buildOrderSearchQuery(args);
  const variables: Record<string, unknown> = {};
  if (filter !== "") variables.query = filter;

  const nodes = await paginateConnection<OrderNode>(client, {
    query: ORDERS_QUERY,
    variables,
    path: "orders",
    first: args.first,
  });

  return {
    orders: nodes.map((node) => ({
      id: node.id,
      name: node.name,
      financialStatus: node.financialStatus ?? null,
      fulfillmentStatus: node.fulfillmentStatus ?? null,
      totalPrice: node.totalPrice,
      lineItems: (node.lineItems?.edges ?? []).map((edge) => ({
        id: edge.node.id,
        title: edge.node.title,
        quantity: edge.node.quantity,
      })),
    })),
  };
}
