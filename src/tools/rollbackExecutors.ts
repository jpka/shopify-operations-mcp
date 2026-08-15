import type { AdminClient } from "../graphql/adminClient.js";
import { DiscountRollbackExecutor, type DiscountSnapshot } from "./createDiscount.js";
import type { Executor, ItemOutcome } from "../plans/executor.js";
import type { ManifestItem } from "../plans/manifest.js";
import type { RollbackTarget } from "./rollbackPlan.js";
import {
  PriceExecutor,
  type PriceManifestItem,
  type PriceManifestPayload,
  type PriceSnapshot,
} from "./updatePrices.js";
import {
  InventoryExecutor,
  type InventoryLevelSnapshot,
  type InventoryManifestItem,
} from "./updateInventory.js";

function toPriceManifestItem(
  item: RollbackTarget<PriceSnapshot>,
): PriceManifestItem {
  return {
    ref: item.ref,
    before: item.before,
    after: item.before,
    payload: {
      variantId: item.before.variantId,
      price: item.before.price,
    } as PriceManifestPayload,
  };
}

export class PriceRollbackExecutor implements Executor<RollbackTarget<PriceSnapshot>, void> {
  constructor(private client: AdminClient) {}

  async execute(item: RollbackTarget<PriceSnapshot>): Promise<ItemOutcome<void>> {
    return new PriceExecutor(this.client).execute(toPriceManifestItem(item));
  }
}

function toInventoryManifestItem(
  item: RollbackTarget<InventoryLevelSnapshot>,
): InventoryManifestItem {
  return {
    ref: item.ref,
    before: item.before,
    after: item.before,
    payload: {
      inventoryItemId: item.before.inventoryItemId,
      quantity: item.before.available,
    },
  };
}

export class InventoryRollbackExecutor
  implements Executor<RollbackTarget<InventoryLevelSnapshot>, void>
{
  constructor(private client: AdminClient) {}

  async execute(item: RollbackTarget<InventoryLevelSnapshot>): Promise<ItemOutcome<void>> {
    const locationId = item.before.locationId;
    return new InventoryExecutor(this.client, locationId).execute(
      toInventoryManifestItem(item),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPriceSnapshot(value: unknown): value is PriceSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.variantId === "string" &&
    typeof value.price === "string" &&
    typeof value.productId === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.tags)
  );
}

function isInventoryLevelSnapshot(value: unknown): value is InventoryLevelSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.inventoryItemId === "string" &&
    typeof value.locationId === "string" &&
    typeof value.available === "number"
  );
}

function isDiscountSnapshot(value: unknown): value is DiscountSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    typeof value.discountType === "string" &&
    typeof value.value === "number"
  );
}

export class ShopifyRollbackExecutor implements Executor<RollbackTarget<unknown>, void> {
  constructor(private client: AdminClient) {}

  async execute(item: RollbackTarget<unknown>): Promise<ItemOutcome<void>> {
    if (isPriceSnapshot(item.before)) {
      return new PriceRollbackExecutor(this.client).execute(
        item as RollbackTarget<PriceSnapshot>,
      );
    }
    if (isInventoryLevelSnapshot(item.before)) {
      return new InventoryRollbackExecutor(this.client).execute(
        item as RollbackTarget<InventoryLevelSnapshot>,
      );
    }
    if (isDiscountSnapshot(item.before)) {
      return new DiscountRollbackExecutor(this.client).execute(
        item as ManifestItem<DiscountSnapshot, DiscountSnapshot>,
      );
    }
    return {
      ref: item.ref,
      ok: false,
      error: {
        code: "ROLLBACK_UNSUPPORTED",
        message: "Cannot roll back an item whose snapshot has an unrecognized shape.",
        hint: "This item's kind does not support rollback.",
      },
    };
  }
}