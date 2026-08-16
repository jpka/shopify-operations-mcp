# Demo runbook — safe-write Shopify MCP (issue #24)

The 3–5 minute walkthrough to record on Loom. A human or a computer-use agent can follow these steps verbatim: every tool call, expected response, browser action, and verification is spelled out below. The runbook is designed to be the demo's on-camera script as much as its checklist.

## What the demo proves

1. A **store-wide 90%-off reprice is refused before anything changes** (`HARD_MAX_ITEMS_EXCEEDED`) — no token, no approval path, zero writes.
2. A **scoped reprice requires a human to approve out-of-band** (`awaiting_approval`) — the agent previews the exact before/after manifest, the human approves in a localhost-only browser page, then the plan executes.
3. **`rollback_plan` restores every value in one call** — no approval needed because restoring the prior state is the safe direction.
4. The **hash-chained audit log** records every transition (refused → awaiting_approval → approved → executed → rolled_back) and `scripts/verify-audit.ts` proves the chain is intact.
5. One **quantified metric** is captured from the audit rows (preview latency at N variants with zero write calls; rollback duration) and pasted into the README.

---

## Before you start (one-time setup)

### 0.1 Prerequisites

- Node.js 18+ (CI runs on 24) and `npm`.
- A Shopify **dev store** with an Admin API token. Only the `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_ADMIN_TOKEN` environment variables are read for credentials — `SHOPIFY_ADMIN_TOKEN` is required and never read from a config file.
- This repo checked out. From the repo root:

```bash
npm install
npm run build
```

### 0.2 Seed the dev store

The seeder generates a deterministic store: 300 products, 768 variants, 20 customers, 120 orders, all tagged `seeded-store`. It is idempotent — a re-run wipes and regenerates the seeded resources, so you can reset between takes.

First verify the plan without any API calls or credentials (it also asserts the two sizing invariants the demo depends on):

```bash
npm run seed -- --seed 42 --dry-run
```

Then seed for real. Dev stores cap `orderCreate` at 5 per minute, so the 120 orders take ~24 minutes with `--order-delay-ms 1200`. The demo only touches prices, but the seeder always creates the full store — budget the wait, or seed once and keep the store parked:

```bash
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com \
SHOPIFY_ADMIN_TOKEN=shpat_... \
npm run seed -- --seed 42 --order-delay-ms 1200
```

When it finishes, note the printed counts. With seed 42 the two numbers the demo depends on are:

| Metric | Seed-42 value |
|---|---|
| Full variant set (store-wide reprice) | **768** — exceeds `hardMaxItems` (250) → refused |
| Variants tagged `sale` | **156** — inside `[approvalRequiredAboveItems (25), hardMaxItems (250)]` → requests approval, not refused |

### 0.3 Environment and config

Defaults are fine for the demo; use these env overrides to make recording reliable and the audit attributable. `planTtlMs` defaults to 60 000 ms — too short to approve calmly on camera, so raise it. Use a **fresh audit file** for each take.

```bash
export SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
export SHOPIFY_ADMIN_TOKEN=shpat_...
export SHOPIFY_PLAN_TTL_MS=600000        # 10 min — don't race the 60 s default while recording
export SHOPIFY_CALLER_ID=loom-demo       # every audit row carries this caller
export SHOPIFY_AUDIT_PATH=/tmp/shopify-demo-audit.jsonl

rm -f "$SHOPIFY_AUDIT_PATH"              # start a clean chain each take
```

If you prefer a `config.json`, copy `config.example.json`; the env vars above override it anyway.

### 0.4 Start the server

```bash
node dist/index.js
```

You should see (among the startup logs):

```
[shopify-operations-mcp] localhost approval UI listening on http://127.0.0.1:4319
```

Leave the process running. The MCP stdio transport and the approval HTTP server (bound to `127.0.0.1` only) share one process.

### 0.5 Connect an MCP client

Register the server in **Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "shopify-ops": {
      "command": "node",
      "args": ["/absolute/path/to/shopify-operations-mcp/dist/index.js"],
      "env": {
        "SHOPIFY_STORE_DOMAIN": "your-store.myshopify.com",
        "SHOPIFY_ADMIN_TOKEN": "shpat_...",
        "SHOPIFY_PLAN_TTL_MS": "600000",
        "SHOPIFY_CALLER_ID": "loom-demo",
        "SHOPIFY_AUDIT_PATH": "/tmp/shopify-demo-audit.jsonl"
      }
    }
  }
}
```

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Restart Claude Desktop, then confirm the `shopify-ops` server connected. Any MCP client works; if you'd rather drive the tools from a browser instead of an agent, `npx @modelcontextprotocol/inspector node dist/index.js` is a fine stand-in — the tool calls below are identical.

### 0.6 Baseline

Ask the agent to "list the entire catalog". The agent calls:

```
search_products()
```

Expected: `{ products: [...], count: 300, first: 50 }` — 300 products, 768 variants total, every product's `flags.protected` is `false` (nothing carries `do-not-touch`). Note the variant `id` fields; the agent uses them in Beat 1.

---

## The demo script

### Beat 1 — store-wide 90%-off refused: `HARD_MAX_ITEMS_EXCEEDED`

This is the killer scenario: a syntactically perfect bulk reprice whose *scope* is the problem.

**Prompt to the agent:** "Reprice the entire store to 90% off for a clearance."

The agent gathers every variant it just read and calls `update_prices` with all of them:

```
update_prices({
  variantIds: [ <all 768 variant ids from search_products> ],
  transform: { type: "adjust-percentage", percentage: -90 },
  reason: "store-wide 90% clearance"
})
```

**Expected — a structured error, not a queued plan:**

```json
{
  "code": "HARD_MAX_ITEMS_EXCEEDED",
  "message": "This plan touches 768 items, above the hard cap of 250. No plan token was issued and there is no approval path for this.",
  "hint": "Narrow the operation to affect fewer items, then re-preview."
}
```

**Narrate on camera:** the server previewed 768 variants (pure reads, **zero mutation calls**), recognized the blast radius exceeds `hardMaxItems`, and refused with no token and no approval path. The store is untouched. Show that a `sale`-scoped plan stays within limits.

---

### Beat 2 — scoped reprice → `awaiting_approval` → approve in the UI → executes

**Prompt to the agent:** "Narrow it: repric just the `sale`-tagged items 90% off."

```
update_prices({
  tag: "sale",
  transform: { type: "adjust-percentage", percentage: -90 },
  reason: "clearance: 90% off sale-tagged items"
})
```

**Expected — `awaiting_approval`, no writes yet:**

```json
{
  "status": "awaiting_approval",
  "plan_token": "<plan_token>",
  "item_count": 156,
  "expires_at": 1755280000000,
  "manifest": {
    "items": [
      { "ref": "gid://shopify/ProductVariant/...", "before": { "price": "29.99", "...": "..." }, "after": { "price": "3.00", "...": "..." }, "payload": { "variantId": "...", "price": "3.00" } },
      "..."
    ],
    "digest": "...",
    "beforeDigest": "..."
  },
  "message": "This plan requires human approval through the localhost approval UI before it will execute. ..."
}
```

156 ≥ the 25-item approval threshold, and −90% is far past the 30% `maxPriceChangePct` guard — either gate alone would require a human. The response is the exact before/after manifest the token is bound to; **nothing has changed in the store.**

**Approve in the browser.** Open `http://127.0.0.1:4319/`. You'll see one pending card — `update_prices: 156 items` — with a monospace table of `Item | Before | After | Reason | Flags` (the Flags column shows `price -90.0%` per row) and the manifest digest. Scroll a few rows, then click **Approve** (optionally typing an approver name). The page confirms *Approved*.

> Headless alternative (computer-use agent): the same action over the JSON API —
> `curl -X POST http://127.0.0.1:4319/api/plans/<plan_token>/approve -H 'Content-Type: application/json' -d '{"approvedBy":"demo-operator"}'`

**Execute.** Back in the client, the agent passes the token back with the **exact manifest from the preview response**:

```
execute_plan({
  plan_token: "<plan_token>",
  manifest: <the exact manifest returned by the preview>
})
```

**Expected:**

```json
{
  "status": "executed",
  "item_count": 156,
  "succeeded_count": 156,
  "failed_count": 0,
  "refs": [ "gid://shopify/ProductVariant/...", "..." ]
}
```

**Verify** the write landed: `search_products({ tag: "sale" })` now shows each price at 10% of its original value (e.g. `29.99` → `3.00`).

> Want exactly 50 variants instead of the tag? Pass the first 50 variant ids from `search_products` via `variantIds` — 50 is still ≥ 25 (approval required) and under 250 (not refused). The rest of the beat is identical.

---

### Beat 3 — `rollback_plan` restores every value in one call

**Prompt to the agent:** "That was a mistake — undo it."

```
rollback_plan({
  planToken: "<plan_token>"
})
```

Note the argument name is `planToken` (camelCase) here, unlike `execute_plan`'s `plan_token`.

**Expected — one call, everything restored:**

```json
{
  "status": "rolled_back",
  "item_count": 156,
  "succeeded_count": 156,
  "failed_count": 0,
  "refs": [ "gid://shopify/ProductVariant/...", "..." ]
}
```

**Verify:** `search_products({ tag: "sale" })` shows the original prices again. Rollback needed no approval — it re-applied the previewed `before` values as inverse mutations, which is the safe direction.

---

### Beat 4 — the hash-chained audit log

Open `/tmp/shopify-demo-audit.jsonl` (the `SHOPIFY_AUDIT_PATH` you set) in an editor or `less` and scroll it. Each lifecycle transition is one JSON object per line with `seq`, `prev_hash` (previous row's hash), `hash`, `ts`, `tool`, `reason`, `planToken`, `status`, `previewCount`, `callerId` (`loom-demo`), and `durationMs`. In order you'll see:

| `seq` | `status` | What it records |
|---|---|---|
| 1 | `refused` | the 768-variant store-wide attempt → `HARD_MAX_ITEMS_EXCEEDED` |
| 2 | `awaiting_approval` | the 156-variant preview |
| 3 | `approved` | your browser click |
| 4 | `executed` | the core's token consumption |
| 5 | `executed` | the host's per-item ledger (`all 156 item(s) executed`) |
| 6 | `rolled_back` | the one-call rollback |

Verify the chain recomputes from genesis and holds:

```bash
npm run verify-audit -- /tmp/shopify-demo-audit.jsonl
```

**Expected:**

```
audit chain OK: 6 entries, last hash <hash> (/tmp/shopify-demo-audit.jsonl)
```

---

### Beat 5 — capture the quantified metric into the README

Every audit row carries `durationMs` — the round-trip time for that transition. Read three numbers off the file:

1. **Preview latency at 156 variants, zero write calls** = `durationMs` on the `awaiting_approval` row (manifest build + token creation; the executor is never invoked).
2. **Preview latency at 768 variants, zero write calls** = `durationMs` on the `refused` row (the refusal still built the full manifest first).
3. **Rollback duration at 156 variants** = `durationMs` on the `rolled_back` row.

Paste the table into the README (e.g. a `## Demo metrics` section near the top), filling in the measured values:

```markdown
## Demo metrics

Captured <date> against a seeded dev store (seed 42, 768 variants), from the
hash-chained audit log's `durationMs`:

| Operation | N | Preview latency (zero write calls) | Rollback duration |
|---|---|---|---|
| Store-wide reprice (refused) | 768 | <ms> | — |
| sale-tag reprice → approve → execute | 156 | <ms> | <ms> |
```

Each number is the server's own measured round-trip on a real store — that is the quantified proof-of-work for issue #24.

---

## Optional beats

### Optional A — a rejection, not just an approval

A fresh `update_prices` preview (e.g. `tag: "sale"` again), then click **Reject** in the UI instead of Approve. `execute_plan` with that token returns a structured `PLAN_REJECTED` error. A rejected token is dead — re-preview for a fresh one. This beat shows the agent cannot approve its own plans: the human is the only gate.

### Optional B — tamper-evidence on camera

Edit a row in `/tmp/shopify-demo-audit.jsonl` (change one price value in a `before` snapshot), then re-run:

```bash
npm run verify-audit -- /tmp/shopify-demo-audit.jsonl
```

**Expected:**

```
audit chain BROKEN at seq <n>
  expected: <hash>
  actual:   <hash>
```

Restore the file afterward. This makes the "tamper-evident" claim concrete on camera.

---

## Recording tips (Loom, 3–5 min)

1. **Setup beat in advance.** Seed the store and leave the server + audit file staged so the take starts at Beat 1. Do the ~24-minute order seed before recording, not during.
2. **Widescreen, readable text.** Keep the approval page and the audit file large on screen; the manifest table and JSON are the visual proof.
3. **Suggested pacing:**
   - 0:00–0:45 — one-line pitch + the two-phase pattern (preview → token → approve → execute).
   - 0:45–1:30 — Beat 1 refusal.
   - 1:30–2:45 — Beat 2: preview → browser approval → execute → verify.
   - 2:45–3:30 — Beat 3 rollback + verify.
   - 3:30–4:15 — Beat 4 audit log + chain verification.
   - 4:15–5:00 — Beat 5: the metric, and where it lives in the README.
4. **Name the killer scenario once:** "a perfect-looking bulk reprice whose scope is the problem" — it ties Beats 1 and 2 together.
5. **Reject beat optional** if you're tight on time; the approve beat is the required path.

## Checklist

- [ ] Store seeded with `--seed 42` (768 variants; `sale` tag = 156).
- [ ] Fresh audit file; server running; approval UI up at `http://127.0.0.1:4319`.
- [ ] Beat 1: `HARD_MAX_ITEMS_EXCEEDED` on the 768-variant reprice.
- [ ] Beat 2: `awaiting_approval` → approved in UI → `executed` 156/156 → verified.
- [ ] Beat 3: `rolled_back` 156/156 → verified.
- [ ] Beat 4: audit rows scroll + `verify-audit` OK.
- [ ] Beat 5: preview latency + rollback duration pasted into README.
- [ ] Loom link + metric posted back on issue #24.

---

## Appendix A — expected responses reference

| Call | Expected shape |
|---|---|
| `search_products` | `{ products: [...], count: 300, first: 50 }` |
| `update_prices` (768 ids) | error `HARD_MAX_ITEMS_EXCEEDED` |
| `update_prices` (tag `sale`) | `{ status: "awaiting_approval", plan_token, item_count: 156, manifest }` |
| `execute_plan` | `{ status: "executed", item_count, succeeded_count, failed_count, refs }` |
| `rollback_plan` | `{ status: "rolled_back", item_count, succeeded_count, failed_count, refs }` |

## Appendix B — error codes the demo can surface

| Code | Meaning |
|---|---|
| `HARD_MAX_ITEMS_EXCEEDED` | Manifest exceeds `hardMaxItems` (250) — refused, no token, no approval path |
| `AWAITING_APPROVAL` | `execute_plan` called before approval — approve in the UI (or the plan expired) |
| `PLAN_REJECTED` | A human rejected the plan — the token is dead; re-preview |
| `PLAN_EXPIRED` | `planTtlMs` passed before execute — re-preview |
| `STATE_CHANGED` | Store drifted from the previewed state at execute time — re-preview |
| `ROLLBACK_WINDOW_EXPIRED` | Past `rollbackTtlMs` (default 24 h) or never previewed — cannot roll back |
| `ROLLBACK_UNSUPPORTED` | Kind is `cancel_order`/`refund_order` — not a value change, cannot be undone |

## Appendix C — troubleshooting

- **`execute_plan` returns `AWAITING_APPROVAL`:** the plan isn't approved yet, or its `planTtlMs` lapsed. Approve in the UI (or re-preview with a longer `SHOPIFY_PLAN_TTL_MS`).
- **`execute_plan` returns `UNKNOWN_PLAN_TOKEN`:** the token isn't from a preview on this server process (e.g. the server restarted, wiping in-memory plan state) — re-preview.
- **`STATE_CHANGED`:** anything touched the same variants since the preview (another take on the same store counts). Re-preview; it's the server doing its job.
- **Seed is slow:** the dev-store `orderCreate` cap is 5/min — run with `--order-delay-ms 1200` and budget ~24 minutes, or seed once and leave the store parked.
- **Port 4319 busy:** set `SHOPIFY_APPROVAL_SERVER_PORT` to a free port and use that URL.
- **No plan token for rollback:** rollback only works for plans this server process executed, within `rollbackTtlMs`. Both are process-scoped in-memory stores; a restart clears them.