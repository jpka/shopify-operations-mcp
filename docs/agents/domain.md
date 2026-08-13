# Domain docs

How an agent should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`DECISIONS.md`** at the repo root — the decision record (newest first). Read the entries that touch the area you're about to work in. Every architectural decision this repo makes lands here, in the same style sw-postgres-mcp uses.
- **`AGENTS.md`** at the repo root — working conventions and pointers into `docs/agents/`.
- **The source** — this repo is small enough that the code is the ground truth:
  - `src/config.ts` — the config shape and every default/invariant (`plans.*`, `approvalServer.*`, `protectedTags`, `callerId`, env overrides).
  - `src/auditSink.ts` — the hash-chained JSONL audit sink (chain format, PII redaction, failure semantics).
  - `src/index.ts` — server entry (stub today; the MCP server lands in later tickets).
  - `node_modules/safe-write-mcp-core/dist/*.d.ts` — the core contract the server builds on: `PlanStore`, the approval server, `PlanError` codes, `fingerprint`, `AuditSink`/`AuditStatus`.

If a file is missing or a ticket is unimplemented, **proceed silently** — don't flag the absence or suggest creating artifacts. The build map (issue #1, labelled `wayfinder:map`) is the source of truth for what is planned but not yet built.

## File structure

Single-context repo:

```
/
├── AGENTS.md
├── DECISIONS.md
├── config.example.json
├── src/                ← implementation (config, audit sink, MCP server later)
├── tests/              ← vitest unit tests
├── scripts/            ← CLI helpers (e.g. scripts/verify-audit.ts)
└── docs/
    └── agents/         ← agent conventions (this directory)
```

## Use the code's vocabulary

When your output names a domain concept (an issue title, a test name, a DECISIONS entry), use the term as the code defines it. Don't drift to synonyms the codebase avoids. Key terms:

- **plan** — a previewed operation's record in `PlanStore`, bound to a **plan token**; single-use, expiring (`planTtlMs`), fingerprint-bound, optionally gated on approval.
- **preview** — host-side pure reads that compute a **manifest** (`{ items: [{ ref, before, after }], digest }`) with **zero mutation calls**; there are no transactions on Shopify.
- **execute_plan** — consumes the plan token, re-reads current values, refuses on drift (`STATE_CHANGED`), then runs the executor.
- **fingerprint** — sha256 over the canonical payload; the token is bound to it (`consume()` refuses any mismatch).
- **approval** — out-of-band human sign-off via the localhost approval server (127.0.0.1 only); never an agent-reachable MCP tool. Threshold-driven (`approvalRequiredAboveItems`, `hardMaxItems`) except for **irreversible** ops, which force `alwaysRequireApproval`.
- **reversible / irreversible** — reversible ops (prices, inventory, discounts) support **rollback**; irreversible ops (`cancel_order`, `refund_order`) never do (`ROLLBACK_UNSUPPORTED`) and are always approval-gated.
- **rollback** — re-applies snapshot `before` values as inverse mutations within `rollbackTtlMs` (`ROLLBACK_WINDOW_EXPIRED` after); no approval required.
- **partial-failure ledger** — per-item success/failure outcomes recorded on every batch execute/rollback; partial failure is reported, never hidden.
- **protectedTags** — tags plans may never modify (default `["do-not-touch"]`).
- **audit** — the hash-chained JSONL trail (`seq` / `prev_hash` / `hash`; tamper-evident, not tamper-proof). Core `AuditStatus` values: `previewed`, `awaiting_approval`, `approved`, `executed`, `rejected`, `refused`, `failed`, `rolled_back`. Core `PlanError` codes: `UNKNOWN_TOKEN`, `PLAN_EXPIRED`, `PLAN_USED`, `PLAN_MISMATCH`, `AWAITING_APPROVAL`, `PLAN_REJECTED`.
- **PII contract** — customer emails and names must never appear in the audit trail; record order/product IDs and amounts instead.

## Flag DECISIONS conflicts

If your output contradicts an existing DECISIONS entry, surface it explicitly rather than silently overriding:

> _Contradicts DECISIONS (preview as computed diff) — but worth reopening because…_
