import type {
  AuditEvent,
  AuditSink,
  PlanMeta,
  PlanStore,
} from "safe-write-mcp-core";
import { NoopSink } from "safe-write-mcp-core";
import {
  DEFAULT_APPROVAL_REQUIRED_ABOVE_ITEMS,
  DEFAULT_CALLER_ID,
  DEFAULT_HARD_MAX_ITEMS,
  DEFAULT_PLAN_TTL_MS,
} from "../config.js";
import { ExecutionError } from "./errors.js";
import {
  runLedger,
  type Executor,
  type ExecutionLedger,
} from "./executor.js";
import {
  beforeDigestOf,
  type Manifest,
  type ManifestBuilder,
  type ManifestItem,
  type StateReader,
} from "./manifest.js";
import { SnapshotStore } from "./snapshotStore.js";

/** Host-side decisions that shape a preview: approval gating and the hard cap. */
export interface PlanManagerOptions<
  TItem extends ManifestItem,
  TBefore = unknown,
  TResult = unknown,
> {
  /** Core plan store that owns the token lifecycle. */
  store: PlanStore<Manifest<TItem>>;
  /** Write half; only ever invoked at execute time, never during preview. */
  executor: Executor<TItem, TResult>;
  /** Read half for the execute-time STATE_CHANGED drift check. */
  stateReader: StateReader<TBefore>;
  /** Per-plan before-state store for rollback. Defaults to a store on `planTtlMs`. */
  snapshotStore?: SnapshotStore<TBefore>;
  /** Audit sink for host-emitted transitions. Defaults to the core's NoopSink. */
  audit?: AuditSink;
  /** Identity recorded as callerId when a preview call omits one. Default "unknown". */
  callerId?: string;
  /** Snapshot TTL and PlanStore TTL must agree; used for the default snapshot store. Default 60_000. */
  planTtlMs?: number;
  /** A plan touching at least this many items requires human approval. Default 25. */
  approvalRequiredAboveItems?: number;
  /** A plan touching more than this many items is refused — no token issued. Default 250. */
  hardMaxItems?: number;
}

export interface PreviewOptions {
  /** The MCP tool driving the preview; recorded on the plan and audit rows. */
  tool: string;
  reason?: string | null;
  callerId?: string;
  /**
   * Forces `status: "awaiting_approval"` regardless of item count. Must only
   * be set true by a tool module's own code, never from agent arguments —
   * the mechanism future tickets use for always-gated operations.
   */
  alwaysRequireApproval?: boolean;
}

export interface PreviewResult<TItem extends ManifestItem> {
  planToken: string;
  status: "previewed" | "awaiting_approval";
  expiresAt: number;
  /** The exact manifest the token is bound to; execute_plan must pass it back. */
  manifest: Manifest<TItem>;
  itemCount: number;
}

export interface ExecuteResult<TItem extends ManifestItem, TResult = unknown> {
  status: "executed";
  itemCount: number;
  /** Per-item success/failure ledger. Partial failure is recorded, never hidden. */
  ledger: ExecutionLedger<TResult>;
  succeededCount: number;
  failedCount: number;
  refs: readonly string[];
}

/**
 * The host-side orchestrator of the two-phase pattern, wired in the order the
 * core and the sibling repo prescribe: plan creation from a previewed
 * manifest (pure reads, zero mutation), then — on execute — re-read current
 * state, core beginExecute → STATE_CHANGED drift check → per-item executor →
 * core confirmExecuted → audit.
 *
 * execute_plan wiring: the MCP tool layer is a later ticket (the server and
 * its @modelcontextprotocol/sdk dependency land there); `executePlan` is the
 * exact handler body that tool will call — begin the token from the core,
 * refuse on drift, run the executor with a per-item ledger, confirm the
 * execution, emit the host audit row — mirroring sw-postgres-mcp's `TwoPhaseWrite.execute`.
 */
export class PlanManager<
  TItem extends ManifestItem<TBefore>,
  TBefore = unknown,
  TResult = unknown,
> {
  private store: PlanStore<Manifest<TItem>>;
  private executor: Executor<TItem, TResult>;
  private stateReader: StateReader<TBefore>;
  private snapshotStore: SnapshotStore<TBefore>;
  private audit: AuditSink;
  private callerId: string;
  private approvalRequiredAboveItems: number;
  private hardMaxItems: number;

  constructor(private opts: PlanManagerOptions<TItem, TBefore, TResult>) {
    this.store = opts.store;
    this.executor = opts.executor;
    this.stateReader = opts.stateReader;
    this.snapshotStore =
      opts.snapshotStore ??
      new SnapshotStore<TBefore>(opts.planTtlMs ?? DEFAULT_PLAN_TTL_MS);
    this.audit = opts.audit ?? NoopSink;
    this.callerId = opts.callerId ?? DEFAULT_CALLER_ID;
    this.approvalRequiredAboveItems =
      opts.approvalRequiredAboveItems ?? DEFAULT_APPROVAL_REQUIRED_ABOVE_ITEMS;
    this.hardMaxItems = opts.hardMaxItems ?? DEFAULT_HARD_MAX_ITEMS;
  }

  /**
   * Preview: build the manifest (pure reads), gate it against the hard cap,
   * create a core plan bound to the manifest and its before-digest, and keep
   * the per-item before-state on the snapshot store for rollback. The
   * executor is never called — a preview performs zero mutation calls.
   */
  async preview(
    builder: ManifestBuilder<TItem>,
    options: PreviewOptions,
  ): Promise<PreviewResult<TItem>> {
    const startedAt = Date.now();
    const reason = options.reason ?? null;
    const callerId = options.callerId ?? this.callerId;

    const manifest = await builder.build();
    const itemCount = manifest.items.length;

    if (itemCount > this.hardMaxItems) {
      const meta: PlanMeta = {
        tool: options.tool,
        reason,
        callerId,
        previewCount: itemCount,
        dataDigest: null,
        extra: {},
      };
      this.emit(startedAt, null, "refused", meta, `HARD_MAX_ITEMS_EXCEEDED`);
      throw new ExecutionError(
        "HARD_MAX_ITEMS_EXCEEDED",
        `This plan touches ${itemCount} items, above the hard cap of ${this.hardMaxItems}. No plan token was issued and there is no approval path for this.`,
        "Narrow the operation to affect fewer items, then re-preview.",
      );
    }

    const created = this.store.create(manifest, {
      tool: options.tool,
      reason,
      callerId,
      previewCount: itemCount,
      dataDigest: manifest.beforeDigest,
      extra: { digest: manifest.digest },
      alwaysRequireApproval: options.alwaysRequireApproval,
      approvalRequired: itemCount >= this.approvalRequiredAboveItems,
    });

    this.snapshotStore.capture(created.planToken, manifest.items);

    return {
      planToken: created.planToken,
      status: created.status,
      expiresAt: created.expiresAt,
      manifest,
      itemCount,
    };
  }

  /**
   * Execute: re-read current values, begin the token in the core (single-use,
   * expiry, fingerprint, data-digest, approval gates), refuse with
   * STATE_CHANGED if the before-digest no longer matches the preview's, then
   * run the per-item executor, confirm the execution, and emit the host audit
   * row.
   *
   * The core enforces the digest itself: `beginExecute` is given the freshly
   * re-read digest and fails closed with DATA_DIGEST_MISMATCH on any drift,
   * which is translated here to the host's STATE_CHANGED error so the
   * observable contract (code, refused audit row, executor never called) is
   * unchanged. A drift-refused token was never begun, so — unlike the old
   * one-step consume — it stays valid until its TTL; re-preview for a fresh
   * token rather than retrying a stale picture.
   *
   * Crash safety follows the core's two-step handoff: the `executed` audit
   * event (core and host rows alike) is only emitted after the ledger
   * completes, so it is never causally disconnected from side effects that
   * really ran. A ledger that completes — even with per-item failures — is
   * confirmed (single-use is preserved: retrying would double-apply the
   * succeeded items). An unexpected throw out of the ledger is an unknown
   * outcome, so the token is deliberately left `executing` (queryable via
   * `listExecuting`, reconcilable) rather than confirmed either way.
   */
  async executePlan(
    planToken: string,
    manifest: Manifest<TItem>,
  ): Promise<ExecuteResult<TItem, TResult>> {
    const startedAt = Date.now();

    const current = await this.stateReader.readCurrent(
      manifest.items.map((item) => item.ref),
    );

    // For create operations (all items have before === null), skip the
    // STATE_CHANGED drift check: there is no prior state to compare against.
    // The beforeDigest was computed with null (item did not exist); after
    // execute the state reader returns the created item, so digests differ
    // by design — the "drift" is the intended create. The preview's digest
    // is passed through as the current one, asserting "nothing to compare".
    const isPureCreate = manifest.items.every((item) => item.before === null);
    const currentDigest = isPureCreate
      ? manifest.beforeDigest
      : beforeDigestOf(
          manifest.items.map((item) => ({
            ref: item.ref,
            before: current[item.ref],
          })),
        );

    const begun = this.store.beginExecute(planToken, manifest, currentDigest);
    if (!begun.ok) {
      if (begun.error.code === "DATA_DIGEST_MISMATCH") {
        // Defensive fallback: the core only reaches the digest gate for a
        // token it found, so meta is non-null on this path in practice.
        const meta = begun.meta ?? {
          tool: "unknown",
          reason: null,
          callerId: this.callerId,
          previewCount: manifest.items.length,
          dataDigest: null,
          extra: {},
        };
        this.emit(
          startedAt,
          planToken,
          "refused",
          meta,
          `STATE_CHANGED: the current state of one or more items differs from the previewed state`,
        );
        throw new ExecutionError(
          "STATE_CHANGED",
          "The current state of one or more items differs from what was previewed.",
          "Another write changed matching data since the preview. Re-run the preview to obtain a fresh plan and token.",
        );
      }
      // Every other gate refusal (rejected, used, expired, fingerprint
      // mismatch, awaiting approval) keeps the core's own error shape — the
      // core already audited the "failed" transition for this refusal.
      throw begun.error;
    }
    const meta = begun.meta;

    const ledger = await runLedger(manifest.items, this.executor);
    const confirmed = this.store.confirmExecuted(planToken);
    if (!confirmed.ok) {
      // Unreachable in-process: nothing between beginExecute and
      // confirmExecuted can settle this token (the ledger performs side
      // effects, not plan transitions). Emit before throwing so an execution
      // whose mutations already applied is never invisible in this server's
      // own audit trail — the core error alone would leave no host row.
      this.emit(
        startedAt,
        planToken,
        "executed",
        meta,
        `CONFIRM_FAILED (${confirmed.error.code}) after the ledger completed ` +
          `(succeeded=${ledger.succeeded.length}, failed=${ledger.failed.length}); ` +
          `side effects may have applied — do not blindly retry`,
      );
      throw confirmed.error;
    }
    this.emit(
      startedAt,
      planToken,
      "executed",
      meta,
      ledgerDetail(ledger, manifest.items.length),
    );

    return {
      status: "executed",
      itemCount: manifest.items.length,
      ledger,
      succeededCount: ledger.succeeded.length,
      failedCount: ledger.failed.length,
      refs: manifest.items.map((item) => item.ref),
    };
  }

  /**
   * Emits a host-driven transition to the audit sink with the same
   * never-throw contract as the core's own emit. `planToken` is null for
   * pre-token refusals (e.g. the hard cap).
   */
  private emit(
    startedAt: number,
    planToken: string | null,
    status: AuditEvent["status"],
    meta: PlanMeta,
    detail: string | null,
  ): void {
    const event: AuditEvent = {
      ts: Date.now(),
      tool: meta.tool,
      reason: meta.reason,
      planToken,
      status,
      previewCount: meta.previewCount,
      callerId: meta.callerId,
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

/** Human- and machine-readable detail for the executed audit row. */
function ledgerDetail<TResult>(
  ledger: ExecutionLedger<TResult>,
  itemCount: number,
): string {
  if (ledger.failed.length === 0) {
    return `all ${itemCount} item(s) executed`;
  }
  return JSON.stringify({
    succeeded: ledger.succeeded.length,
    failed: ledger.failed.length,
    failures: ledger.failed.map((o) => ({
      ref: o.ref,
      code: o.error?.code ?? null,
      message: o.error?.message ?? null,
    })),
  });
}