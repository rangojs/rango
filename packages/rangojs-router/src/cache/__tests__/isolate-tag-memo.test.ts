import { describe, it, expect, vi } from "vitest";
import {
  TagMarkerMemo,
  TagNameHints,
  hintedTags,
  freshReadsRequired,
  summarizeMarkerOutcomes,
  recordMarkerRow,
  type MarkerFetch,
  type MarkerMemoOutcome,
  type MarkerReadThroughOptions,
} from "../isolate-tag-memo.js";
import type { ShellReadStats } from "../types.js";

describe("TagMarkerMemo", () => {
  it("serves a value as fresh inside the fresh window, stale up to the cap, then not at all", () => {
    const memo = new TagMarkerMemo();
    memo.store("t", 500, 1000);
    expect(memo.lookup("t", 100, 1000, 1099)).toEqual({
      value: 500,
      stale: false,
    });
    expect(memo.lookup("t", 100, 1000, 1100)).toEqual({
      value: 500,
      stale: true,
    });
    expect(memo.lookup("t", 100, 1000, 1999)).toEqual({
      value: 500,
      stale: true,
    });
    expect(memo.lookup("t", 100, 1000, 2000)).toBeUndefined();
  });

  it("memoizes an absent marker (null) like a value", () => {
    const memo = new TagMarkerMemo();
    memo.store("t", null, 0);
    expect(memo.lookup("t", 100, 1000, 50)).toEqual({
      value: null,
      stale: false,
    });
  });

  it("a fresh window of 0 turns the memo off", () => {
    const memo = new TagMarkerMemo();
    memo.store("t", 500, 0);
    expect(memo.lookup("t", 0, 1000, 0)).toBeUndefined();
  });

  it("markers only move forward: an older or absent read keeps a newer held value", () => {
    const memo = new TagMarkerMemo();
    memo.store("t", 900, 0); // a write-through by invalidateTags
    memo.store("t", 500, 10); // a read that started before it
    expect(memo.lookup("t", 100, 1000, 20)?.value).toBe(900);
    memo.store("t", null, 30); // a read that saw no marker yet
    expect(memo.lookup("t", 100, 1000, 40)?.value).toBe(900);
    memo.store("t", 1200, 50);
    expect(memo.lookup("t", 100, 1000, 60)?.value).toBe(1200);
  });

  it("evicts the least recently used tag past its entry cap", () => {
    const memo = new TagMarkerMemo(2);
    memo.store("a", 1, 0);
    memo.store("b", 2, 0);
    expect(memo.lookup("a", 100, 1000, 1)?.value).toBe(1); // a is now MRU
    memo.store("c", 3, 2);
    expect(memo.lookup("b", 100, 1000, 3)).toBeUndefined();
    expect(memo.lookup("a", 100, 1000, 3)?.value).toBe(1);
    expect(memo.lookup("c", 100, 1000, 3)?.value).toBe(3);
  });

  it("refreshes one key once at a time, hands the read to keepAlive, and stores its result", async () => {
    const memo = new TagMarkerMemo();
    let resolve!: (value: MarkerFetch) => void;
    const read = vi.fn(
      () =>
        new Promise<MarkerFetch>((r) => {
          resolve = r;
        }),
    );
    const kept: Promise<void>[] = [];
    memo.refresh("t", read, (pending) => kept.push(pending));
    memo.refresh("t", read, (pending) => kept.push(pending));
    expect(read).toHaveBeenCalledTimes(1);
    expect(kept).toHaveLength(1);
    resolve({ value: 700, memoize: true });
    await kept[0];
    expect(memo.lookup("t", 100, 1000)?.value).toBe(700);
    memo.refresh("t", read, (pending) => kept.push(pending));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a failed refresh, or one that may not be memoized, stores nothing and frees the key", async () => {
    const memo = new TagMarkerMemo();
    memo.store("t", 500, 0);
    const kept: Promise<void>[] = [];
    memo.refresh(
      "t",
      async () => {
        throw new Error("read failed");
      },
      (pending) => kept.push(pending),
    );
    await kept[0];
    memo.refresh(
      "t",
      async () => ({ value: null, memoize: false }), // timed out, failed open
      (pending) => kept.push(pending),
    );
    await kept[1];
    expect(memo.lookup("t", 100, 1000, 50)?.value).toBe(500);
    const read = vi.fn(async () => ({ value: 600, memoize: true }));
    memo.refresh("t", read, (pending) => kept.push(pending));
    expect(read).toHaveBeenCalledTimes(1);
  });

  // A marker written while a read was in flight may be missing from it: the
  // value is current as of the read's start, so its age counts from there,
  // not from when the read came back.
  it("ages a stored value from its read's start, not its end", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const memo = new TagMarkerMemo();
      let resolve!: (value: MarkerFetch) => void;
      const kept: Promise<void>[] = [];
      memo.refresh(
        "t",
        () =>
          new Promise<MarkerFetch>((r) => {
            resolve = r;
          }),
        (pending) => kept.push(pending),
      );
      vi.setSystemTime(1400); // the read comes back 400 ms later
      resolve({ value: null, memoize: true });
      await kept[0];
      expect(memo.lookup("t", 100, 1000, 1999)).toEqual({
        value: null,
        stale: true,
      });
      expect(memo.lookup("t", 100, 1000, 2000)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a slower read never moves a newer write-through back, in value or in age", () => {
    const memo = new TagMarkerMemo();
    memo.store("t", 900, 500); // invalidateTags() at 500
    memo.store("t", null, 100); // a read that started at 100
    expect(memo.lookup("t", 100, 1000, 1499)?.value).toBe(900);
    expect(memo.lookup("t", 100, 1000, 1500)).toBeUndefined();
  });
});

describe("TagMarkerMemo.readThrough", () => {
  const options = (
    extra: Partial<MarkerReadThroughOptions> = {},
  ): MarkerReadThroughOptions => ({
    freshMs: 100,
    maxStaleMs: 1000,
    bypass: false,
    ...extra,
  });

  it("reads the store on a miss and memoizes; serves the fresh value next", async () => {
    const memo = new TagMarkerMemo();
    const fetch = vi.fn(async () => ({ value: 7, memoize: true }));
    const outcomes: MarkerMemoOutcome[] = [];
    const onOutcome = (o: MarkerMemoOutcome) => outcomes.push(o);
    expect(await memo.readThrough("t", fetch, options({ onOutcome }))).toBe(7);
    expect(await memo.readThrough("t", fetch, options({ onOutcome }))).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(false);
    expect(outcomes).toEqual(["read", "fresh"]);
  });

  it("serves a stale value and refreshes it once in the background", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const memo = new TagMarkerMemo();
      memo.store("t", null, 0);
      vi.setSystemTime(500);
      let land!: () => void;
      const landed = new Promise<void>((resolve) => {
        land = resolve;
      });
      const fetch = vi.fn(async () => {
        await landed;
        return { value: 400, memoize: true };
      });
      const kept: Promise<void>[] = [];
      const outcomes: MarkerMemoOutcome[] = [];
      const read = () =>
        memo.readThrough(
          "t",
          fetch,
          options({
            keepAlive: (p) => kept.push(p),
            onOutcome: (o) => outcomes.push(o),
          }),
        );
      expect(await read()).toBeNull();
      expect(await read()).toBeNull(); // the refresh is still in flight
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(true);
      land();
      await Promise.all(kept);
      expect(await read()).toBe(400);
      expect(outcomes).toEqual(["stale", "stale", "fresh"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bypass reads the store even inside the fresh window, and refreshes the memo", async () => {
    const memo = new TagMarkerMemo();
    memo.store("t", null);
    const fetch = vi.fn(async () => ({ value: 5, memoize: true }));
    const outcomes: MarkerMemoOutcome[] = [];
    expect(
      await memo.readThrough(
        "t",
        fetch,
        options({ bypass: true, onOutcome: (o) => outcomes.push(o) }),
      ),
    ).toBe(5);
    expect(outcomes).toEqual(["bypass"]);
    expect(memo.lookup("t", 100, 1000)?.value).toBe(5);
  });

  it("a read that may not be memoized is returned for this request only", async () => {
    const memo = new TagMarkerMemo();
    const fetch = vi.fn(async () => ({ value: null, memoize: false }));
    expect(await memo.readThrough("t", fetch, options())).toBeNull();
    expect(memo.lookup("t", 100, 1000)).toBeUndefined();
  });

  it("a fresh window of 0 reads the store every time, memoizes nothing, reports nothing", async () => {
    const memo = new TagMarkerMemo();
    const fetch = vi.fn(async () => ({ value: 3, memoize: true }));
    const onOutcome = vi.fn();
    await memo.readThrough("t", fetch, options({ freshMs: 0, onOutcome }));
    await memo.readThrough("t", fetch, options({ freshMs: 0, onOutcome }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onOutcome).not.toHaveBeenCalled();
    expect(memo.lookup("t", 100, 1000)).toBeUndefined();
  });
});

describe("TagNameHints", () => {
  it("remembers a key's tag names, forgets them on an untagged entry, and evicts the least recently remembered", () => {
    const hints = new TagNameHints(2);
    hints.remember("k1", ["a"]);
    hints.remember("k2", ["b"]);
    expect(hints.get("k1")).toEqual(["a"]);
    hints.remember("k1", ["a", "c"]); // k1 is now the most recent
    hints.remember("k3", ["d"]);
    expect(hints.get("k2")).toBeUndefined();
    expect(hints.get("k1")).toEqual(["a", "c"]);
    hints.remember("k1", undefined);
    expect(hints.get("k1")).toBeUndefined();
  });
});

describe("hintedTags", () => {
  it("is the union of the remembered tags and the route's static tags", () => {
    expect(hintedTags(undefined, undefined)).toEqual([]);
    expect(hintedTags(["a"], undefined)).toEqual(["a"]);
    expect(hintedTags(undefined, ["r"])).toEqual(["r"]);
    expect(hintedTags(["a", "r"], ["r", "s"])).toEqual(["a", "r", "s"]);
  });
});

describe("summarizeMarkerOutcomes", () => {
  it("reports the most store-bound outcome among the shell's own tags", () => {
    const outcomes = new Map<string, MarkerMemoOutcome>([
      ["a", "fresh"],
      ["b", "stale"],
      ["c", "read"],
      ["d", "bypass"],
    ]);
    expect(summarizeMarkerOutcomes(["a"], outcomes)).toBe("fresh");
    expect(summarizeMarkerOutcomes(["a", "b"], outcomes)).toBe("stale");
    expect(summarizeMarkerOutcomes(["b", "c", "a"], outcomes)).toBe("read");
    expect(summarizeMarkerOutcomes(["a", "d", "c"], outcomes)).toBe("bypass");
    // A hinted tag the entry does not carry does not count.
    expect(summarizeMarkerOutcomes(["x"], outcomes)).toBeUndefined();
    expect(summarizeMarkerOutcomes(undefined, outcomes)).toBeUndefined();
  });
});

describe("recordMarkerRow", () => {
  it("fills the row from the entry's own tags: the memo outcome and the hinted count", () => {
    const stats: ShellReadStats = { tier: "l1", markerHinted: ["a", "x"] };
    recordMarkerRow(
      stats,
      ["a", "b"],
      new Map<string, MarkerMemoOutcome>([
        ["a", "fresh"],
        ["b", "read"],
        ["x", "bypass"],
      ]),
    );
    expect(stats.markerMemo).toBe("read");
    expect(stats.markerHintHits).toBe(1);
  });
});

describe("freshReadsRequired", () => {
  it("is true only for a request carrying the fresh-reads cookie", () => {
    expect(freshReadsRequired(undefined)).toBe(false);
    expect(freshReadsRequired({ _freshReads: false })).toBe(false);
    expect(freshReadsRequired({ _freshReads: true })).toBe(true);
  });
});
