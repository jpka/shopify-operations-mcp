import type { AdminClientOptions } from "../../src/graphql/adminClient.js";
import type {
  DiscountValueType,
  ExistingDiscount,
} from "../../src/tools/createDiscount.js";

type FetchLike = NonNullable<AdminClientOptions["fetch"]>;

/** The DiscountCodeBasicInput the gateway sends; the toy store parses it. */
export interface ToyBasicCodeInput {
  code: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
  customerGets: {
    value: { percentage?: number; amount?: number };
  };
}

/**
 * Toy Shopify discount API for create_discount tests: an in-memory store of
 * discount codes served behind a fake fetch that speaks the same GraphQL
 * operations the real `ShopifyDiscountGateway` sends (`discountByCode`,
 * `discountCodeBasicCreate`, `discountDeactivate`). The response shapes
 * mirror the Admin API node structure the gateway parses, so the real
 * query/mutation construction and parsing are exercised end-to-end.
 */
export interface ToyDiscountRecord {
  id: string;
  code: string;
  title: string;
  valueType: DiscountValueType;
  value: number;
  usageLimit: number | null;
  appliesOncePerCustomer: boolean;
  startsAt: string | null;
  endsAt: string | null;
  status: "ACTIVE" | "EXPIRED";
}

export class ToyDiscountStore {
  private discounts = new Map<string, ToyDiscountRecord>();
  private nextId = 1;
  private failCodes = new Set<string>();

  /** Pre-seeds a discount; returns the stored copy. */
  seed(discount: Omit<ToyDiscountRecord, "id">): ToyDiscountRecord {
    const record: ToyDiscountRecord = {
      ...discount,
      id: `gid://shopify/DiscountCodeNode/${this.nextId++}`,
    };
    this.discounts.set(record.code, record);
    return { ...record };
  }

  /** Makes create() fail for these codes, simulating per-item API failures. */
  failCreate(...codes: string[]): void {
    for (const code of codes) this.failCodes.add(code);
  }

  get(code: string): ToyDiscountRecord | undefined {
    const record = this.discounts.get(code);
    return record ? { ...record } : undefined;
  }

  has(code: string): boolean {
    return this.discounts.has(code);
  }

  create(
    input: ToyBasicCodeInput,
  ):
    | { ok: true; discount: ToyDiscountRecord }
    | { ok: false; error: { code: string; message: string } } {
    if (this.failCodes.has(input.code)) {
      return {
        ok: false,
        error: {
          code: "SIMULATED_FAILURE",
          message: `toy discount API configured to fail create for ${input.code}`,
        },
      };
    }
    if (this.discounts.has(input.code)) {
      return {
        ok: false,
        error: {
          code: "DUPLICATE",
          message: `A discount with code ${input.code} already exists`,
        },
      };
    }
    const value = input.customerGets.value;
    const isPercentage = value.percentage !== undefined;
    const record: ToyDiscountRecord = {
      id: `gid://shopify/DiscountCodeNode/${this.nextId++}`,
      code: input.code,
      title: input.code,
      valueType: isPercentage ? "PERCENTAGE" : "FIXED_AMOUNT",
      value: (value.percentage ?? value.amount) ?? 0,
      usageLimit: input.usageLimit,
      appliesOncePerCustomer: input.appliesOncePerCustomer,
      startsAt: input.startsAt ?? "2026-08-13T00:00:00Z",
      endsAt: input.endsAt,
      status: "ACTIVE",
    };
    this.discounts.set(record.code, record);
    return { ok: true, discount: { ...record } };
  }

  deactivate(id: string): void {
    for (const [code, record] of this.discounts) {
      if (record.id === id) {
        this.discounts.set(code, { ...record, status: "EXPIRED" });
        return;
      }
    }
  }

  all(): ToyDiscountRecord[] {
    return [...this.discounts.values()].map((record) => ({ ...record }));
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The Admin API node shape the gateway parses back into an ExistingDiscount. */
function nodeOf(record: ToyDiscountRecord) {
  return {
    id: record.id,
    status: record.status,
    codeDiscount: {
      title: record.title,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
      usageLimit: record.usageLimit,
      appliesOncePerCustomer: record.appliesOncePerCustomer,
      customerGets: {
        value:
          record.valueType === "PERCENTAGE"
            ? { __typename: "DiscountPercentage", percentage: record.value }
            : { __typename: "DiscountAmount", amount: record.value },
      },
      codes: { edges: [{ node: { code: record.code } }] },
    },
  };
}

/**
 * A fake fetch that routes the gateway's GraphQL operations against a
 * `ToyDiscountStore`. `log` (when provided) receives every operation name
 * sent, so tests can assert preview performs zero mutation calls.
 */
export function toyDiscountFetch(
  store: ToyDiscountStore,
  log?: { calls: string[] },
): FetchLike {
  return async (_input, init) => {
    const raw = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const opName = /(?:query|mutation)\s+([A-Za-z_]\w*)/.exec(raw.query)?.[1];
    if (opName !== undefined) log?.calls.push(opName);
    switch (opName) {
      case "discountByCode": {
        const code = raw.variables?.code as string;
        const record = store.get(code);
        return jsonResponse({
          data: { codeDiscountNodeByCode: record ? nodeOf(record) : null },
        });
      }
      case "discountCodeBasicCreate": {
        const input = raw.variables?.basicCodeDiscount as ToyBasicCodeInput;
        const result = store.create(input);
        if (!result.ok) {
          return jsonResponse({
            data: {
              discountCodeBasicCreate: {
                codeDiscountNode: null,
                userErrors: [
                  {
                    field: "code",
                    code: result.error.code,
                    message: result.error.message,
                  },
                ],
              },
            },
          });
        }
        return jsonResponse({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: nodeOf(result.discount),
              userErrors: [],
            },
          },
        });
      }
      case "discountDeactivate": {
        const id = raw.variables?.id as string;
        store.deactivate(id);
        return jsonResponse({
          data: { discountDeactivate: { codeDiscountNode: { id }, userErrors: [] } },
        });
      }
      default:
        throw new Error(`toy discount API: unknown operation ${String(opName)}`);
    }
  };
}

/** Convenience: the toy record an ExistingDiscount maps to (for assertions). */
export function toExistingDiscount(record: ToyDiscountRecord): ExistingDiscount {
  return {
    id: record.id,
    code: record.code,
    title: record.title,
    valueType: record.valueType,
    value: record.value,
    usageLimit: record.usageLimit,
    appliesOncePerCustomer: record.appliesOncePerCustomer,
    active: record.status === "ACTIVE",
  };
}