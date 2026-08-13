import { describe, expect, it } from "vitest";
import {
  assembleManifest,
  beforeDigestOf,
  manifestDigest,
} from "../../src/plans/manifest.ts";

const product = (id: string, price: number) => ({
  id,
  title: `Product ${id}`,
  price,
  tags: [],
});

describe("manifest digests (ticket #9)", () => {
  it("assembleManifest computes stable digest and beforeDigest", () => {
    const items = [
      { ref: "a", before: product("a", 10), after: product("a", 12) },
      { ref: "b", before: product("b", 20), after: product("b", 22) },
    ];
    const manifest = assembleManifest(items);

    expect(manifest.digest).toBeTypeOf("string");
    expect(manifest.digest).toHaveLength(64);
    expect(manifest.beforeDigest).toBeTypeOf("string");
    expect(manifest.digest).not.toBe(manifest.beforeDigest);

    const rebuilt = assembleManifest(items);
    expect(rebuilt.digest).toBe(manifest.digest);
    expect(rebuilt.beforeDigest).toBe(manifest.beforeDigest);
  });

  it("beforeDigest changes when a before value drifts", () => {
    const before = [
      { ref: "a", before: product("a", 10) },
      { ref: "b", before: product("b", 20) },
    ];
    const drifted = [
      { ref: "a", before: product("a", 10) },
      { ref: "b", before: product("b", 25) },
    ];
    expect(beforeDigestOf(drifted)).not.toBe(beforeDigestOf(before));
  });

  it("beforeDigest is unaffected by the after values", () => {
    const items = [
      { ref: "a", before: product("a", 10), after: product("a", 11) },
    ];
    const differentAfter = [
      { ref: "a", before: product("a", 10), after: product("a", 99) },
    ];
    expect(beforeDigestOf(differentAfter)).toBe(beforeDigestOf(items));
    expect(manifestDigest(differentAfter)).not.toBe(manifestDigest(items));
  });

  it("manifestDigest changes when an after value changes", () => {
    const items = [
      { ref: "a", before: product("a", 10), after: product("a", 12) },
    ];
    const different = [
      { ref: "a", before: product("a", 10), after: product("a", 13) },
    ];
    expect(manifestDigest(different)).not.toBe(manifestDigest(items));
  });
});