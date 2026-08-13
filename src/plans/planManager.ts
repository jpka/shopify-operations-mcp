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
 * manifest (pure reads, zero mutation), then — on execute — core consume →
 * STATE_CHANGED drift check → per-item executor → audit.
 *
 * execute_plan wiring: the MCP tool layer is a later ticket (the server and
 * its @modelcontextprotocol/sdk dependency land there); `executePlan` is the
 * exact handler body that tool will call — consume the token from the core,
 * refuse on drift, run the executor with a per-item ledger, emit the host
 * audit row — mirroring sw-postgres-mcp's `TwoPhaseWrite.execute`.
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
   * Execute: consume the token (single-use, expiry, fingerprint, approval),
   * re-read current values and refuse with STATE_CHANGED if the before-digest
   * no longer matches the preview's, then run the per-item executor and emit
   * the host audit row. A failure never marks the token usable again, and a
   * refused (drifted) plan's token is consumed just as in the sibling repo —
   * re-preview to get a fresh one.
   */
  async executePlan(
    planToken: string,
    manifest: Manifest<TItem>,
  ): Promise<ExecuteResult<TItem, TResult>> {
    const startedAt = Date.now();
    const consumed = this.store.consume(planToken, manifest);
    if (!consumed.ok) {
      // The core already audited the "failed" transition for this refusal.
      throw consumed.error;
    }
    const meta = consumed.meta;

    const current = await this.stateReader.readCurrent(
      manifest.items.map((item) => item.ref),
    );

    // For create operations (all items have before === null), skip the
    // STATE_CHANGED drift check: there is no prior state to compare against.
    // The beforeDigest was computed with null (item did not exist); after
    // execute the state reader returns the created item, so digests differ
    // by design — the "drift" is the intended create.
    const isPureCreate = manifest.items.every((item) => item.before === null);

    if (!isPureCreate) {
      const currentDigest = beforeDigestOf(
        manifest.items.map((item) => ({
          ref: item.ref,
          before: current[item.ref],
        })),
      );
      if (currentDigest !== meta.dataDigest) {
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
    }

    const ledger = await runLedger(manifest.items, this.executor);
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