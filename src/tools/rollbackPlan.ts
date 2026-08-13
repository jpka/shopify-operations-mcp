/**
 * One-call rollback: undo a committed reversible plan in one call.
 *
 * Given an executed plan's token, `rollbackPlan` re-applies the snapshot's
 * per-item `before` values as inverse mutations — restoring prices and
 * inventory, deactivating/deleting discounts — the exact reverse of what
 * `execute_plan` applied. Restoring the prior state is the safe direction, so
 * rollback requires no approval: there is nothing for a human gate to add.
 *
 * Rollback is host-side tracking in the same spirit as the framework's
 * PlanStore and this repo's SnapshotStore: the core owns the token lifecycle
 * (and the token is long consumed by the time a rollback is meaningful), this
 * module owns the per-plan undo decision. Two guards keep it honest:
 *
 * - ROLLBACK_UNSUPPORTED — the plan's operation kind is not reversible.
 *   cancel_order / refund_order are state transitions, not value changes;
 *   re-applying a `before` value cannot uncancel an order or unwire a
 *   payment. Also refused when the host has no executed-plan record for the
 *   token (it was never executed, or the host never tracked it).
 * - ROLLBACK_WINDOW_EXPIRED — no live snapshot remains, either because the
 *   `rollbackTtlMs` window (default 24 h) has passed or the token was never a
 *   previewed plan. The snapshot store passed in must be TTL'd to the rollback
 *   window (see SnapshotStore), which is what makes a past-window snapshot
 *   read as absent.
 *
 * Only refs whose mutation *actually succeeded* at execute time are restored
 * (the inverse-mutation target list the execute ledger's successes produce);
 * a ref that failed at execute is left untouched — its current value already
 * is the before value, and overwriting it would clobber any drift. Partial
 * rollback failure is recorded on the ledger, never hidden, and the audit row
 * carries the same per-item ledger shape as an executed plan.
 */
import { NoopSink } from "safe-write-mcp-core";
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";
import { DEFAULT_CALLER_ID } from "../config.js";
import { runLedger } from "../plans/executor.js";
import type { ExecutionLedger, Executor } from "../plans/executor.js";
import type { ManifestItem } from "../plans/manifest.js";
import type { SnapshotStore } from "../plans/snapshotStore.js";

/** The operation kind a plan executed (e.g. "update_prices", "cancel_order"). */
export type PlanKind = string;

/**
 * What the host tracked for an executed plan token: the operation kind (which
 * decides whether rollback is supported) and the refs whose mutation actually
 * succeeded at execute time (which decide the inverse-mutation target list).
 */
export interface ExecutedPlan {
  kind: PlanKind;
  executedRefs: readonly string[];
}

/** Host-side rollback error codes, complementing the core's token lifecycle
 * codes and this repo's ExecutionError codes. */
export type RollbackErrorCode =
  | "ROLLBACK_UNSUPPORTED"
  | "ROLLBACK_WINDOW_EXPIRED";

/**
 * Structured rollback error, mirroring the host error convention: `code` is
 * machine-actionable, `message` is human-readable, `hint` tells the caller
 * what to do next. Never expose a raw exception from a deeper layer.
 */
export class RollbackError extends Error {
  readonly code: RollbackErrorCode;
  readonly hint?: string;

  constructor(code: RollbackErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "RollbackError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * One snapshot row reshaped as an inverse-mutation target. `after` is the
 * `before` value itself — restoring a value means writing it back.
 */
export interface RollbackTarget<TBefore = unknown>
  extends ManifestItem<TBefore, TBefore> {
  ref: string;
  before: TBefore;
  after: TBefore;
}

export interface RollbackPlanOptions<TBefore = unknown, TResult = unknown> {
  /**
   * Per-plan before-state store, TTL'd to the rollback window. A snapshot
   * that reads as absent (never previewed, or past `rollbackTtlMs`) is what
   * triggers ROLLBACK_WINDOW_EXPIRED.
   */
  snapshotStore: SnapshotStore<TBefore>;
  /**
   * Resolves what the host executed for a plan token, or null when the host
   * has no record (token never executed, or no longer tracked). The record's
   * kind drives the ROLLBACK_UNSUPPORTED check and its `executedRefs` drive
   * the inverse-mutation target list.
   */
  executedOf: (planToken: string) => ExecutedPlan | null;
  /**
   * Operation kinds that rollback may restore (reversible value changes:
   * prices, inventory, discounts). Defaults to none — fail-closed until a
   * host tool lists its kind.
   */
  supportedKinds?: readonly PlanKind[];
  /**
   * Restores one item's before-state. The write half of rollback; only ever
   * invoked after the window and kind guards pass. Must report a per-item
   * failure as an outcome instead of throwing (see Executor).
   */
  executor: Executor<RollbackTarget<TBefore>, TResult>;
  /** Audit sink for host-emitted transitions. Defaults to the core's NoopSink. */
  audit?: AuditSink;
  /** Identity recorded as callerId when a rollback call omits one. Default "unknown". */
  callerId?: string;
}

export interface RollbackResult<TResult = unknown> {
  status: "rolled_back";
  itemCount: number;
  /** Per-item success/failure ledger. Partial failure is recorded, never hidden. */
  ledger: ExecutionLedger<TResult>;
  succeededCount: number;
  failedCount: number;
  refs: readonly string[];
}

/**
 * The one-call rollback orchestrator: snapshot lookup (window guard) → kind
 * check (supportedness guard) → per-item inverse mutations over the executed
 * refs → audit. No approval is consulted anywhere in the path.
 */
export class RollbackPlan<TBefore = unknown, TResult = unknown> {
  private audit: AuditSink;
  private callerId: string;
  private supportedKinds: ReadonlySet<PlanKind>;

  constructor(private opts: RollbackPlanOptions<TBefore, TResult>) {
    this.audit = opts.audit ?? NoopSink;
    this.callerId = opts.callerId ?? DEFAULT_CALLER_ID;
    this.supportedKinds = new Set(opts.supportedKinds ?? []);
  }

  /**
   * Undoes an executed plan in one call. Refuses with ROLLBACK_WINDOW_EXPIRED
   * when no live snapshot remains and with ROLLBACK_UNSUPPORTED when the
   * operation kind (or the executed-plan record itself) is absent. Otherwise
   * re-applies the before-values of every ref that actually succeeded at
   * execute time and audits the per-item ledger as `rolled_back`.
   */
  async rollback(planToken: string): Promise<RollbackResult<TResult>> {
    const startedAt = Date.now();
    const before = this.opts.snapshotStore.snapshot(planToken);
    if (before === null) {
      this.emit(
        startedAt,
        planToken,
        "refused",
        null,
        "ROLLBACK_WINDOW_EXPIRED: no live snapshot remains for this plan",
      );
      throw new RollbackError(
        "ROLLBACK_WINDOW_EXPIRED",
        "The rollback window for this plan has expired, or the plan was never previewed.",
        "Rollback is only possible within rollbackTtlMs of the write; re-run the operation to get a fresh plan and token.",
      );
    }

    const executed = this.opts.executedOf(planToken);
    if (executed === null) {
      this.emit(
        startedAt,
        planToken,
        "refused",
        null,
        "ROLLBACK_UNSUPPORTED: no executed-plan record exists for this token",
      );
      throw new RollbackError(
        "ROLLBACK_UNSUPPORTED",
        "No executed-plan record exists for this token.",
        "Rollback applies only to plans this server executed; re-run the operation to get a fresh plan and token.",
      );
    }
    if (!this.supportedKinds.has(executed.kind)) {
      this.emit(
        startedAt,
        planToken,
        "refused",
        null,
        `ROLLBACK_UNSUPPORTED: operation kind "${executed.kind}" cannot be rolled back`,
      );
      throw new RollbackError(
        "ROLLBACK_UNSUPPORTED",
        `Plans of kind "${executed.kind}" cannot be rolled back.`,
        "cancel_order and refund_order are state transitions, not value changes — re-applying a before value cannot uncancel an order or unwire a payment.",
      );
    }

    const items = executed.executedRefs
      .filter((ref) => ref in before)
      .map((ref) => {
        const value = before[ref]!;
        return { ref, before: value, after: value } satisfies RollbackTarget<TBefore>;
      });

    const ledger = await runLedger(items, this.opts.executor);
    this.emit(
      startedAt,
      planToken,
      "rolled_back",
      items.length,
      ledgerDetail(ledger),
    );

    return {
      status: "rolled_back",
      itemCount: items.length,
      ledger,
      succeededCount: ledger.succeeded.length,
      failedCount: ledger.failed.length,
      refs: items.map((item) => item.ref),
    };
  }

  /**
   * Emits a host-driven transition to the audit sink with the same
   * never-throw contract as the core's own emit: a lost audit row must never
   * be confused with a rollback that didn't happen.
   */
  private emit(
    startedAt: number,
    planToken: string,
    status: AuditEvent["status"],
    previewCount: number | null,
    detail: string | null,
  ): void {
    const event: AuditEvent = {
      ts: Date.now(),
      tool: "rollback_plan",
      reason: null,
      planToken,
      status,
      previewCount,
      callerId: this.callerId,
      durationMs: Date.now() - startedAt,
      detail,
    };
    try {
      this.audit.record(event);
    } catch (err) {
      process.stderr.write(`audit sink failed: ${String(err)}\n`);
    }
  }
}

/** The per-item ledger as the rolled_back audit row's detail. */
function ledgerDetail<TResult>(ledger: ExecutionLedger<TResult>): string {
  return JSON.stringify({
    succeeded: ledger.succeeded.length,
    failed: ledger.failed.length,
    items: ledger.attempted.map((o) => ({
      ref: o.ref,
      ok: o.ok,
      code: o.error?.code ?? null,
      message: o.error?.message ?? null,
    })),
  });
}