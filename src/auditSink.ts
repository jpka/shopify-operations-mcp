/**
 * Tamper-evident JSONL audit sink for safe-write-mcp-core.
 *
 * One JSON object per line:
 *
 *   {"seq":1,"prev_hash":"0000...","hash":"ab12...","ts":...,"tool":...,...}
 *
 * - `seq` is a monotonically increasing per-file sequence, starting at 1.
 * - `hash` is sha256 over the canonical row, which is the JSON of
 *   `{seq, prev_hash, ...event fields}` in the fixed key order below
 *   (the stored `hash` field itself is excluded from the hashed input).
 * - The first row's `prev_hash` is the genesis marker: 64 zero hex chars.
 *   Every later row's `prev_hash` equals the previous row's `hash`, so any
 *   edit, deletion, or reordering of a row breaks the chain at that row.
 *
 * Durability: every `record()` opens no window — the file is opened once in
 * append mode (`O_APPEND`) and each record is written with a single
 * synchronous `writeSync` followed by `fsyncSync`. fsync-per-record was
 * chosen (the ticket's "append + fsync" reading) over batched fsync because
 * an MCP server's event rate is low and correctness beats throughput here;
 * the per-record fsync is the documented, deliberate tradeoff.
 *
 * Concurrency: single-writer only. `seq` and `prev_hash` are tracked
 * in-process, so a second process appending to the same file is out of
 * scope (it would silently duplicate seq numbers — verification would then
 * flag the duplicate, but the file would still be ambiguous). Two sinks in
 * the same process must never share a file.
 *
 * Restart safety: on open, the sink reads the last valid line of an existing
 * file and resumes `seq` and `prev_hash` from it, so a chain survives server
 * restarts. If the last line exists but is malformed, the factory throws —
 * an admin must inspect the audit file before the server starts.
 *
 * PII contract: the sink records exactly the event it is given — it does not
 * redact. Customer emails and names must NEVER appear in the audit trail.
 * Hosts that build events from customer data must call `redactEvent()` (and
 * sanitize free-text `reason`/`detail` strings) before calling `record()`.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { AuditEvent, AuditSink } from "safe-write-mcp-core";

/** Genesis marker for the first row: 64 zero hex chars. */
export const GENESIS_PREV_HASH = "0".repeat(64);

/** Top-level event keys that are PII and must never be recorded. */
const PII_KEY_PATTERN = /customerEmail|customerName/i;

export interface JsonlAuditSink extends AuditSink {
  /** Flushes and closes the underlying file descriptor. Idempotent. */
  close(): void;
}

/**
 * Returns a shallow copy of `event` with any top-level keys matching
 * /customerEmail|customerName/i removed. Never mutates the input. Hosts that
 * attach customer data to events must pass the event through this before
 * `record()`. Free-text `reason`/`detail` fields are NOT scanned — hosts
 * must sanitize those strings themselves.
 */
export function redactEvent<T extends object>(event: T): T {
  const out: Record<string, unknown> = { ...(event as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (PII_KEY_PATTERN.test(key)) delete out[key];
  }
  return out as T;
}

/**
 * The canonical row for hashing: `{seq, prev_hash, ...event fields}` in a
 * fixed key order. Both the sink and the verifier must produce byte-identical
 * output for the same logical row, or verification would break honest chains.
 */
function canonicalRow(seq: number, prevHash: string, event: AuditEvent): string {
  const row: Record<string, unknown> = {
    seq,
    prev_hash: prevHash,
    ts: event.ts,
    tool: event.tool,
    reason: event.reason,
    planToken: event.planToken,
    status: event.status,
    previewCount: event.previewCount,
    callerId: event.callerId,
    durationMs: event.durationMs,
  };
  if (event.detail !== undefined) row.detail = event.detail;
  return JSON.stringify(row);
}

/** sha256 hex of the canonical row for `seq`/`prevHash`/`event`. */
export function hashRow(seq: number, prevHash: string, event: AuditEvent): string {
  return createHash("sha256").update(canonicalRow(seq, prevHash, event)).digest("hex");
}

interface JsonlAuditSinkOptions {
  /**
   * fsync after every record (default true). Set false to trade durability
   * for throughput — verification still works, but a crash can lose the
   * most recent records.
   */
  fsync?: boolean;
}

/**
 * Opens `path` in append mode and returns a synchronous, never-throwing
 * audit sink. Throws at construction if the file cannot be opened or an
 * existing last line is malformed (fail fast at startup, not at record time).
 */
export function createJsonlAuditSink(
  path: string,
  options: JsonlAuditSinkOptions = {},
): JsonlAuditSink {
  const { fsync = true } = options;
  const fd = fs.openSync(path, "a");

  let nextSeq = 1;
  let prevHash = GENESIS_PREV_HASH;
  const resumeFrom = lastLineOf(path);
  if (resumeFrom !== null) {
    const last = JSON.parse(resumeFrom) as { seq?: unknown; hash?: unknown };
    if (typeof last.seq !== "number" || typeof last.hash !== "string") {
      fs.closeSync(fd);
      throw new Error(`audit sink: last line of ${path} is not a valid chain row`);
    }
    nextSeq = last.seq + 1;
    prevHash = last.hash;
  }

  let closed = false;
  return {
    record(event: AuditEvent): undefined {
      if (closed) {
        process.stderr.write(`audit sink: record() after close ignored for ${path}\n`);
        return undefined;
      }
      const seq = nextSeq;
      const hash = hashRow(seq, prevHash, event);
      const line = JSON.stringify({ seq, prev_hash: prevHash, hash, ...event });
      try {
        fs.writeSync(fd, line + "\n");
        if (fsync) fs.fsyncSync(fd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`audit sink: failed to record seq ${seq} to ${path}: ${msg}\n`);
        return undefined;
      }
      nextSeq = seq + 1;
      prevHash = hash;
      return undefined;
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        fs.closeSync(fd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`audit sink: close of ${path} failed: ${msg}\n`);
      }
    },
  };
}

function lastLineOf(path: string): string | null {
  let data: Buffer;
  try {
    data = fs.readFileSync(path);
  } catch {
    return null;
  }
  const lines = data.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length > 0) return line;
  }
  return null;
}

export interface VerifyResult {
  /** True when every row hashes correctly and the chain links end to end. */
  ok: boolean;
  /** Number of rows read (may exceed the break point when ok is false). */
  entries: number;
  /** Hash of the final row, or null when there are no rows. */
  lastHash: string | null;
  /**
   * The first row that failed verification, or null when ok is true.
   * For non-hash failures (unparseable line, wrong seq), `expected`/`actual`
   * carry a short description instead of hashes.
   */
  firstBreak: { seq: number; expected: string; actual: string } | null;
}

/**
 * Walks the JSONL file and recomputes the chain from genesis. Shared by
 * scripts/verify-audit.ts and the tests.
 */
export function verifyAuditChain(path: string): VerifyResult {
  let data: Buffer;
  try {
    data = fs.readFileSync(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      entries: 0,
      lastHash: null,
      firstBreak: { seq: 1, expected: GENESIS_PREV_HASH, actual: `cannot read ${path}: ${msg}` },
    };
  }

  const lines = data
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < lines.length; i++) {
    const seq = i + 1;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        entries: i,
        lastHash: i === 0 ? null : prevHash,
        firstBreak: { seq, expected: "parseable JSON line", actual: "unparseable line" },
      };
    }

    if (row.seq !== seq) {
      return {
        ok: false,
        entries: i,
        lastHash: i === 0 ? null : prevHash,
        firstBreak: { seq, expected: String(seq), actual: String(row.seq) },
      };
    }
    if (row.prev_hash !== prevHash) {
      return {
        ok: false,
        entries: i,
        lastHash: i === 0 ? null : prevHash,
        firstBreak: { seq, expected: prevHash, actual: String(row.prev_hash) },
      };
    }

    const hash = hashRow(seq, prevHash, eventFromRow(row));
    if (row.hash !== hash) {
      return {
        ok: false,
        entries: i,
        lastHash: i === 0 ? null : prevHash,
        firstBreak: { seq, expected: hash, actual: String(row.hash) },
      };
    }
    prevHash = hash;
  }

  return { ok: true, entries: lines.length, lastHash: prevHash, firstBreak: null };
}

function eventFromRow(row: Record<string, unknown>): AuditEvent {
  return {
    ts: row.ts as number,
    tool: row.tool as string,
    reason: (row.reason as string | null) ?? null,
    planToken: (row.planToken as string | null) ?? null,
    status: row.status as AuditEvent["status"],
    previewCount: (row.previewCount as number | null) ?? null,
    callerId: row.callerId as string,
    durationMs: row.durationMs as number,
    detail: row.detail === undefined ? undefined : (row.detail as string | null),
  };
}