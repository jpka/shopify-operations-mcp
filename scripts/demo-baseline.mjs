#!/usr/bin/env node
/**
 * Baseline check for the #24 Loom demo (docs/demo-runbook.md, section 0.6).
 *
 * Spawns a fresh `dist/index.js` over stdio with the same env the prep script
 * exports (approval server disabled so it never contends for the staged
 * server's port), calls search_products(), and asserts the two sizing
 * invariants the demo depends on plus the runbook's expected catalog shape:
 *
 *   { products: [...], count: 300, first: 50 }  -> 300 products
 *   total variants == 768                        -> store-wide reprice refused
 *   variants in sale-tagged products == 156      -> sale reprice requests approval
 *   every product's flags.protected == false     -> nothing carries do-not-touch
 *
 * search_products is read-only and writes no audit rows, so this never touches
 * the staged audit chain.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load the repo's gitignored .env (CRLF-tolerant) for any SHOPIFY_* var not
// already set, mirroring scripts/demo-prep.sh. Handles the legacy
// SHOPIFY_SHOP_DOMAIN name the repo's .env uses.
if (existsSync(resolve(process.cwd(), ".env"))) {
  const content = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (key.startsWith("SHOPIFY_") && process.env[key] === undefined) {
      process.env[key] = line.slice(eq + 1).trim();
    }
  }
  if (process.env.SHOPIFY_STORE_DOMAIN === undefined && process.env.SHOPIFY_SHOP_DOMAIN) {
    process.env.SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
  }
}

const EXPECTED = { products: 300, variants: 768, saleVariants: 156 };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: process.cwd(),
  env: {
    ...process.env,
    SHOPIFY_APPROVAL_SERVER_ENABLED: "false",
    // Never write to the repo's default audit path; search_products is
    // read-only and writes no rows, so a temp path stays empty.
    SHOPIFY_AUDIT_PATH: process.env.SHOPIFY_AUDIT_PATH ?? "/tmp/demo-baseline-audit.jsonl",
  },
});

const client = new Client({ name: "demo-prep-baseline", version: "0.1.0" });

let exitCode = 0;
try {
  await client.connect(transport);

  const res = await client.callTool({ name: "search_products", arguments: {} });
  const text = res.content?.[0]?.text;
  if (!text) throw new Error("empty tool result");
  const data = JSON.parse(text);
  const products = data.products;
  if (!Array.isArray(products)) {
    throw new Error(`unexpected result shape: ${text.slice(0, 200)}`);
  }

  let variants = 0;
  let saleVariants = 0;
  let protectedProducts = 0;
  for (const product of products) {
    const count = product.variants?.length ?? 0;
    variants += count;
    if (product.tags?.includes("sale")) saleVariants += count;
    if (product.flags?.protected) protectedProducts += 1;
  }

  console.log(
    `baseline: ${products.length} products, ${variants} variants, ` +
      `${saleVariants} sale-tagged variants, ${protectedProducts} protected products`,
  );

  const failures = [];
  if (data.count !== EXPECTED.products) {
    failures.push(`count=${data.count} expected ${EXPECTED.products}`);
  }
  if (variants !== EXPECTED.variants) {
    failures.push(`variants=${variants} expected ${EXPECTED.variants}`);
  }
  if (saleVariants !== EXPECTED.saleVariants) {
    failures.push(`sale-tagged variants=${saleVariants} expected ${EXPECTED.saleVariants}`);
  }
  if (protectedProducts !== 0) {
    failures.push(`protected products=${protectedProducts} expected 0`);
  }

  if (failures.length > 0) {
    console.error(`baseline FAILED: ${failures.join("; ")}`);
    exitCode = 1;
  } else {
    console.log("baseline OK: matches runbook section 0.6 (300 products, 768 variants, 156 sale-tagged, none protected)");
  }
} catch (err) {
  console.error(`baseline FAILED: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await client.close().catch(() => {});
}

process.exit(exitCode);