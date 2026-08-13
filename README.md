# shopify-operations-mcp

Safe-write Shopify operations MCP server: plan-before-execute writes with
out-of-band localhost approval and audit. Work is tracked as tickets in
GitHub Issues (see the [build map](https://github.com/jpka/shopify-operations-mcp/issues/1)).

> The MCP server wiring itself lands in later tickets; this repo currently ships
> the audit trail foundation (ticket #6), the two-phase plan framework (ticket
> #9), and the read tools (ticket #7) on top of `safe-write-mcp-core`.

## Tools

### search_products (read)

Find products/variants and their current pricing/inventory references. Reads
only — never mutates. Protected items are returned but flagged, never filtered.

Filters (all optional, ANDed into the Admin API `query` argument):

- `title` — product title (Shopify fuzzy search)
- `sku` — variant SKU
- `vendor` — vendor
- `tag` — product tag
- `first` — page size for the internal cursor walk (default 50)

The products connection is walked to completion via cursor pagination
(`paginateConnection`), so every matching product is returned.

Result shape:

```ts
interface SearchProductsResult {
  products: ProductRef[];
  count: number;
  first: number; // page size used
}

interface ProductRef {
  id: string;            // gid://shopify/Product/…
  title: string;
  vendor: string | null;
  tags: string[];
  variants: VariantRef[];
  flags: ProtectedFlags; // protected tag annotation
}

interface VariantRef {
  id: string;            // gid://shopify/ProductVariant/…
  sku: string | null;
  price: string;         // as Shopify stores it, e.g. "19.99"
  inventoryItemId: string; // gid://shopify/InventoryItem/…
  inventoryLevels: InventoryLevelRef[]; // per-location availability
  flags: ProtectedFlags;
}

interface ProtectedFlags {
  protected: boolean;      // true when a configured protected tag is present
  protectedTags: string[]; // which configured tags matched (empty when safe)
}
```

`InventoryLevelRef` carries `id`, `available` (units), `locationId`, and
`locationName`. Items carrying a `protectedTags` tag are returned normally but
with `flags.protected: true`, so a later write plan touching them is refused.

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

Any edit, reordering, or deletion of a **non-terminal** row breaks the
chain at that row. Deleting terminal rows (truncating the suffix) or
replacing the whole file with another internally valid chain is not
detectable from the file alone — anchor the expected final hash in an
externally stored or signed checkpoint if you need to detect that.

### Durability and concurrency

- Each `record()` is a synchronous `writeSync` + `fsyncSync` on an
  `O_APPEND` descriptor. fsync-per-record is a deliberate choice: event
  volume is low and durability matters more than throughput here. Pass
  `{fsync: false}` to the factory to skip per-record fsync.
- **Single-writer only.** `seq` is tracked in-process; a second process
  appending to the same file is out of scope (verification flags the
  resulting duplicate seq, but the file becomes ambiguous).
- `record()` never throws: on a write error (including a short write or a
  failed fsync) the sink reports to stderr, enters a failed state, and drops
  every later record. It never retries the failed seq — the row may exist
  on disk despite the failed fsync, and a retry could write an ambiguous
  duplicate. Startup is fail-fast: if the file cannot be opened or the
  existing chain does not verify, `createJsonlAuditSink` throws.

### PII: what may and must never be recorded

Order/product IDs and amounts ARE recorded. **Customer emails and names
must NEVER be recorded.** As defense-in-depth the sink strips top-level
keys matching `/customerEmail|customerName/i` from every event before
hashing and serializing (`redactEvent()` — also exported for hosts that
want to redact before building events). Free-text `reason`/`detail`
strings cannot be redacted by key, so hosts must sanitize those before
calling `record()`.

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
write access to the audit file can truncate the suffix, rewrite, or
replace the whole chain, and a truncated or replaced chain can still
verify internally; verification only *detects* edits, reordering, and
non-terminal deletions. Keep an externally stored (ideally signed)
checkpoint of the expected final hash if you need to detect suffix
truncation or full-chain replacement. Treat the audit file as sensitive:
restrict write access to the server process and archive signed copies
off-box for stronger guarantees.