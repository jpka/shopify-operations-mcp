# shopify-operations-mcp

Safe-write Shopify operations MCP server: plan-before-execute writes with
out-of-band localhost approval and audit. Work is tracked as tickets in
GitHub Issues (see the [build map](https://github.com/jpka/shopify-operations-mcp/issues/1)).

> The MCP server itself lands in later tickets; this repo currently ships the
> audit trail foundation (ticket #6) on top of `safe-write-mcp-core`.

## Audit trail: tamper-evident JSONL (no database)

Every audit event is appended as one JSON line to a JSONL file:

```json
{"seq":1,"prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","hash":"ab12…","ts":1700000000000,"tool":"update_prices",…}
```

- `seq` — monotonically increasing per file, starting at 1; the chain
  resumes after a server restart by continuing from the last stored line.
- `hash` — sha256 over the *canonical row*: the JSON of
  `{seq, prev_hash, …event fields}` in a fixed key order (the stored `hash`
  itself is excluded from the hashed input).
- `prev_hash` — the previous row's `hash`; the first row uses the genesis
  marker of 64 zero hex chars.

Any edit, deletion, or reordering of a row breaks the chain at that row.

### Durability and concurrency

- Each `record()` is a synchronous `writeSync` + `fsyncSync` on an
  `O_APPEND` descriptor. fsync-per-record is a deliberate choice: event
  volume is low and durability matters more than throughput here. Pass
  `{fsync: false}` to the factory to skip per-record fsync.
- **Single-writer only.** `seq` is tracked in-process; a second process
  appending to the same file is out of scope (verification flags the
  resulting duplicate seq, but the file becomes ambiguous).
- `record()` never throws: on a write failure it reports to stderr and
  drops the event. Startup is fail-fast — if the file cannot be opened or
  its last line is malformed, `createJsonlAuditSink` throws.

### PII: what may and must never be recorded

Order/product IDs and amounts ARE recorded. **Customer emails and names
must NEVER be recorded.** The sink records exactly the event it is given —
it does not redact on its own. Hosts building events from customer data
must pass events through `redactEvent()` (drops top-level keys matching
`/customerEmail|customerName/i`) and sanitize free-text `reason`/`detail`
strings before calling `record()`.

### Verifying the chain

```sh
npm run verify-audit -- <audit.jsonl>
```

Prints a summary (entries, last hash) and exits 0 when the chain is intact;
on the first broken row it prints the seq and expected-vs-actual hash and
exits 1.

## Tamper-evident, NOT tamper-proof

The JSONL chain detects tampering — it does not prevent it. Unlike the
Postgres audit model (with its append-only database grants), anyone with
write access to the audit file can truncate, rewrite, or replace the whole
chain; verification only *detects* that it happened. Treat the audit file
as sensitive: restrict write access to the server process and archive
signed copies off-box if you need stronger guarantees.