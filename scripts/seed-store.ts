#!/usr/bin/env node
/**
 * Deterministic dev-store seeder.
 *
 *   npm run seed -- [--seed 42] [--dry-run] [--order-delay-ms 1200]
 *
 * Generates a realistic store from a seeded PRNG (see seed-data.ts) and
 * writes it through the Admin API via AdminClient: ~300 products with 1-4
 * variants across vendors/tags, stock at two locations, ~20 customers, and
 * ~120 Bogus-Gateway test orders in mixed states (paid/unfulfilled,
 * fulfilled, discounted).
 *
 * Sizing: the full variant set exceeds `hardMaxItems` (default 250), so a
 * store-wide reprice is refused; the `sale` tag covers between
 * `approvalRequiredAboveItems` (default 25) and `hardMaxItems` variants, so a
 * single-tag reprice requests approval but is not refused. Both invariants
 * are asserted against the loaded config before any API call.
 *
 * Idempotency: every created resource carries the SEED_MARKER_TAG
 * ("seeded-store"); a re-run first wipes everything tagged with that marker
 * (orders, then customers, then products) and regenerates, so two runs
 * against the same store produce identical counts.
 *
 * Product creation follows the current product model: `productCreate` makes
 * the initial "Default Title" variant (there is no `variants` input on
 * ProductCreateInput), `productVariantsBulkCreate` adds the rest under the
 * "Title" option, and `productVariantsBulkUpdate` pins sku/price/inventory
 * tracking on the initial variant. Inventory items are auto-created and
 * stock is set with `inventorySetQuantities` per location.
 */
import { AdminClient, chunk, paginateConnection } from "../src/graphql/adminClient.ts";
import { DEFAULT_PLANS_CONFIG, loadConfig } from "../src/config.ts";
import {
  APPROVAL_TRIGGER_TAG,
  DEFAULT_SEED,
  LOCATION_COUNT,
  SEED_MARKER_TAG,
  assertSizingInvariants,
  generateSeedPlan,
  seedCounts,
  type SeedCounts,
  type SeedPlan,
  type SeedProduct,
  type SeedVariant,
} from "./seed-data.ts";

interface CliArgs {
  seed: number;
  dryRun: boolean;
  orderDelayMs: number;
}

interface UserError {
  field: string[] | null;
  message: string;
}

function usage(): string {
  return (
    "usage: npm run seed -- [--seed <number>] [--dry-run] [--order-delay-ms <ms>]"
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { seed: DEFAULT_SEED, dryRun: false, orderDelayMs: 0 };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--seed": {
        const raw = argv[++i];
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
          throw new Error(`--seed expects a non-negative integer, got "${raw}"`);
        }
        args.seed = value;
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--order-delay-ms": {
        const raw = argv[++i];
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
          throw new Error(
            `--order-delay-ms expects a non-negative integer, got "${raw}"`,
          );
        }
        args.orderDelayMs = value;
        break;
      }
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument "${arg}"\n${usage()}`);
    }
  }
  return args;
}

function formatPrice(priceCents: number): string {
  return (priceCents / 100).toFixed(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Throws when a mutation reports userErrors — the API layer fails fast. */
function assertNoUserErrors(
  userErrors: UserError[],
  operation: string,
): void {
  if (userErrors.length > 0) {
    throw new Error(
      `${operation} failed: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
}

function printCounts(counts: SeedCounts): void {
  process.stdout.write("seeded-store plan counts:\n");
  process.stdout.write(`  products:  ${counts.products}\n`);
  process.stdout.write(`  variants:  ${counts.variants}\n`);
  process.stdout.write(`  locations: ${counts.locations}\n`);
  process.stdout.write(`  customers: ${counts.customers}\n`);
  process.stdout.write(`  orders:    ${counts.orders}\n`);
  for (const [tag, count] of Object.entries(counts.tagVariantCounts)) {
    process.stdout.write(`  variants tagged "${tag}": ${count}\n`);
  }
}

const TAG_SEARCH_QUERY = `
  query SeedByTag($first: Int!, $cursor: String, $query: String) {
    %CONNECTION%(first: $first, after: $cursor, query: $query) {
      edges {
        node { id }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PRODUCT_DELETE_MUTATION = `
  mutation SeedProductDelete($productId: ID!) {
    productDelete(productId: $productId) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

const CUSTOMER_DELETE_MUTATION = `
  mutation SeedCustomerDelete($id: ID!) {
    customerDelete(input: { id: $id }) {
      deletedCustomerId
      userErrors { field message }
    }
  }
`;

const ORDER_DELETE_MUTATION = `
  mutation SeedOrderDelete($orderId: ID!) {
    orderDelete(orderId: $orderId) {
      deletedId
      userErrors { field message }
    }
  }
`;

const LOCATIONS_QUERY = `
  query SeedLocations($first: Int!) {
    locations(first: $first) {
      edges {
        node { id name }
      }
    }
  }
`;

interface ProductCreateResponse {
  productCreate: {
    product: {
      id: string;
      variants: { nodes: Array<{ id: string; sku: string; inventoryItem: { id: string } }> };
    } | null;
    userErrors: UserError[];
  };
}

const PRODUCT_CREATE_MUTATION = `
  mutation SeedProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        variants(first: 10) {
          nodes {
            id
            sku
            inventoryItem { id }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

interface BulkVariantsResponse {
  productVariants: Array<{ id: string; sku: string; inventoryItem: { id: string } }>;
  userErrors: UserError[];
}

const VARIANTS_BULK_CREATE_MUTATION = `
  mutation SeedVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { id sku inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_UPDATE_MUTATION = `
  mutation SeedVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

interface InventorySetResponse {
  inventorySetQuantities: { userErrors: UserError[] };
}

const INVENTORY_SET_QUANTITIES_MUTATION = `
  mutation SeedInventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      userErrors { field message }
    }
  }
`;

interface CustomerCreateResponse {
  customerCreate: { customer: { id: string } | null; userErrors: UserError[] };
}

const CUSTOMER_CREATE_MUTATION = `
  mutation SeedCustomerCreate($customer: CustomerCreateInput!) {
    customerCreate(customer: $customer) {
      customer { id }
      userErrors { field message }
    }
  }
`;

interface OrderCreateResponse {
  orderCreate: { order: { id: string } | null; userErrors: UserError[] };
}

const ORDER_CREATE_MUTATION = `
  mutation SeedOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id }
      userErrors { field message }
    }
  }
`;

interface WipedCounts {
  orders: number;
  customers: number;
  products: number;
}

/**
 * Deletes every previously-seeded order, customer, and product (in that
 * order — customers can only be deleted once their orders are gone) by
 * searching for the SEED_MARKER_TAG. Products carry their variants and
 * inventory items, which productDelete cleans up.
 */
async function wipeSeeded(client: AdminClient): Promise<WipedCounts> {
  const tagQuery = `tag:${SEED_MARKER_TAG}`;

  const wipeConnection = async (
    connection: string,
    deleteMutation: string,
  ): Promise<number> => {
    const nodes = await paginateConnection<{ id: string }>(client, {
      query: TAG_SEARCH_QUERY.replace("%CONNECTION%", connection),
      variables: { query: tagQuery },
      path: connection,
    });
    for (const node of nodes) {
      const deleteVariable =
        connection === "orders"
          ? { orderId: node.id }
          : connection === "customers"
            ? { id: node.id }
            : { productId: node.id };
      await client.graphql({
        query: deleteMutation,
        variables: deleteVariable,
        cost: 5,
      });
    }
    return nodes.length;
  };

  const orders = await wipeConnection("orders", ORDER_DELETE_MUTATION);
  const customers = await wipeConnection("customers", CUSTOMER_DELETE_MUTATION);
  const products = await wipeConnection("products", PRODUCT_DELETE_MUTATION);
  return { orders, customers, products };
}

interface LocationRef {
  id: string;
  name: string;
}

/** Returns the store's locations in order, so the seeder can pick the first two. */
async function queryLocations(client: AdminClient): Promise<LocationRef[]> {
  const data = await client.graphql<{
    locations: { edges: Array<{ node: LocationRef }> };
  }>({
    query: LOCATIONS_QUERY,
    variables: { first: 10 },
    cost: 5,
  });
  return data.locations.edges.map((edge) => edge.node);
}

interface CreatedVariantRef {
  variantGid: string;
  inventoryItemGid: string;
}

function productCreateInput(product: SeedProduct): Record<string, unknown> {
  return {
    title: product.title,
    handle: product.handle,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    status: "ACTIVE",
    productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
  };
}

/** The variant input shared by bulk create (extra variants) and bulk update. */
function variantBulkInput(variant: SeedVariant): Record<string, unknown> {
  return {
    optionValues: [{ name: variant.title, optionName: "Title" }],
    sku: variant.sku,
    price: formatPrice(variant.priceCents),
    inventoryManagement: "SHOPIFY",
  };
}

/**
 * Creates every product and variant. `productCreate` yields the initial
 * "Default Title" variant (ProductCreateInput has no `variants` field in the
 * current product model); additional variants go through
 * `productVariantsBulkCreate`, and `productVariantsBulkUpdate` pins
 * sku/price/inventory tracking on the initial variant so
 * `inventorySetQuantities` can manage its stock. Returns the Shopify
 * variant/inventory-item GIDs keyed by the plan's global variant index.
 */
async function createProducts(
  client: AdminClient,
  plan: SeedPlan,
): Promise<Map<number, CreatedVariantRef>> {
  const byGlobalIndex = new Map<number, CreatedVariantRef>();

  for (let i = 0; i < plan.products.length; i++) {
    const product = plan.products[i]!;
    const createData = await client.graphql<ProductCreateResponse>({
      query: PRODUCT_CREATE_MUTATION,
      variables: { product: productCreateInput(product) },
      cost: 10,
    });
    assertNoUserErrors(createData.productCreate.userErrors, `productCreate ${product.title}`);
    const createdProduct = createData.productCreate.product;
    if (!createdProduct) {
      throw new Error(`productCreate ${product.title} returned no product`);
    }
    const initialNode = createdProduct.variants.nodes[0];
    if (!initialNode) {
      throw new Error(`productCreate ${product.title} returned no initial variant`);
    }

    const extraVariants = product.variants.slice(1);
    if (extraVariants.length > 0) {
      const bulkData = await client.graphql<{
        productVariantsBulkCreate: BulkVariantsResponse;
      }>({
        query: VARIANTS_BULK_CREATE_MUTATION,
        variables: {
          productId: createdProduct.id,
          variants: extraVariants.map(variantBulkInput),
        },
        cost: extraVariants.length,
      });
      assertNoUserErrors(
        bulkData.productVariantsBulkCreate.userErrors,
        `productVariantsBulkCreate ${product.title}`,
      );
      const created = bulkData.productVariantsBulkCreate.productVariants;
      if (created.length !== extraVariants.length) {
        throw new Error(
          `productVariantsBulkCreate ${product.title}: expected ${extraVariants.length} variants, got ${created.length}`,
        );
      }
      for (let k = 0; k < extraVariants.length; k++) {
        const variant = extraVariants[k]!;
        const node = created[k]!;
        byGlobalIndex.set(variant.globalIndex, {
          variantGid: node.id,
          inventoryItemGid: node.inventoryItem.id,
        });
      }
    }

    const initial = product.variants[0]!;
    const updateData = await client.graphql<{
      productVariantsBulkUpdate: BulkVariantsResponse;
    }>({
      query: VARIANTS_BULK_UPDATE_MUTATION,
      variables: {
        productId: createdProduct.id,
        variants: [{ id: initialNode.id, ...variantBulkInput(initial) }],
      },
      cost: 1,
    });
    assertNoUserErrors(
      updateData.productVariantsBulkUpdate.userErrors,
      `productVariantsBulkUpdate ${product.title}`,
    );
    const updatedNode = updateData.productVariantsBulkUpdate.productVariants[0];
    if (!updatedNode) {
      throw new Error(`productVariantsBulkUpdate ${product.title} returned no variant`);
    }
    byGlobalIndex.set(initial.globalIndex, {
      variantGid: updatedNode.id,
      inventoryItemGid: updatedNode.inventoryItem.id,
    });

    if ((i + 1) % 50 === 0) {
      process.stderr.write(`  created ${i + 1}/${plan.products.length} products\n`);
    }
  }
  return byGlobalIndex;
}

/**
 * Sets absolute "available" quantities for every variant at each of the
 * selected locations, chunked so no single `inventorySetQuantities` call is
 * too large. Stock comes straight from the deterministic plan.
 */
async function setInventory(
  client: AdminClient,
  locationGids: string[],
  byGlobalIndex: Map<number, CreatedVariantRef>,
  plan: SeedPlan,
): Promise<void> {
  const entries: Array<{ inventoryItemGid: string; stock: number[] }> = [];
  for (const product of plan.products) {
    for (const variant of product.variants) {
      const mapped = byGlobalIndex.get(variant.globalIndex);
      if (!mapped) {
        throw new Error(`variant ${variant.id} was not created`);
      }
      entries.push({ inventoryItemGid: mapped.inventoryItemGid, stock: variant.stock });
    }
  }

  for (let locationIndex = 0; locationIndex < locationGids.length; locationIndex++) {
    const locationGid = locationGids[locationIndex]!;
    const quantities = entries.map((entry) => ({
      inventoryItemId: entry.inventoryItemGid,
      locationId: locationGid,
      quantity: entry.stock[locationIndex] ?? 0,
    }));
    for (const batch of chunk(quantities, 250)) {
      const data = await client.graphql<InventorySetResponse>({
        query: INVENTORY_SET_QUANTITIES_MUTATION,
        variables: {
          input: {
            name: "available",
            reason: "correction",
            referenceDocumentUri: `gid://shopify-operations-mcp/Seed/seed-${plan.seed}`,
            quantities: batch,
          },
        },
        cost: batch.length,
      });
      assertNoUserErrors(
        data.inventorySetQuantities.userErrors,
        `inventorySetQuantities at location ${locationGid}`,
      );
    }
  }
}

/** Creates the deterministic customers and returns their GIDs by plan index. */
async function createCustomers(
  client: AdminClient,
  plan: SeedPlan,
): Promise<string[]> {
  const gids: string[] = [];
  for (const customer of plan.customers) {
    const data = await client.graphql<CustomerCreateResponse>({
      query: CUSTOMER_CREATE_MUTATION,
      variables: {
        customer: {
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email,
          tags: customer.tags,
        },
      },
      cost: 5,
    });
    assertNoUserErrors(
      data.customerCreate.userErrors,
      `customerCreate ${customer.email}`,
    );
    const created = data.customerCreate.customer;
    if (!created) {
      throw new Error(`customerCreate ${customer.email} returned no customer`);
    }
    gids.push(created.id);
  }
  return gids;
}

/**
 * Creates the deterministic orders through `orderCreate` as Bogus-Gateway
 * test orders (`test: true`, inventory bypassed so seeded stock stays
 * exact). Discounted orders carry an item fixed-amount discount code.
 * `orderDelayMs` spaces creations out; development stores cap orderCreate at
 * five per minute.
 */
async function createOrders(
  client: AdminClient,
  plan: SeedPlan,
  byGlobalIndex: Map<number, CreatedVariantRef>,
  customerGids: string[],
  orderDelayMs: number,
): Promise<number> {
  let created = 0;
  for (const order of plan.orders) {
    const customerGid = customerGids[order.customerIndex];
    if (!customerGid) {
      throw new Error(`order ${order.id}: customer ${order.customerIndex} not created`);
    }

    const input: Record<string, unknown> = {
      lineItems: order.lineItems.map((lineItem) => {
        const mapped = byGlobalIndex.get(lineItem.variantIndex);
        if (!mapped) {
          throw new Error(`order ${order.id}: variant ${lineItem.variantIndex} not created`);
        }
        return { variantId: mapped.variantGid, quantity: lineItem.quantity };
      }),
      customer: { toAssociate: { id: customerGid } },
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      tags: order.tags,
      test: true,
    };
    if (order.discountAmountCents !== null) {
      input.discountCode = {
        itemFixedDiscountCode: {
          amountSet: {
            shopMoney: {
              amount: formatPrice(order.discountAmountCents),
              currencyCode: "USD",
            },
          },
        },
      };
    }

    const data = await client.graphql<OrderCreateResponse>({
      query: ORDER_CREATE_MUTATION,
      variables: { order: input, options: { inventoryBehaviour: "bypass" } },
      cost: 10,
    });
    assertNoUserErrors(data.orderCreate.userErrors, `orderCreate ${order.id}`);
    if (!data.orderCreate.order) {
      throw new Error(`orderCreate ${order.id} returned no order`);
    }
    created++;

    if ((created % 25 === 0) && created < plan.orders.length) {
      process.stderr.write(`  created ${created}/${plan.orders.length} orders\n`);
    }
    if (orderDelayMs > 0) await sleep(orderDelayMs);
  }
  return created;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const plan = generateSeedPlan(args.seed);

  if (args.dryRun) {
    assertSizingInvariants(plan, DEFAULT_PLANS_CONFIG);
    printCounts(seedCounts(plan));
    process.stdout.write(
      `dry run: no API calls made (defaults hardMaxItems=${DEFAULT_PLANS_CONFIG.hardMaxItems}, ` +
        `approvalRequiredAboveItems=${DEFAULT_PLANS_CONFIG.approvalRequiredAboveItems})\n`,
    );
    return;
  }

  const config = loadConfig();
  assertSizingInvariants(plan, config.plans);
  printCounts(seedCounts(plan));
  process.stdout.write(
    `seeding ${config.shopify.storeDomain} (Admin API ${config.shopify.apiVersion})\n`,
  );

  const client = new AdminClient(config.shopify);

  const wiped = await wipeSeeded(client);
  process.stdout.write(
    `wiped ${wiped.orders} orders, ${wiped.customers} customers, ${wiped.products} products\n`,
  );

  const locations = await queryLocations(client);
  if (locations.length < LOCATION_COUNT) {
    throw new Error(
      `store has ${locations.length} locations; the seeder needs at least ${LOCATION_COUNT}`,
    );
  }
  const locationGids = locations.slice(0, LOCATION_COUNT).map((location) => location.id);

  process.stderr.write("creating products and variants\n");
  const byGlobalIndex = await createProducts(client, plan);
  process.stderr.write("setting inventory\n");
  await setInventory(client, locationGids, byGlobalIndex, plan);
  process.stderr.write("creating customers\n");
  const customerGids = await createCustomers(client, plan);
  process.stderr.write("creating orders\n");
  const createdOrders = await createOrders(
    client,
    plan,
    byGlobalIndex,
    customerGids,
    args.orderDelayMs,
  );

  const counts = seedCounts(plan);
  printCounts(counts);
  process.stdout.write(
    `created ${counts.products} products, ${counts.variants} variants, ` +
      `${counts.customers} customers, ${createdOrders} orders at ` +
      `${locationGids.length} locations (${config.shopify.storeDomain})\n`,
  );
  process.stdout.write(
    `reprice sizing: full variant set ${counts.tagVariantCounts[SEED_MARKER_TAG] ?? 0} ` +
      `(hardMaxItems ${config.plans.hardMaxItems}), tag "${APPROVAL_TRIGGER_TAG}" ` +
      `${counts.tagVariantCounts[APPROVAL_TRIGGER_TAG] ?? 0} ` +
      `(approval ${config.plans.approvalRequiredAboveItems}..${config.plans.hardMaxItems})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[seed-store] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});