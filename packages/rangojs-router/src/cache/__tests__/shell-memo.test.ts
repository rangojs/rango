import { describe, it, expect } from "vitest";
import {
  DEFAULT_SHELL_MEMO_MAX_BYTES,
  DEFAULT_SHELL_MEMO_MS,
  RecentTagInvalidations,
  ShellMemo,
  freshReadsWindowMs,
  isShellFresh,
  resolveShellMemoOptions,
  shellHasAnyTag,
} from "../shell-memo.js";

describe("resolveShellMemoOptions", () => {
  const markerDefaults = { markerFreshMs: 1000, markerMaxStaleMs: 10_000 };

  it("defaults missing and non-finite values; keeps finite ones, 0 and negatives included", () => {
    const defaults = {
      shellMs: DEFAULT_SHELL_MEMO_MS,
      shellMaxBytes: DEFAULT_SHELL_MEMO_MAX_BYTES,
      ...markerDefaults,
    };
    expect(resolveShellMemoOptions(undefined, markerDefaults)).toEqual(
      defaults,
    );
    expect(
      resolveShellMemoOptions(
        {
          shellMs: Number.NaN,
          shellMaxBytes: Number.POSITIVE_INFINITY,
          markerFreshMs: Number.NaN,
        },
        markerDefaults,
      ),
    ).toEqual(defaults);
    expect(
      resolveShellMemoOptions(
        { shellMs: null as unknown as number },
        markerDefaults,
      ),
    ).toEqual(defaults);
    expect(
      resolveShellMemoOptions(
        {
          shellMs: 0,
          shellMaxBytes: -1,
          markerFreshMs: 0,
          markerMaxStaleMs: 5,
        },
        markerDefaults,
      ),
    ).toEqual({
      shellMs: 0,
      shellMaxBytes: -1,
      markerFreshMs: 0,
      markerMaxStaleMs: 5,
    });
  });
});

describe("freshReadsWindowMs", () => {
  const on = {
    shellMs: 2000,
    shellMaxBytes: 1024,
    markerFreshMs: 1000,
    markerMaxStaleMs: 10_000,
  };

  it("is the longest either memo can hold a pre-mutation value", () => {
    // Plus FRESH_READS_MARGIN_MS (1 s) for a background marker write.
    expect(freshReadsWindowMs(on, true)).toBe(11_000);
    // No marker memo (CFCacheStore without KV): the shell window alone.
    expect(freshReadsWindowMs(on, false)).toBe(3000);
    expect(freshReadsWindowMs({ ...on, markerFreshMs: 0 }, true)).toBe(3000);
    // Both memos off: no cookie at all.
    expect(freshReadsWindowMs({ ...on, shellMaxBytes: 0 }, false)).toBe(0);
    expect(
      freshReadsWindowMs({ ...on, shellMs: 0, markerFreshMs: 0 }, true),
    ).toBe(0);
    expect(
      freshReadsWindowMs({ ...on, shellMs: 0, markerMaxStaleMs: 500 }, true),
    ).toBe(2000);
  });
});

describe("isShellFresh / shellHasAnyTag", () => {
  it("fresh = not past its stale time (0 = never stale) and not past its expiry", () => {
    expect(isShellFresh(100, 200, 100)).toBe(true);
    expect(isShellFresh(100, 200, 101)).toBe(false);
    expect(isShellFresh(0, 200, 200)).toBe(true);
    expect(isShellFresh(0, 200, 201)).toBe(false);
  });

  it("matches any shared tag", () => {
    expect(shellHasAnyTag(["a", "b"], ["c", "b"])).toBe(true);
    expect(shellHasAnyTag(["a"], ["c"])).toBe(false);
    expect(shellHasAnyTag(undefined, ["a"])).toBe(false);
  });
});

describe("RecentTagInvalidations", () => {
  it("covers a shell tagged at or before the invalidation while it is pending, then for holdMs after it settles", () => {
    const recent = new RecentTagInvalidations();
    recent.begin(["home"], 1000, 1000);
    expect(recent.covers(["home", "x"], 1000, 5000)).toBe(true);
    expect(recent.covers(["home"], 999, 5000)).toBe(true);
    // Tagged after the invalidation, or not carrying the tag: not covered.
    expect(recent.covers(["home"], 1001, 5000)).toBe(false);
    expect(recent.covers(["x"], 1000, 5000)).toBe(false);
    expect(recent.covers(undefined, 1000, 5000)).toBe(false);
    // Pending for as long as the invalidation runs; then held for holdMs.
    recent.settle(["home"], 2000, 6000);
    expect(recent.covers(["home"], 1000, 7999)).toBe(true);
    expect(recent.covers(["home"], 1000, 8000)).toBe(false);
  });

  it("a tagged shell with no tag time is covered", () => {
    const recent = new RecentTagInvalidations();
    recent.begin(["home"], 1000, 1000);
    expect(recent.covers(["home"], undefined, 1000)).toBe(true);
  });

  it("overlapping invalidations of one tag: the latest time, pending until both settle", () => {
    const recent = new RecentTagInvalidations();
    recent.begin(["home"], 1000, 1000);
    recent.begin(["home"], 1500, 1500);
    recent.settle(["home"], 100, 2000);
    expect(recent.covers(["home"], 1400, 10_000)).toBe(true);
    recent.settle(["home"], 100, 11_000);
    expect(recent.covers(["home"], 1400, 11_099)).toBe(true);
    expect(recent.covers(["home"], 1400, 11_100)).toBe(false);
  });

  it("drops settled records past their hold on the next begin", () => {
    const recent = new RecentTagInvalidations();
    recent.begin(["old"], 1000, 1000);
    recent.settle(["old"], 100, 1000);
    recent.begin(["new"], 2000, 2000);
    expect(
      (recent as unknown as { records: Map<string, unknown> }).records.size,
    ).toBe(1);
  });
});

describe("ShellMemo", () => {
  it("serves a value stored less than the window ago, then expires it", () => {
    const memo = new ShellMemo<string>();
    memo.set("k", "v", 10, 2000, 100, 1000);
    expect(memo.get("k", 2000, 2999)).toBe("v");
    expect(memo.get("k", 2000, 3000)).toBeUndefined();
    expect(memo.size).toBe(0);
  });

  it("a window of 0 neither stores nor serves", () => {
    const memo = new ShellMemo<string>();
    memo.set("k", "v", 10, 0, 100, 1000);
    expect(memo.size).toBe(0);
    memo.set("k", "v", 10, 2000, 100, 1000);
    expect(memo.get("k", 0, 1000)).toBeUndefined();
  });

  it("evicts the least recently used entries to stay within the byte cap", () => {
    const memo = new ShellMemo<string>();
    memo.set("a", "A", 40, 2000, 100, 0);
    memo.set("b", "B", 40, 2000, 100, 0);
    // Touch a: b becomes the least recently used.
    expect(memo.get("a", 2000, 1)).toBe("A");
    memo.set("c", "C", 40, 2000, 100, 2);
    expect(memo.get("b", 2000, 3)).toBeUndefined();
    expect(memo.get("a", 2000, 3)).toBe("A");
    expect(memo.get("c", 2000, 3)).toBe("C");
    expect(memo.size).toBe(80);
  });

  it("drops entries past their window when storing, whether or not they were read", () => {
    const memo = new ShellMemo<string>();
    memo.set("old", "O", 40, 1000, 100, 0);
    memo.set("recent", "R", 30, 1000, 100, 500);
    memo.set("new", "N", 10, 1000, 100, 1200);
    // "old" (stored at 0, window 1 s) is gone without a read or cap pressure.
    expect(memo.size).toBe(40);
    expect(memo.get("recent", 1000, 1300)).toBe("R");
  });

  it("does not store a value larger than the whole cap", () => {
    const memo = new ShellMemo<string>();
    memo.set("small", "s", 10, 2000, 100, 0);
    memo.set("big", "B", 101, 2000, 100, 0);
    expect(memo.get("big", 2000, 1)).toBeUndefined();
    expect(memo.get("small", 2000, 1)).toBe("s");
  });

  it("replacing a key frees its old bytes; deleteWhere drops matches", () => {
    const memo = new ShellMemo<{ tags: string[] }>();
    memo.set("a", { tags: ["x"] }, 30, 2000, 100, 0);
    memo.set("a", { tags: ["x", "y"] }, 50, 2000, 100, 0);
    memo.set("b", { tags: ["z"] }, 20, 2000, 100, 0);
    expect(memo.size).toBe(70);
    memo.deleteWhere((value) => value.tags.includes("y"));
    expect(memo.get("a", 2000, 1)).toBeUndefined();
    expect(memo.size).toBe(20);
  });
});
