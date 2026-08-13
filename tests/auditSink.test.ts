import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "safe-write-mcp-core";
import {
  GENESIS_PREV_HASH,
  createJsonlAuditSink,
  hashRow,
  redactEvent,
  verifyAuditChain,
} from "../src/auditSink.ts";

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    ts: 1_700_000_000_000,
    tool: "update_prices",
    reason: null,
    planToken: null,
    status: "previewed",
    previewCount: 3,
    callerId: "user-1",
    durationMs: 12,
    ...overrides,
  };
}

function readLines(dir: string): Array<Record<string, unknown>> {
  const files = fs.readdirSync(dir);
  const file = files.find((f) => f.endsWith(".jsonl"));
  expect(file).toBeDefined();
  return fs
    .readFileSync(path.join(dir, file!), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("JsonlAuditSink", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-sink-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends one line per record with correct seq and prev_hash chaining", () => {
    const sink = createJsonlAuditSink(path.join(dir, "audit.jsonl"));
    sink.record(makeEvent({ tool: "a" }));
    sink.record(makeEvent({ tool: "b", status: "executed" }));
    sink.record(makeEvent({ tool: "c", reason: "approved by op" }));
    sink.close();

    const rows = readLines(dir);
    expect(rows).toHaveLength(3);
    rows.forEach((row, i) => expect(row.seq).toBe(i + 1));
    expect(rows[0]!.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);

    const intact = verifyAuditChain(path.join(dir, "audit.jsonl"));
    expect(intact.ok).toBe(true);
    expect(intact.entries).toBe(3);
    expect(intact.lastHash).toBe(rows[2]!.hash);
  });

  it("hashes the canonical row, and the hash changes when a field changes", () => {
    const event = makeEvent({ reason: "price floor breached" });
    const hashA = hashRow(1, GENESIS_PREV_HASH, event);
    const changed = { ...event, reason: "price floor cleared" };
    expect(hashRow(1, GENESIS_PREV_HASH, changed)).not.toBe(hashA);

    const sink = createJsonlAuditSink(path.join(dir, "audit.jsonl"));
    sink.record(event);
    sink.close();

    const row = readLines(dir)[0]!;
    const storedHash = row.hash;
    expect(storedHash).toBe(hashA);
    expect(hashRow(row.seq as number, row.prev_hash as string, event)).toBe(storedHash);
    expect(
      hashRow(row.seq as number, row.prev_hash as string, { ...event, tool: "other_tool" }),
    ).not.toBe(storedHash);

    const expectedHash = createHash("sha256")
      .update(
        JSON.stringify({
          seq: 1,
          prev_hash: GENESIS_PREV_HASH,
          ts: event.ts,
          tool: event.tool,
          reason: event.reason,
          planToken: event.planToken,
          status: event.status,
          previewCount: event.previewCount,
          callerId: event.callerId,
          durationMs: event.durationMs,
        }),
      )
      .digest("hex");
    expect(storedHash).toBe(expectedHash);
  });

  it("redactEvent strips PII keys and does not mutate the input", () => {
    const event = {
      ...makeEvent(),
      customerEmail: "alice@example.com",
      customerName: "Alice Example",
      note: "keep me",
    };
    const redacted = redactEvent(event);

    expect("customerEmail" in redacted).toBe(false);
    expect("customerName" in redacted).toBe(false);
    expect(redacted.note).toBe("keep me");
    expect(redacted.ts).toBe(event.ts);
    expect(redacted.tool).toBe(event.tool);

    expect("customerEmail" in event).toBe(true);
    expect("customerName" in event).toBe(true);

    const mixedCase = redactEvent({ ...event, CustomerEMAIL: "x@y.z", customername: "Bob" });
    expect("CustomerEMAIL" in mixedCase).toBe(false);
    expect("customername" in mixedCase).toBe(false);
  });

  it("strips top-level PII keys from stored rows at the persistence boundary", () => {
    const file = path.join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(file);
    sink.record({
      ...makeEvent(),
      customerEmail: "alice@example.com",
      customerName: "Alice Example",
    } as AuditEvent);
    sink.close();

    const rows = readLines(dir);
    expect(rows).toHaveLength(1);
    expect("customerEmail" in rows[0]!).toBe(false);
    expect("customerName" in rows[0]!).toBe(false);
    expect(verifyAuditChain(file).ok).toBe(true);
  });

  it("fsyncs by default and skips fsync when {fsync:false}", () => {
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");

    const file = path.join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(file);
    sink.record(makeEvent({ tool: "durable" }));
    expect(fsyncSpy).toHaveBeenCalledTimes(1);

    const noSyncSink = createJsonlAuditSink(path.join(dir, "no-sync.jsonl"), { fsync: false });
    noSyncSink.record(makeEvent({ tool: "fast" }));
    expect(fsyncSpy).toHaveBeenCalledTimes(1);

    sink.close();
    noSyncSink.close();
    vi.restoreAllMocks();
  });

  it("fails the sink closed when fsync fails and rejects later records", () => {
    const file = path.join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(file);
    sink.record(makeEvent({ tool: "ok" }));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fsyncSpy = vi
      .spyOn(fs, "fsyncSync")
      .mockImplementation(() => {
        throw new Error("io failure");
      });

    expect(() => sink.record(makeEvent({ tool: "boom" }))).not.toThrow();
    expect(stderrSpy).toHaveBeenCalled();
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "failed to record seq 2",
    );

    fsyncSpy.mockRestore();
    const stderrBefore = stderrSpy.mock.calls.length;
    sink.record(makeEvent({ tool: "after-failure" }));
    expect(stderrSpy.mock.calls.length).toBeGreaterThan(stderrBefore);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("sink is failed");

    const result = verifyAuditChain(file);
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(2);
    expect(fs.readFileSync(file, "utf8")).not.toContain("after-failure");
    sink.close();
    vi.restoreAllMocks();
  });

  it("resumes seq and prev_hash from the last line of an existing file", () => {
    const file = path.join(dir, "audit.jsonl");
    const first = createJsonlAuditSink(file);
    first.record(makeEvent({ tool: "a" }));
    first.record(makeEvent({ tool: "b" }));
    first.close();

    const second = createJsonlAuditSink(file);
    second.record(makeEvent({ tool: "c" }));
    second.close();

    const rows = readLines(dir);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);
    expect(verifyAuditChain(file).ok).toBe(true);
  });

  it("refuses to resume from a chain that does not verify", () => {
    const file = path.join(dir, "audit.jsonl");
    const first = createJsonlAuditSink(file);
    first.record(makeEvent({ tool: "a" }));
    first.record(makeEvent({ tool: "b" }));
    first.close();

    const content = fs.readFileSync(file, "utf8");
    const rows = content.trim().split("\n");
    rows[1] = rows[1]!.replace('"tool":"b"', '"tool":"FORGED"');
    fs.writeFileSync(file, rows.join("\n") + "\n");

    expect(() => createJsonlAuditSink(file)).toThrow(/does not verify/);
  });

  it("verifyAuditChain fails on a mutated middle row", () => {
    const file = path.join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(file);
    sink.record(makeEvent({ tool: "a" }));
    sink.record(makeEvent({ tool: "b", reason: "original" }));
    sink.record(makeEvent({ tool: "c" }));
    sink.close();

    const content = fs.readFileSync(file, "utf8");
    const tampered = content.replace('"original"', '"FORGED"');
    expect(tampered).not.toBe(content);
    fs.writeFileSync(file, tampered);

    const result = verifyAuditChain(file);
    expect(result.ok).toBe(false);
    expect(result.firstBreak?.seq).toBe(2);
    expect(result.firstBreak?.expected).toBeTypeOf("string");
    expect(result.firstBreak?.actual).toBeTypeOf("string");
    expect(result.entries).toBe(1);
    expect(result.lastHash).toBeTypeOf("string");
  });

  it("writes to stderr and does not throw when a record hits a write error", () => {
    const file = path.join(dir, "audit.jsonl");
    const sink = createJsonlAuditSink(file);
    sink.record(makeEvent({ tool: "ok" }));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const writeSpy = vi
      .spyOn(fs, "writeSync")
      .mockImplementation(() => {
        throw new Error("disk full");
      });

    let returned = "unset";
    expect(() => {
      returned = sink.record(makeEvent({ tool: "boom" }));
    }).not.toThrow();
    expect(returned).toBeUndefined();

    expect(writeSpy).toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("failed to record seq 2");
    expect(stderrText).toContain(file);

    vi.restoreAllMocks();
    const result = verifyAuditChain(file);
    expect(result.ok).toBe(true);
    expect(result.entries).toBe(1);
    sink.close();
  });
});