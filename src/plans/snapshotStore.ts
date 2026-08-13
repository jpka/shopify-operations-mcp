/**
 * Holds the per-item before-state of each plan, keyed by plan token, so a
 * later rollback ticket can restore each item to its previewed state. It is
 * a host-side companion to the core's PlanStore: the core tracks the token
 * lifecycle, this store tracks what each token's plan would undo.
 *
 * Entries are bound to the same TTL as the plan token; an expired snapshot
 * reads as absent (pruned on access and on `sweep`), so a snapshot can never
 * outlive the plan it belongs to.
 */
export class SnapshotStore<TBefore = unknown> {
  private entries = new Map<
    string,
    { before: Readonly<Record<string, TBefore>>; expiresAt: number }
  >();

  constructor(private ttlMs: number) {}

  /**
   * Records the previewed before-state of every item in `items` for
   * `planToken`. Overwrites any earlier snapshot for the same token.
   */
  capture(
    planToken: string,
    items: readonly Readonly<{ ref: string; before: TBefore }>[],
  ): void {
    const before: Record<string, TBefore> = {};
    for (const item of items) before[item.ref] = item.before;
    this.entries.set(planToken, {
      before,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * The per-item before-state captured for `planToken`, or null when no
   * snapshot exists or it has expired. Expired entries are pruned on read.
   */
  snapshot(planToken: string): Readonly<Record<string, TBefore>> | null {
    const entry = this.entries.get(planToken);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(planToken);
      return null;
    }
    return entry.before;
  }

  /** True when a live snapshot exists for `planToken`. */
  has(planToken: string): boolean {
    return this.snapshot(planToken) !== null;
  }

  /** Drops the snapshot for `planToken` if one exists. Idempotent. */
  drop(planToken: string): void {
    this.entries.delete(planToken);
  }

  /** Removes expired snapshots. Called automatically on every `capture`. */
  sweep(): void {
    const now = Date.now();
    for (const [planToken, entry] of this.entries) {
      if (now > entry.expiresAt) this.entries.delete(planToken);
    }
  }
}