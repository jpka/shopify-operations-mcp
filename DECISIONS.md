# DECISIONS

Each entry records a single architectural decision: the question, what the options
were, what we picked, and the reasoning a reviewer can check. Newest first.

---

## 2026-08-13 — Preview as computed diff: no transactions on Shopify (#9)

**Ticket:** #9 — two-phase manifest framework + `execute_plan`.

**Question:** sw-postgres-mcp's preview gets its exact blast radius by running the
statement for real inside `BEGIN … ROLLBACK`. Shopify has no transactions — every
Admin API call is an independent HTTP request with immediate side effects, and there
is no wrapper that can make a mutation undone. So what does "preview" mean for a
server that can't execute-then-roll-back?

**Decision:** preview is a pure read plus a computed manifest. A preview tool reads
the current state of the items it would touch (via GraphQL), computes what the
mutation would change, and produces `{ items: [{ ref, before, after }], digest }` —
**zero mutation calls**. `execute_plan` re-reads current values and compares them
against the preview's `before` digest; on any drift it refuses with `STATE_CHANGED`
(the port of sw-postgres-mcp's `ROWSET_CHANGED`). The manifest is the preview
payload the core's `PlanStore` binds a token to via `fingerprint(payload)`
(safe-write-mcp-core), so an executed plan cannot differ from what was previewed and
approved.

**Reasoning.** The property that made sw-postgres-mcp's preview a real rolled-back
execution — an *exact* affected-row count, never a planner estimate — has no
equivalent here, because there is nothing to roll back. What survives the port is
the *shape* of the guarantee: the agent sees exactly what would change before
anything changes, and the executed mutation is bound to that reviewed picture by
token fingerprint and the `STATE_CHANGED` re-read. The preview is deliberately
honest about being a projection (a set of reads) rather than pretending it executed
something — a preview failure and an execute failure are categorically different
outcomes (no side effects vs. side effects recorded in the partial-failure ledger),
and nothing about the preview API collapses them.

**Scope of the concurrency guarantee, stated honestly:** `STATE_CHANGED` is a
pre-write re-read — it catches drift that exists *before* the mutation is sent, and
it is verified against the plan's fingerprint so it cannot be bypassed by a
substituted payload. It does not close the window between the re-read and the
mutation's write; Shopify exposes a provider-level compare-and-set for some
operations (e.g. `changeFromQuantity` for inventory) but not all (plain price
updates are last-write-wins), and the build plan's tickets specify the re-read as
the concurrency check. Reaching for provider-level CAS where available is a possible
hardening, not something the decision record claims already happens.

**Alternative rejected:** "preview" as a dry-run against a sandboxed clone of the
store. There is no sandbox that matches production data, and a dry-run that didn't
run against the real items would produce a manifest the actual execute could not
honor — strictly less information than the computed-diff approach for more moving
parts.

---

## 2026-08-13 — Snapshot rollback scope: reversible ops only (#12)

**Ticket:** #12 — `rollback_plan`.

**Question:** can any executed plan be undone, the way a Postgres transaction (or a
rolled-back preview) can?

**Decision:** rollback exists **only for reversible operations**. `rollback_plan`
takes an executed plan's token and re-applies the snapshot's `before` values as
inverse mutations (restore prices/inventory; deactivate or delete a discount). It is
refused with `ROLLBACK_UNSUPPORTED` for `cancel_order` / `refund_order` plans, and
with `ROLLBACK_WINDOW_EXPIRED` once the `rollbackTtlMs` window (default 24 h) has
passed. Rollback requires no approval — restoring the prior state is the safe
direction, so there is nothing for a human gate to add.

**Reasoning.** Shopify provides no universal undo. The snapshot (per-item
`before` state stored on the plan at preview time, from the computed-diff preview
above) is only meaningful for operations whose effect is *changed values* that can
be written back — a price, an inventory level, an active discount. `cancel_order` /
`refund_order` are state transitions, not value changes: re-applying a `before`
value does not uncancel an order or unwire a payment. For those operations rollback
is not a thing that exists, so the tool refuses honestly (`ROLLBACK_UNSUPPORTED`)
rather than attempting a mutation that cannot restore the state.

`rollbackTtlMs` is the honest window on the snapshot's trustworthiness: a `before`
value is only usable as an inverse target while the world hasn't moved on. After the
TTL the inverse mutations may no longer be valid (the item changed again, the
discount was edited), so rollback is refused instead of applied against a stale
picture. The config treats the window as a positive integer with defaults, same as
every other `plans` knob (`src/config.ts`).

---

## 2026-08-13 — Always-approval for irreversible ops (#13/#14)

**Ticket:** #13 `cancel_order`, #14 `refund_order`.

**Question:** the approval mechanism is threshold-driven — `approvalRequiredAboveItems`
(default 25) gates a plan on human approval, `hardMaxItems` (default 250) refuses it
outright. `cancel_order` and `refund_order` touch one item. How does a one-item
operation that can never be undone get protected?

**Decision:** unconditional approval, via the core's `alwaysRequireApproval` flag.
The tool modules `cancel_order` / `refund_order` set `alwaysRequireApproval: true`
on their `PlanStore.create()` call — hardcoded by the tool module's own code, never
from agent-supplied arguments — so the approval threshold is never consulted for
these tools. They are always `awaiting_approval` until a human approves out-of-band
(the localhost approval server, 127.0.0.1 only). The same discipline sw-postgres-mcp
applies to DDL (`run_migration`) exists in the core as `alwaysRequireApproval`
(`PlanCreateOptions`, safe-write-mcp-core), so there is no per-tool fork of the
mechanism.

**Reasoning.** The threshold is sized for the question "how big is this blast
radius?" — meaningful for bulk value changes like prices or inventory, where a small
change is plausibly fine without a human. For an irreversible operation the size is
irrelevant: a single cancellation or refund cannot be undone, so gating on "how
many" is a category error, and making it approval-*by-accident* (e.g. an artificially
low threshold) would be exactly the config-coupled weak guarantee this project
rejects. Since these plans are also excluded from rollback (previous entry),
approval is the *only* protection, so it must be unconditional and structurally
un-bypassable: the flag lives on the `PlanStore` create options the tool module
owns, the same way `tool` does, with no agent-controlled code path that can set or
unset it. The preview still does zero writes (computed-diff), and `refund_order`
derives its preview's exact suggested amounts from `refundCalculate` — so the human
approves against a real computed picture, not a guess.

---

## 2026-08-13 — Hash-chained audit vs. Postgres grants (#6)

**Ticket:** #6 — hash-chained JSONL audit sink.

**Question:** sw-postgres-mcp makes its audit log genuinely append-only with a
Postgres `REVOKE` — the `writer` role simply lacks `UPDATE`/`DELETE`/`TRUNCATE`, and
the database enforces it structurally. A safe-write Shopify server owns no database.
How does an audit trail stay trustworthy without one?

**Decision:** a tamper-evident hash-chained JSONL file. `createJsonlAuditSink`
(`src/auditSink.ts`) implements the core's `AuditSink` contract: one JSON object per
line with `seq` (monotonic per-file, from 1), `prev_hash` (the previous row's hash;
genesis marker = 64 zero hex chars), and `hash` (sha256 over the canonical row,
which excludes the stored `hash` field itself). Every record is a single
`O_APPEND` write + `fsyncSync` (deliberate durability-over-throughput choice,
documented in the module). On open the sink verifies the existing chain and resumes
`seq`/`prev_hash` from its last line, so a chain survives restarts. `scripts/verify-audit.ts`
recomputes the chain and reports the first break with expected-vs-actual.

**Honest scoping** (the analogue of sw-postgres-mcp's #5 entry): this is
**tamper-evident, not tamper-proof**. Editing, reordering, or deleting a non-terminal
row breaks the chain at that row, and verification catches it. But suffix truncation
(deleting terminal rows) and replacing the whole file with another internally valid
chain are *not* detectable from the file alone — that requires an external,
separately-stored checkpoint anchoring the expected final hash, which this v1 does
not ship. The Postgres-grant model is structurally stronger for the same reason the
database is there at all; a server that owns no database gets the strongest
database-less analogue, with the limitation stated plainly (the README says so too)
so "tamper-evident" is never mistaken for "tamper-proof against anyone with file
write access."

**Failure semantics** follow the core's `AuditSink` contract (`record()` never
throws, returns synchronously): a short write or fsync failure transitions the sink
to a failed state that drops (with a stderr report) every later record rather than
throwing or retrying a failed `seq` (a retry could write an ambiguous duplicate).
This mirrors `PlanStore.emit`'s own guarantee — a lost audit row must never be
confused with a lifecycle that didn't happen.

**PII:** as defense-in-depth the sink strips top-level keys matching
`/customerEmail|customerName/i` from every event before hashing and serializing —
the analogue of sw-postgres-mcp's `params_redacted` (record the shape, not the
customer-identifying values; order/product IDs and amounts are recorded). Free-text
`reason`/`detail` strings cannot be safely redacted by key, so hosts must sanitize
those before calling `record()`.

---

## 2026-08-13 — GraphQL over REST (#5)

**Ticket:** #5 — GraphQL Admin client.

**Question:** Shopify exposes both a REST Admin API and a GraphQL Admin API. Which
does the server speak, and why does the choice matter for a safe-write tool?

**Decision:** GraphQL, over plain `fetch` against
`/admin/api/<version>/graphql.json`, with a pinned quarterly API version
(config `shopify.apiVersion`, default `"2026-04"`). One client module all tools and
tests go through, with cost-aware throttling driven by
`extensions.cost.throttleStatus`, jittered backoff with max retries on `THROTTLED` /
`429` / `5xx`, a cursor-pagination helper for connections, a mutation-chunking
helper with a conservative batch size, and structured errors (`SHOPIFY_THROTTLED` /
`SHOPIFY_API_ERROR` with a `hint`). Injectable `fetch` for tests.

**Reasoning.** Cost-based throttling is the decisive point: GraphQL reports each
response's actual cost in `extensions.cost.throttleStatus`, so the client can throttle
before the API's own limits, driven by the real cost of the batch a plan is about to
run — which is precisely the safety-relevant number for a preview-then-execute
pipeline (the preview computed the manifest; the execute knows the cost). One
endpoint with a typed schema also lets a preview query read exactly the fields it
needs (current price, inventory, order state) in a single round trip, keeping the
computed-diff preview cheap; and GraphQL returns exactly the requested fields, so a
read tool is naturally scoped to what it asked for.

**Note on the read-safety story:** sw-postgres-mcp guarantees read-only by a Postgres
role grant — a read tool *cannot* mutate even if its code is buggy. Here there is no
second enforcement point: GraphQL never mutates unless a mutation operation is sent,
so read tools stay read-only by construction of what they send, and that is the
deliberate, documented boundary for this server (the token itself — `SHOPIFY_ADMIN_TOKEN`,
env-only, never in the config file — is the single credential for everything).

---

## 2026-08-13 — Partial-failure ledger (#9)

**Ticket:** #9 — executor contract.

**Question:** a plan executes a batch of mutations (e.g. update prices across 100
products). sw-postgres-mcp runs one SQL statement that succeeds or fails atomically
inside a transaction. Shopify mutations are per-item HTTP calls with no transaction
to make the batch atomic — what happens when item 37 of 100 fails?

**Decision:** the executor keeps a **per-item success/failure ledger**. Each item's
mutation is attempted independently; successes and failures are recorded
item-by-item, and a partial failure is reported, never hidden and never retried
blindly. The ledger is part of the executed plan's audit trail, and a rolled-back
plan audits the same ledger shape.

**Reasoning.** With no transaction, "did the plan work?" has no single yes/no answer
— the honest answer is a ledger. Hiding a partial failure (returning success because
99/100 worked) is the exact failure mode a safe-write tool exists to prevent: the
agent would believe the whole plan happened when some of it didn't. Recording
per-item outcomes (a) lets a human and the audit trail see precisely what happened,
(b) gives `rollback_plan` the inverse-mutation target list — re-apply `before`
values only where a mutation actually succeeded, never where it didn't, and (c) keeps
the computed-diff preview's promise honest: the manifest said what *would* change,
the ledger says what *did*. The `STATE_CHANGED` re-read bounds the executor too — an
item whose current value drifted from the preview is refused rather than
overwritten, so a partial failure never includes a stale-overwrite of data the
preview didn't see.

**Retry semantics, stated precisely:** the GraphQL client's backoff policy applies
only where the outcome is known — the request was refused before application
(`THROTTLED`, `429`, a `5xx` that never reached the mutation). An *ambiguous* outcome
(a dropped connection mid-mutation, where the server may or may not have applied it)
is never blindly retried — a retry could apply the mutation twice — and is recorded
on the ledger without claiming success, the same as any other failure.