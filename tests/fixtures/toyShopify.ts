import {
  assembleManifest,
  type Manifest,
  type ManifestBuilder,
  type ManifestItem,
  type StateReader,
} from "../../src/plans/manifest.js";
import type { Executor, ItemOutcome } from "../../src/plans/executor.js";

/**
 * Toy Shopify fixtures proving the two-phase framework: an in-memory product
 * store, a builder that reads it into a price-change manifest (pure reads),
 * a state reader that re-reads current values at execute, and an executor
 * that applies the changes. The real Shopify Admin API tools replace these in
 * later tickets; these only need to prove the framework contracts.
 */
export interface ToyProduct {
  id: string;
  title: string;
  price: number;
  tags: string[];
}

/** One planned price change: `before`/`after` are full product snapshots. */
export interface PriceManifestItem
  extends ManifestItem<ToyProduct, ToyProduct, { newPrice: number }> {
  ref: string;
  before: ToyProduct;
  after: ToyProduct;
  payload: { newPrice: number };
}

/**
 * In-memory product store. `get`/`all` return copies so callers cannot
 * mutate the store through a read; `set` is the only mutation path (used by
 * the executor and directly by tests to simulate concurrent writes).
 */
export class ToyStore {
  private products = new Map<string, ToyProduct>();

  constructor(initial: readonly ToyProduct[]) {
    for (const product of initial) this.products.set(product.id, { ...product });
  }

  get(id: string): ToyProduct | undefined {
    const product = this.products.get(id);
    return product ? { ...product } : undefined;
  }

  set(product: ToyProduct): void {
    this.products.set(product.id, { ...product });
  }

  all(): ToyProduct[] {
    return [...this.products.values()].map((product) => ({ ...product }));
  }
}

/** Builds a price-change manifest from agent targets. Reads only — never mutates. */
export class ToyPriceManifestBuilder implements ManifestBuilder<PriceManifestItem> {
  constructor(
    private store: ToyStore,
    private targets: readonly { id: string; newPrice: number }[],
  ) {}

  build(): Manifest<PriceManifestItem> {
    const items: PriceManifestItem[] = [];
    for (const target of this.targets) {
      const before = this.store.get(target.id);
      if (!before) throw new Error(`toy store: product ${target.id} not found`);
      items.push({
        ref: target.id,
        before,
        after: { ...before, price: target.newPrice },
        payload: { newPrice: target.newPrice },
      });
    }
    return assembleManifest(items);
  }
}

/** Re-reads current product state at execute time for the drift check. Reads only. */
export class ToyPriceStateReader implements StateReader<ToyProduct> {
  constructor(private store: ToyStore) {}

  readCurrent(refs: readonly string[]): Promise<Readonly<Record<string, ToyProduct>>> {
    const out: Record<string, ToyProduct> = {};
    for (const ref of refs) {
      const product = this.store.get(ref);
      if (product) out[ref] = product;
    }
    return Promise.resolve(out);
  }
}

/**
 * Applies one price change. `failRefs` simulates per-item failures so tests
 * can prove partial failure is recorded rather than hidden. Fails a missing
 * product; reports failures as outcomes instead of throwing.
 */
export class ToyPriceExecutor implements Executor<PriceManifestItem, void> {
  private failRefs: ReadonlySet<string>;

  constructor(
    private store: ToyStore,
    failRefs: readonly string[] = [],
  ) {
    this.failRefs = new Set(failRefs);
  }

  execute(item: PriceManifestItem): ItemOutcome<void> {
    if (this.failRefs.has(item.ref)) {
      return {
        ref: item.ref,
        ok: false,
        error: {
          code: "SIMULATED_FAILURE",
          message: `toy executor configured to fail ${item.ref}`,
        },
      };
    }
    const current = this.store.get(item.ref);
    if (!current) {
      return {
        ref: item.ref,
        ok: false,
        error: { code: "NOT_FOUND", message: `toy store: no product ${item.ref}` },
      };
    }
    this.store.set(item.after);
    return { ref: item.ref, ok: true };
  }
}