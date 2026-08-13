import { fingerprint } from "safe-write-mcp-core";

/**
 * One planned change in a manifest: `before` is the item's state as read at
 * preview time, `after` is what it becomes when executed, and `payload` is
 * the host's opaque per-item execution instructions (what the real Shopify
 * tools will build from agent-supplied arguments). A preview only ever reads
 * `before` — constructing a manifest performs zero mutation calls.
 */
export interface ManifestItem<TBefore = unknown, TAfter = unknown, TPayload = unknown> {
  /** Stable identifier for the item being changed (e.g. a product id). */
  ref: string;
  /** The item's state at preview time. */
  before: TBefore;
  /** The item's state after this change is applied. */
  after: TAfter;
  /** Opaque per-item execution instructions consumed by the executor. */
  payload?: TPayload;
}

/**
 * The preview artifact of the two-phase pattern, produced by a
 * `ManifestBuilder`. `digest` fingerprints the whole manifest (refs, before
 * and after values) for rendering/comparison; `beforeDigest` fingerprints
 * only the ref→before pairs and is the drift reference: at execute time the
 * current state is re-read and must reproduce `beforeDigest`, or the change
 * is refused with STATE_CHANGED (the port of sw-postgres-mcp's ROWSET_CHANGED).
 */
export interface Manifest<TItem extends ManifestItem = ManifestItem> {
  items: readonly TItem[];
  digest: string;
  beforeDigest: string;
}

/**
 * A manifest builder performs pure reads only: it reads current state and
 * returns a `Manifest` describing the planned changes without mutating
 * anything. The executor is the only thing that ever performs writes, and it
 * is never invoked during a preview.
 */
export interface ManifestBuilder<TItem extends ManifestItem = ManifestItem> {
  build(): Promise<Manifest<TItem>> | Manifest<TItem>;
}

/**
 * Re-reads the current value of a set of refs at execute time. Shares the
 * read-only contract of `ManifestBuilder`; used by the STATE_CHANGED drift
 * check to recompute `beforeDigest` over live data. Missing refs are
 * deliberately absent from the result — a disappeared item is a drift.
 */
export interface StateReader<TBefore = unknown> {
  readCurrent(refs: readonly string[]): Promise<Readonly<Record<string, TBefore>>>;
}

/**
 * Canonical digest over the ref→before pairs of a manifest. Array order is
 * significant (it mirrors the manifest's item order, which is stable between
 * preview and execute because the core binds the token to a fingerprint of
 * the exact manifest), so identical preview/re-execute reads always produce
 * the same hash and any drift produces a different one.
 */
export function beforeDigestOf(
  items: readonly Readonly<{ ref: string; before: unknown }>[],
): string {
  const rows = items.map(({ ref, before }) => ({ ref, before }));
  return fingerprint({ before: rows });
}

/**
 * Canonical digest over a full manifest (items with ref, before and after).
 * Serves as a stable preview identifier for the host's approval surface;
 * distinct from `beforeDigest`, which is the drift check's reference.
 */
export function manifestDigest<TItem extends ManifestItem>(
  items: readonly TItem[],
): string {
  return fingerprint({ items });
}

/**
 * Builds a `Manifest` from already-assembled items: computes both digests.
 * Used by `ManifestBuilder` implementations (including the toy in tests) and
 * by the executor's re-read path.
 */
export function assembleManifest<TItem extends ManifestItem>(
  items: readonly TItem[],
): Manifest<TItem> {
  return {
    items,
    digest: manifestDigest(items),
    beforeDigest: beforeDigestOf(items),
  };
}