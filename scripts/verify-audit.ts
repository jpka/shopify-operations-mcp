#!/usr/bin/env node
/**
 * Verifies a hash-chained JSONL audit file produced by createJsonlAuditSink.
 *
 *   npm run verify-audit -- <path>
 *
 * Recomputes every row hash from genesis, checks the prev_hash links and the
 * seq sequence, prints a chain summary when intact, and exits 0. On the
 * first broken row it reports seq and expected-vs-actual and exits 1.
 */
import { verifyAuditChain } from "../src/auditSink.ts";

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write("usage: npm run verify-audit -- <audit.jsonl>\n");
  process.exit(1);
}

const result = verifyAuditChain(path);

if (!result.ok && result.firstBreak) {
  const { seq, expected, actual } = result.firstBreak;
  process.stderr.write(`audit chain BROKEN at seq ${seq}\n`);
  process.stderr.write(`  expected: ${expected}\n`);
  process.stderr.write(`  actual:   ${actual}\n`);
  process.exit(1);
}

if (result.entries === 0) {
  process.stdout.write(`audit chain OK: empty file (${path})\n`);
} else {
  process.stdout.write(
    `audit chain OK: ${result.entries} entries, last hash ${result.lastHash} (${path})\n`,
  );
}
process.exit(0);
