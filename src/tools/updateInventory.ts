/**
 * update_inventory: two-phase bulk inventory write tool.
 *
 * Previews planned quantity changes at a named location (pure reads, zero
 * mutation), then executes via the chunked `inventorySetQuantities` Shopify
 * mutation.  Protected-tagged products are refused at preview time with
 * PROTECTED_RESOURCE before a token is issued.
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

/**
 * Error code for plans that touch a protected-tagged product or variant.
 * Thrown before a plan token is issued so there is no approval path.
 */
export const PROTECTED_RESOURCE_CODE = "PROTECTED_RESOURCE";

/**
 * Arguments for the update_inventory tool.
 */
export interface UpdateInventoryArgs {
  /**
   * The gid://shopify/Location/… id where quantities are set.
   */
  locationId: string;
  /**
   * Per-inventory-item quantity adjustments. Each entry sets the available
   * quantity at `locationId` to the absolute `quantity` value (not a delta).
   */
  adjustments: readonly InventoryAdjustment[];
}

/**
 * One inventory item adjustment.
 */
export interface InventoryAdjustment {
  /**
   * gid://shopify/InventoryItem/… id (from searchProducts variants).
   */
  inventoryItemId: string;
  /**
   * The quantity to set at the location after this plan executes.
   */
  quantity: number;
}

/**
 * The before/after snapshot for one inventory item in the manifest.
 */
export interface InventoryLevelSnapshot {
  inventoryItemId: string;
  locationId: string;
  available: number;
}

/**
 * Per-inventory-item manifest entry: before/after quantities at the location.
 */
export interface InventoryManifestItem
  extends ManifestItem<InventoryLevelSnapshot, InventoryLevelSnapshot, InventoryAdjustment> {
  ref: string;
  before: InventoryLevelSnapshot;
  after: InventoryLevelSnapshot;
  payload: InventoryAdjustment;
}

interface RawInventoryLevelNode {
  id: string;
  /** Per-name inventory quantities; "available" holds the sellable count. */
  quantities: Array<{ name: string; quantity: number }>;
  location: { id: string };
}

interface RawInventoryItemNode {
  id: string;
  product: {
    id: string;
    tags: string[];
  } | null;
  variant: {
    id: string;
    title: string;
  } | null;
  inventoryLevels: {
    edges: Array<{ node: RawInventoryLevelNode }>;
  };
}

const GET_INVENTORY_ITEMS_QUERY = /* GraphQL */ `
  query GetInventoryItems($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        product {
          id
          tags
        }
        variant {
          id
          title
        }
        inventoryLevels(first: 250) {
          edges {
            node {
              id
              quantities(names: ["available"]) {
                name
                quantity
              }
              location {
                id
              }
            }
          }
        }
      }
    }
  }
`;

const INVENTORY_SET_QUANTITIES_MUTATION = /* GraphQL */ `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryLevels {
        id
        quantities(names: ["available"]) {
          name
          quantity
        }
        location {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Extracts the sellable ("available") quantity from an inventory level's
 * per-name quantities. Since the API removed the flat `available` field on
 * InventoryLevel, the queries select `quantities { name quantity }`.
 */
function availableOf(
  quantities: Array<{ name: string; quantity: number }>,
): number {
  return quantities.find((q) => q.name === "available")?.quantity ?? 0;
}

/**
 * Fetches inventory item records including product tags for protected-tag
 * checking, and current inventory levels at `locationId`.
 */
async function fetchInventoryItems(
  client: AdminClient,
  inventoryItemIds: string[],
  locationId: string,
): Promise<{
  levels: InventoryLevelSnapshot[];
  items: Map<string, RawInventoryItemNode>;
}> {
  if (inventoryItemIds.length === 0) {
    return { levels: [], items: new Map() };
  }

  const data = await client.graphql<{ nodes: RawInventoryItemNode[] }>({
    query: GET_INVENTORY_ITEMS_QUERY,
    variables: { ids: inventoryItemIds },
    cost: inventoryItemIds.length,
  });

  const levels: InventoryLevelSnapshot[] = [];
  const items = new Map<string, RawInventoryItemNode>();

  for (const node of data.nodes) {
    if (!node) continue;
    items.set(node.id, node);
    for (const edge of node.inventoryLevels.edges) {
      if (edge.node.location.id === locationId) {
        levels.push({
          inventoryItemId: node.id,
          locationId: edge.node.location.id,
          available: availableOf(edge.node.quantities),
        });
      }
    }
  }

  return { levels, items };
}

/**
 * Checks whether the inventory item's product carries any protected tag and
 * throws PROTECTED_RESOURCE before a plan token is issued.
 */
class ProtectedResourceError extends Error {
  readonly code: string;
  readonly hint: string;

  constructor(itemId: string, matched: readonly string[], hint: string) {
    super(
      `Inventory item ${itemId} belongs to a product carrying protected tag(s): ${matched.join(", ")}. ` +
        `This plan is refused. ${hint}`,
    );
    this.name = "ProtectedResourceError";
    this.code = PROTECTED_RESOURCE_CODE;
    this.hint = hint;
  }
}

function assertNotProtected(
  item: RawInventoryItemNode,
  protectedTags: readonly string[],
): void {
  const tags = item.product?.tags ?? [];
  const matched = protectedTags.filter((t) => tags.includes(t));
  if (matched.length > 0) {
    const hint =
      "Remove the protected tag from the product, or exclude this item from the plan.";
    throw new ProtectedResourceError(item.id, matched, hint);
  }
}

/**
 * Builds a quantity-change manifest by reading current levels at the location
 * and validating protected-tag status.  Performs zero mutation calls.
 */
export class InventoryManifestBuilder implements ManifestBuilder<InventoryManifestItem> {
  constructor(
    private client: AdminClient,
    private args: UpdateInventoryArgs,
    private config: AppConfig,
  ) {}

  async build(): Promise<Manifest<InventoryManifestItem>> {
    const { locationId, adjustments } = this.args;
    const inventoryItemIds = adjustments.map((a) => a.inventoryItemId);

    const { levels, items } = await fetchInventoryItems(
      this.client,
      inventoryItemIds,
      locationId,
    );

    const levelByItem = new Map<string, InventoryLevelSnapshot>();
    for (const level of levels) {
      levelByItem.set(level.inventoryItemId, level);
    }

    const manifestItems: InventoryManifestItem[] = [];

    for (const adjustment of adjustments) {
      const item = items.get(adjustment.inventoryItemId);
      if (!item) {
        throw new Error(
          `Inventory item ${adjustment.inventoryItemId} not found. ` +
            `Verify the inventory item id is correct and the item exists in Shopify.`,
        );
      }

      assertNotProtected(item, this.config.protectedTags);

      const before = levelByItem.get(adjustment.inventoryItemId);
      if (!before) {
        throw new Error(
          `Inventory item ${adjustment.inventoryItemId} has no level at location ${locationId}. ` +
            `Verify the inventory item is stocked at this location.`,
        );
      }

      manifestItems.push({
        ref: adjustment.inventoryItemId,
        before,
        after: {
          inventoryItemId: adjustment.inventoryItemId,
          locationId,
          available: adjustment.quantity,
        },
        payload: {
          inventoryItemId: adjustment.inventoryItemId,
          quantity: adjustment.quantity,
        },
      });
    }

    return assembleManifest(manifestItems);
  }
}

/**
 * Re-reads current inventory levels at execute time for the STATE_CHANGED
 * drift check.
 */
export class InventoryStateReader implements StateReader<InventoryLevelSnapshot> {
  constructor(
    private client: AdminClient,
    private locationId: string,
  ) {}

  async readCurrent(
    refs: readonly string[],
  ): Promise<Readonly<Record<string, InventoryLevelSnapshot>>> {
    if (refs.length === 0) return {};

    const { levels } = await fetchInventoryItems(this.client, [...refs], this.locationId);
    const out: Record<string, InventoryLevelSnapshot> = {};
    for (const snap of levels) {
      out[snap.inventoryItemId] = snap;
    }
    return out;
  }
}

/**
 * Executes quantity changes via the `inventorySetQuantities` Shopify mutation,
 * chunked into batches of `chunkSize` (default 50).
 */
export class InventoryExecutor implements Executor<InventoryManifestItem, void> {
  private readonly chunkSize: number;

  constructor(
    private client: AdminClient,
    private locationId: string,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
  ) {
    this.chunkSize = chunkSize;
  }

  async execute(item: InventoryManifestItem): Promise<ItemOutcome<void>> {
    return this.executeBatch([item]).then((b) => b[0]!);
  }

  private async executeBatch(
    items: readonly InventoryManifestItem[],
  ): Promise<ItemOutcome<void>[]> {
    const ledger: ItemOutcome<void>[] = [];
    const batches = chunk(items, this.chunkSize);

    for (const batch of batches) {
      const input = {
        locationId: this.locationId,
        quantities: batch.map((i) => ({
          inventoryItemId: i.payload.inventoryItemId,
          quantity: i.payload.quantity,
        })),
      };

      try {
        const data = await this.client.graphql<{
          inventorySetQuantities: {
            inventoryLevels: Array<{ id: string; quantities: Array<{ name: string; quantity: number }> }>;
            userErrors: Array<{ field: string[]; message: string }>;
          };
        }>({
          query: INVENTORY_SET_QUANTITIES_MUTATION,
          variables: { input },
          cost: batch.length,
        });

        const result = data.inventorySetQuantities;

        if (result.userErrors.length > 0) {
          for (const item of batch) {
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

        for (const item of batch) {
          ledger.push({ ref: item.ref, ok: true });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const item of batch) {
          ledger.push({
            ref: item.ref,
            ok: false,
            error: { code: "SHOPIFY_API_ERROR", message },
          });
        }
      }
    }

    return ledger;
  }
}
