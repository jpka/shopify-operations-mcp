import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotStore } from "../../src/plans/snapshotStore.ts";

describe("SnapshotStore (ticket #9)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures per-item before-state keyed by plan token", () => {
    const store = new SnapshotStore<string>(60_000);
    store.capture("tok-1", [
      { ref: "a", before: "state-a" },
      { ref: "b", before: "state-b" },
    ]);

    expect(store.has("tok-1")).toBe(true);
    expect(store.snapshot("tok-1")).toEqual({ a: "state-a", b: "state-b" });
    expect(store.snapshot("tok-2")).toBeNull();
  });

  it("capture overwrites an earlier snapshot for the same token", () => {
    const store = new SnapshotStore<string>(60_000);
    store.capture("tok-1", [{ ref: "a", before: "old" }]);
    store.capture("tok-1", [{ ref: "a", before: "new" }]);
    expect(store.snapshot("tok-1")).toEqual({ a: "new" });
  });

  it("drop removes a snapshot idempotently", () => {
    const store = new SnapshotStore<string>(60_000);
    store.capture("tok-1", [{ ref: "a", before: "state-a" }]);
    store.drop("tok-1");
    expect(store.has("tok-1")).toBe(false);
    store.drop("tok-1");
    expect(store.snapshot("tok-1")).toBeNull();
  });

  it("expired snapshots read as absent and are swept", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = new SnapshotStore<string>(60_000);
    store.capture("tok-1", [{ ref: "a", before: "state-a" }]);

    vi.setSystemTime(1_000 + 60_000 + 1);
    expect(store.snapshot("tok-1")).toBeNull();
    expect(store.has("tok-1")).toBe(false);

    store.capture("tok-2", [{ ref: "b", before: "state-b" }]);
    store.sweep();
    expect(store.has("tok-1")).toBe(false);
    expect(store.has("tok-2")).toBe(true);
  });
});