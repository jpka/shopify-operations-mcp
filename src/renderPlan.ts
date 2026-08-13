import type { PendingPlan, RenderPlan, RenderablePlan } from "safe-write-mcp-core";
import type { Manifest, ManifestItem } from "./plans/manifest.js";

/**
 * The host hook that shapes how a pending plan's payload is displayed on the
 * localhost approval surface (see the core's ApprovalServerOptions.renderPlan).
 * A plan's payload is a `Manifest` — the exact preview artifact the token is
 * bound to — so a reviewer sees precisely what execute_plan would run: one
 * row per item with the previewed `before` and planned `after` state, the
 * agent's stated reason, and host-computed per-item risk flags.
 */

/** Compact single-line JSON for a manifest value (before/after snapshots). */
function compact(value: unknown): string {
  return JSON.stringify(value);
}

/** The compared fields of a manifest item, as plain records. */
function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Per-item risk flags a reviewer can judge a change by without opening the
 * raw JSON: a price move as a percentage (the same yardstick the
 * `maxPriceChangePct` plan invariant uses), plus title/tags changes. Returns
 * an empty array when the snapshots don't expose these fields — the table
 * then renders a dash rather than inventing flags.
 */
function flagsOf(item: ManifestItem): string[] {
  const flags: string[] = [];
  const before = record(item.before);
  const after = record(item.after);

  const beforePrice = typeof before.price === "number" ? before.price : null;
  const afterPrice = typeof after.price === "number" ? after.price : null;
  if (beforePrice !== null && afterPrice !== null && beforePrice !== afterPrice) {
    const pct = ((afterPrice - beforePrice) / beforePrice) * 100;
    const sign = pct > 0 ? "+" : "";
    flags.push(`price ${sign}${pct.toFixed(1)}%`);
  }
  if (before.title !== after.title) flags.push("title changed");
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) {
    flags.push("tags changed");
  }
  return flags;
}

/**
 * Renders `rows` as a fixed-width text table (header + body) for display in
 * the approval page's `<pre>`. Column widths are the widest cell per column,
 * so the columns line up when rendered in a monospace font.
 */
function alignTable(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) =>
    Math.max(...rows.map((row) => (row[c] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, c) => cell.padEnd(widths[c] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/**
 * The Shopify renderPlan: a card titled with the driving tool and item count,
 * whose single `Manifest` detail is a table with the five columns a reviewer
 * needs — item (ref), before, after, reason, flags. The raw digest follows so
 * the displayed manifest can be cross-checked against the preview response.
 */
export const renderPlan: RenderPlan<Manifest<ManifestItem>> = (
  plan: PendingPlan<Manifest<ManifestItem>>,
): RenderablePlan => {
  const manifest = plan.payload;
  const reason = plan.reason ?? "(none)";
  const rows: string[][] = [
    ["Item", "Before", "After", "Reason", "Flags"],
    ...manifest.items.map((item) => [
      item.ref,
      compact(item.before),
      compact(item.after),
      reason,
      flagsOf(item).join(", ") || "—",
    ]),
  ];
  return {
    title: `${plan.tool}: ${manifest.items.length} item${manifest.items.length === 1 ? "" : "s"}`,
    details: [
      { label: "Manifest", value: alignTable(rows) },
      { label: "Digest", value: manifest.digest },
    ],
  };
};