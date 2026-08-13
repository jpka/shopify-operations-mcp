import type { ManifestItem } from "./manifest.js";

/** Structured per-item failure detail, mirroring the host error convention. */
export interface ItemError {
  code: string;
  message: string;
  hint?: string;
}

/**
 * The outcome of one item attempt. Per-item failures are recorded, never
 * hidden: an executor reports `ok: false` with the structured `error` rather
 * than throwing, so a partial failure surfaces in the ledger instead of
 * aborting the remaining items.
 */
export interface ItemOutcome<TResult = unknown> {
  ref: string;
  ok: boolean;
  result?: TResult;
  error?: ItemError;
}

/**
 * The per-item success/failure ledger an execution produces. Every attempted
 * item appears exactly once in `attempted` (in manifest order); `succeeded`
 * and `failed` are the subsets. Partial failure is therefore visible on the
 * result, never swallowed by an all-or-nothing throw.
 */
export interface ExecutionLedger<TResult = unknown> {
  attempted: readonly ItemOutcome<TResult>[];
  succeeded: readonly ItemOutcome<TResult>[];
  failed: readonly ItemOutcome<TResult>[];
}

/**
 * The write half of the two-phase pattern. `execute` attempts one item and
 * reports its outcome; it must not throw for a per-item failure — a thrown
 * executor is treated by the plan manager as an internal error on that item,
 * and the rest of the plan still runs to completion so the failure is
 * recorded.
 */
export interface Executor<TItem extends ManifestItem = ManifestItem, TResult = unknown> {
  execute(item: TItem): Promise<ItemOutcome<TResult>> | ItemOutcome<TResult>;
}

/**
 * Runs `executor` over every item in order, collecting a per-item ledger.
 * A throw from `executor` (or from an item payload) is caught and recorded
 * as an INTERNAL_ERROR failure on that item so the plan finishes with a
 * complete, honest ledger rather than an aborted run.
 */
export async function runLedger<TItem extends ManifestItem, TResult>(
  items: readonly TItem[],
  executor: Executor<TItem, TResult>,
): Promise<ExecutionLedger<TResult>> {
  const attempted: ItemOutcome<TResult>[] = [];
  for (const item of items) {
    let outcome: ItemOutcome<TResult>;
    try {
      outcome = await executor.execute(item);
    } catch (err) {
      outcome = {
        ref: item.ref,
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    attempted.push(outcome);
  }
  return {
    attempted,
    succeeded: attempted.filter((o) => o.ok),
    failed: attempted.filter((o) => !o.ok),
  };
}