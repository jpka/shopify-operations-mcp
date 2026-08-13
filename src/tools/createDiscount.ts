/**
 * create_discount: two-phase discount creation tool.
 *
 * Previews planned discount creation (pure reads, zero mutation), then executes
 * via the `discountCodeBasicCreate` Shopify mutation. The discount is created
 * with the specified code, type (percentage or fixed amount), and optional
 * usage limits. Reversible via deactivate/delete, so the snapshot store +
 * rollback plan cover it. Normal item-count thresholds apply (> 25
 * approvalRequiredAboveItems -> awaiting_approval, > 250 hardMaxItems ->
 * HARD_MAX_ITEMS_EXCEEDED).
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

export type DiscountType = "percentage" | "fixed_amount";

export interface CreateDiscountArgs {
  /**
   * The discount code to create (e.g. "SUMMER20").
   */
  code: string;
  /**
   * The type of discount: "percentage" for a percentage discount, or
   * "fixed_amount" for a fixed monetary amount off.
   */
  discountType: DiscountType;
  /**
   * The value of the discount. For "percentage", this is a number between 0
   * and 100 (e.g. 20 for 20% off). For "fixed_amount", this is a decimal
   * amount in the shop's currency (e.g. 10.00 for $10 off).
   */
  value: number;
  /**
   * Optional maximum number of times this discount can be used in total.
   * Null means unlimited usage.
   */
  usageLimit?: number | null;
}

export interface DiscountSnapshot {
  code: string;
  discountType: DiscountType;
  value: number;
  usageLimit: number | null;
  status: "active" | "deactivated" | "deleted";
}

export interface DiscountManifestItem
  extends ManifestItem<DiscountSnapshot | null, DiscountSnapshot, CreateDiscountArgs> {
  ref: string;
  before: DiscountSnapshot | null;
  after: DiscountSnapshot;
  payload: CreateDiscountArgs;
}

interface RawDiscountNode {
  id: string;
  code: string;
  discountType: string;
  value: string;
  usageLimit: number | null;
  status: string;
}

const GET_DISCOUNT_QUERY = /* GraphQL */ `
  query GetDiscount($code: String!) {
    discount(code: $code) {
      ... on DiscountCode {
        id
        code
        discountType
        value
        usageLimit
        status
      }
    }
  }
`;

const DISCOUNT_CODE_BASIC_CREATE_MUTATION = /* GraphQL */ `
  mutation DiscountCodeBasicCreate($input: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(input: $input) {
      discount {
        id
        code
        discountType
        value
        usageLimit
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DISCOUNT_CODE_BASIC_DEACTIVATE_MUTATION = /* GraphQL */ `
  mutation DiscountCodeBasicDeactivate($id: ID!) {
    discountCodeBasicDeactivate(id: $id) {
      discount {
        id
        code
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function fetchDiscountByCode(
  client: AdminClient,
  code: string,
): Promise<RawDiscountNode | null> {
  try {
    const data = await client.graphql<{
      discount: RawDiscountNode | null;
    }>({
      query: GET_DISCOUNT_QUERY,
      variables: { code },
      cost: 1,
    });
    return data.discount;
  } catch {
    return null;
  }
}

export class DiscountManifestBuilder implements ManifestBuilder<DiscountManifestItem> {
  constructor(
    private client: AdminClient,
    private args: CreateDiscountArgs,
    private config: AppConfig,
  ) {}

  async build(): Promise<Manifest<DiscountManifestItem>> {
    const existing = await fetchDiscountByCode(this.client, this.args.code);
    if (existing) {
      throw new Error(
        `Discount code "${this.args.code}" already exists. ` +
          `Use a different code or deactivate the existing one before creating a new discount.`,
      );
    }

    const manifestItem: DiscountManifestItem = {
      ref: this.args.code,
      before: null,
      after: {
        code: this.args.code,
        discountType: this.args.discountType,
        value: this.args.value,
        usageLimit: this.args.usageLimit ?? null,
        status: "active",
      },
      payload: { ...this.args },
    };

    return assembleManifest([manifestItem]);
  }
}

export class DiscountStateReader implements StateReader<DiscountSnapshot | null> {
  constructor(private client: AdminClient) {}

  async readCurrent(
    refs: readonly string[],
  ): Promise<Readonly<Record<string, DiscountSnapshot | null>>> {
    const out: Record<string, DiscountSnapshot | null> = {};
    for (const code of refs) {
      const discount = await fetchDiscountByCode(this.client, code);
      if (discount) {
        out[code] = {
          code: discount.code,
          discountType: discount.discountType.toLowerCase() as DiscountType,
          value: parseFloat(discount.value),
          usageLimit: discount.usageLimit,
          status: discount.status.toLowerCase() as "active" | "deactivated" | "deleted",
        };
      }
    }
    return out;
  }
}

export class DiscountExecutor implements Executor<DiscountManifestItem, void> {
  private readonly chunkSize: number;

  constructor(
    private client: AdminClient,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
  ) {
    this.chunkSize = chunkSize;
  }

  async execute(item: DiscountManifestItem): Promise<ItemOutcome<void>> {
    return this.executeBatch([item]).then((b) => b[0]!);
  }

  private async executeBatch(
    items: readonly DiscountManifestItem[],
  ): Promise<ItemOutcome<void>[]> {
    const ledger: ItemOutcome<void>[] = [];
    const batches = chunk(items, this.chunkSize);

    for (const batch of batches) {
      for (const item of batch) {
        try {
          const data = await this.client.graphql<{
            discountCodeBasicCreate: {
              discount: RawDiscountNode | null;
              userErrors: Array<{ field: string[]; message: string }>;
            };
          }>({
            query: DISCOUNT_CODE_BASIC_CREATE_MUTATION,
            variables: {
              input: {
                code: item.payload.code,
                discountType: item.payload.discountType.toUpperCase(),
                value: String(item.payload.value),
                usageLimit: item.payload.usageLimit,
              },
            },
            cost: 1,
          });

          const result = data.discountCodeBasicCreate;

          if (result.userErrors.length > 0) {
            ledger.push({
              ref: item.ref,
              ok: false,
              error: {
                code: "SHOPIFY_USER_ERROR",
                message: result.userErrors[0]!.message,
                hint: `Field: ${result.userErrors[0]!.field.join(".")}`,
              },
            });
            continue;
          }

          if (!result.discount) {
            ledger.push({
              ref: item.ref,
              ok: false,
              error: {
                code: "SHOPIFY_API_ERROR",
                message: "Discount was not created: no discount returned from API.",
              },
            });
            continue;
          }

          ledger.push({ ref: item.ref, ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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

export class DiscountRollbackExecutor implements Executor<ManifestItem<DiscountSnapshot, DiscountSnapshot>, void> {
  constructor(private client: AdminClient) {}

  async execute(
    item: ManifestItem<DiscountSnapshot, DiscountSnapshot>,
  ): Promise<ItemOutcome<void>> {
    const code = item.ref;
    try {
      const discount = await fetchDiscountByCode(this.client, code);
      if (!discount) {
        return { ref: code, ok: true };
      }

      const data = await this.client.graphql<{
        discountCodeBasicDeactivate: {
          discount: { id: string; code: string; status: string } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>({
        query: DISCOUNT_CODE_BASIC_DEACTIVATE_MUTATION,
        variables: { id: discount.id },
        cost: 1,
      });

      const result = data.discountCodeBasicDeactivate;

      if (result.userErrors.length > 0) {
        return {
          ref: code,
          ok: false,
          error: {
            code: "SHOPIFY_USER_ERROR",
            message: result.userErrors[0]!.message,
            hint: `Field: ${result.userErrors[0]!.field.join(".")}`,
          },
        };
      }

      return { ref: code, ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ref: code,
        ok: false,
        error: { code: "SHOPIFY_API_ERROR", message },
      };
    }
  }
}
