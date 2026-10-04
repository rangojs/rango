import { describe, it, expect, vi } from "vitest";
import {
  RecordingShellStore,
  SeededShellStore,
  getRecordingStore,
  buildShellLoaderSeed,
  countSnapshotFamilies,
  hasDocRecord,
  pruneShellSnapshot,
} from "../shell-snapshot.js";

// buildShellLoaderSeed lazily imports the Flight codec; the real module pulls
// the virtual @vitejs/plugin-rsc import that unit configs cannot resolve, so
// pin it to JSON here (shape-faithful for the seed-mapping assertions).
vi.mock("../segment-codec.js", () => ({
  serializeResult: vi.fn(async (value: unknown) => JSON.stringify(value)),
  deserializeResult: vi.fn(async (value: string) => {
    if (value === "%broken%") throw new Error("decode boom");
    return JSON.parse(value);
  }),
}));
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import type {
  SegmentCacheStore,
  CachedEntryData,
  ShellSnapshotRecord,
} from "../types.js";
import {
  CACHE_READ_ERROR,
  type CacheReadError as CacheReadErrorT,
} from "../types.js";

// get() may return CACHE_READ_ERROR (backend failure, distinct from a miss);
// these tests assert hit/miss shapes, so narrow the sentinel away up front.
function hit(
  r: import("../types.js").CacheGetResult | null | CacheReadErrorT,
): import("../types.js").CacheGetResult | null {
  return r === CACHE_READ_ERROR ? null : r;
}

// The capture data snapshot: RecordingShellStore records the doc record the
// CAPTURE render wrote and nothing it read; SeededShellStore serves the
// segment records to the implicit doc scope of a HIT tail or a partial
// replay. No cache read is pinned: a HIT's holes read the store.
// See cache/shell-snapshot.ts and docs/design/ppr-shell-resume.md.

function segData(tag: string): CachedEntryData {
  return {
    segments: [],
    handles: "",
    expiresAt: Date.now() + 60_000,
    tags: [tag],
  };
}

describe("RecordingShellStore", () => {
  it("records no cache read or write: every call passes through to the real store", async () => {
    const inner = new MemorySegmentCacheStore();
    await inner.set("seg1", segData("s"), 60);
    await inner.setItem("item1", "ITEM-VALUE", { ttl: 60 });
    await inner.putResponse("res1", new Response("BODY", { status: 201 }), 60);

    const rec = new RecordingShellStore(inner);
    expect(hit(await rec.get("seg1"))).not.toBeNull();
    expect((await rec.getItem("item1"))?.value).toBe("ITEM-VALUE");
    expect(await rec.getResponse("res1")).not.toBeNull();
    await rec.set("seg2", segData("s2"), 60);
    await rec.setItem("item2", "WRITTEN", { ttl: 60 });

    expect(rec.drainSnapshot()).toBeUndefined();
    expect(hit(await inner.get("seg2"))).not.toBeNull();
    expect((await inner.getItem("item2"))?.value).toBe("WRITTEN");
  });

  it("records a segment write through recordSegmentWrite only, last write wins, without touching the real store", async () => {
    const inner = new MemorySegmentCacheStore();
    const rec = new RecordingShellStore(inner);

    rec.recordSegmentWrite("doc:k", segData("old"));
    rec.recordSegmentWrite("doc:k", segData("new"));

    expect(rec.getRecord("doc:k")?.tags).toEqual(["new"]);
    expect(rec.getRecord("absent")).toBeUndefined();
    expect(rec.drainSnapshot()).toEqual([
      { family: "segment", key: "doc:k", value: rec.getRecord("doc:k") },
    ]);
    expect(hit(await inner.get("doc:k"))).toBeNull();
  });

  it("EXCLUDES the shell family (getShell/putShell are never recorded)", async () => {
    const inner = new MemorySegmentCacheStore();
    const rec = new RecordingShellStore(inner);

    await rec.putShell(
      "k",
      {
        prelude: "x",
        postponed: null,
        reactVersion: "1",
        buildVersion: "b",
        snapshot: [],
        createdAt: Date.now(),
      },
      300,
    );
    await rec.getShell("k");

    expect(rec.drainSnapshot()).toBeUndefined();
    // But the shell was still persisted to the underlying store.
    expect(await inner.getShell("k")).not.toBeNull();
  });

  it("settleWrites awaits tracked deferred writes so their records are present", async () => {
    const inner = new MemorySegmentCacheStore();
    const rec = new RecordingShellStore(inner);

    // A deferred doc-record write (cacheRoute under waitUntil) runs on a
    // later task.
    let resolved = false;
    rec.trackWrite(
      (async () => {
        await new Promise((r) => setTimeout(r, 10));
        rec.recordSegmentWrite("doc:late", segData("late"));
        resolved = true;
      })(),
    );

    await expect(rec.settleWrites(1000)).resolves.toBe(true);
    expect(resolved).toBe(true);
    expect(rec.getRecord("doc:late")).toBeTruthy();
  });

  it("settleWrites is bounded: a hung write does not stall past the timeout", async () => {
    const inner = new MemorySegmentCacheStore();
    const rec = new RecordingShellStore(inner);
    rec.trackWrite(new Promise(() => {})); // never settles
    const start = Date.now();
    // False: the capture reads it as "the doc record may be missing because
    // its write did not settle in time" (settleCaptureRecord's timeout).
    await expect(rec.settleWrites(30)).resolves.toBe(false);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("delegates defaults/keyGenerator to the underlying store", () => {
    const inner = new MemorySegmentCacheStore({ defaults: { ttl: 42 } });
    const rec = new RecordingShellStore(inner);
    expect(rec.defaults).toEqual({ ttl: 42 });
  });

  it("getRecordingStore returns a RecordingShellStore (instanceof), ignores others", () => {
    const inner = new MemorySegmentCacheStore();
    const rec = new RecordingShellStore(inner);
    expect(getRecordingStore(rec)).toBe(rec);
    expect(getRecordingStore(inner)).toBeUndefined();
    expect(getRecordingStore(undefined)).toBeUndefined();
  });
});

describe("SeededShellStore", () => {
  function snapshotOf(): ShellSnapshotRecord[] {
    return [
      { family: "segment", key: "seg1", value: segData("pinned") },
      {
        family: "loader",
        key: "M0L0D0.bake",
        value: { value: "{}", holes: 0, runs: 0 },
      },
    ];
  }

  it("serves the segment records AS FRESH (shouldRevalidate: false) without touching the real store", async () => {
    // Pin the clock: snapshotOf() -> segData() embeds `Date.now() + 60_000` as
    // expiresAt, and this test builds the seed and the expected value from two
    // SEPARATE snapshotOf() calls. On real timers a millisecond tick between them
    // makes the deep-equal below flake by 1ms (seen on CI). Same pattern as
    // src/cache/__tests__/shell-cache.test.ts.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const inner = new MemorySegmentCacheStore();
      const getSpy = vi.spyOn(inner, "get");
      const segments = new SeededShellStore(inner, snapshotOf());

      const seg = hit(await segments.get("seg1"));
      expect(seg).toEqual({
        data: (snapshotOf()[0] as any).value,
        shouldRevalidate: false,
      });
      expect(getSpy).not.toHaveBeenCalled(); // pinned key never hits the real store
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries only segments: no item, response or shell surface to read a capture's value through", () => {
    const seeded = new SeededShellStore(
      new MemorySegmentCacheStore({ defaults: { ttl: 42 } }),
      snapshotOf(),
    );
    expect(seeded.defaults).toEqual({ ttl: 42 });
    for (const method of [
      "getItem",
      "setItem",
      "getResponse",
      "putResponse",
      "getShell",
      "putShell",
      "isTagsInvalidatedSince",
    ]) {
      expect(method in seeded).toBe(false);
    }
  });

  it("isolates all segment reads and mutations", async () => {
    const inner = new MemorySegmentCacheStore();
    await inner.set("seg1", segData("original"), 60);
    await inner.set("unseeded", segData("inner"), 60);
    const seeded = new SeededShellStore(inner, snapshotOf());

    expect(await seeded.delete("seg1")).toBe(true);
    expect(hit(await seeded.get("seg1"))).toBeNull();
    expect(hit(await seeded.get("unseeded"))).toBeNull();

    await seeded.set("unseeded", segData("fresh"));

    expect(hit(await seeded.get("unseeded"))?.data.tags).toEqual(["fresh"]);
    expect(hit(await inner.get("seg1"))?.data.tags).toEqual(["original"]);
    expect(hit(await inner.get("unseeded"))?.data.tags).toEqual(["inner"]);
  });
});

// A capture runs on RecordingShellStore as the request's store; the writes
// it passes through gate on the inner store's markers (#977). A HIT tail's
// store is the request's own, and SeededShellStore keeps its writes local.
describe("RecordingShellStore forwards isTagsInvalidatedSince", () => {
  it("to the inner store, and is absent without one", async () => {
    const isTagsInvalidatedSince = vi.fn(async () => true);
    const inner = { isTagsInvalidatedSince } as unknown as SegmentCacheStore;

    expect(
      await new RecordingShellStore(inner).isTagsInvalidatedSince?.(["t"], 5, {
        failClosed: true,
      }),
    ).toBe(true);
    expect(isTagsInvalidatedSince).toHaveBeenCalledWith(["t"], 5, {
      failClosed: true,
    });
    expect(
      new RecordingShellStore({} as SegmentCacheStore).isTagsInvalidatedSince,
    ).toBeUndefined();
  });
});

describe("buildShellLoaderSeed", () => {
  it("maps the stored hole and runs bits onto seed entries", async () => {
    const snapshot: ShellSnapshotRecord[] = [
      {
        family: "loader",
        key: "R0D0.K-full",
        value: { value: JSON.stringify({ a: 1 }), holes: 0, runs: 0 },
      },
      {
        family: "loader",
        key: "R0D1.K-holey",
        value: { value: JSON.stringify({ a: 1 }), holes: 1, runs: 0 },
      },
      {
        family: "loader",
        key: "R0D2.K-runs",
        value: { value: JSON.stringify({ a: 1 }), holes: 0, runs: 1 },
      },
    ];

    const seed = await buildShellLoaderSeed(snapshot);
    expect(seed?.get("K-full")).toEqual({
      container: { a: 1 },
      holes: false,
      runs: false,
      complete: true,
    });
    expect(seed?.get("K-holey")?.holes).toBe(true);
    // A capture that saw an unrecordable loader push asks the HIT to run it.
    expect(seed?.get("K-runs")).toMatchObject({
      holes: false,
      runs: true,
      complete: true,
    });
  });

  it("a record stored before the bits existed reads as hole-carrying and as runs (the body supplies what the pin lacks)", async () => {
    // A v0.17 entry: its snapshot lacks the loader-owned pushes, so serving it
    // pin-only would drop them, and so would treating its record as the whole
    // of the loader's pushes (`complete`).
    const legacy = {
      family: "loader",
      key: "R0D0.K-legacy",
      value: { value: JSON.stringify({ a: 1 }) },
    } as unknown as ShellSnapshotRecord;
    const preRuns = {
      family: "loader",
      key: "R0D1.K-pre-runs",
      value: { value: JSON.stringify({ a: 1 }), holes: 0 },
    } as unknown as ShellSnapshotRecord;

    const seed = await buildShellLoaderSeed([legacy, preRuns]);
    expect(seed?.get("K-legacy")).toMatchObject({
      holes: true,
      runs: true,
      complete: false,
    });
    expect(seed?.get("K-pre-runs")).toMatchObject({
      holes: false,
      runs: true,
      complete: false,
    });
  });

  // A pin is stored under `${shortCode}D${index}.${loaderId}`: a shortCode
  // holds no "D" and no ".", a loader id can hold both.
  it("keys the seed by loader, for ids and shortCodes of every shape", async () => {
    const ids = [
      "src/loaders.ts#Product",
      "D:/app/src/a.bD2.loaders.ts#Detail",
      "a1b2c3#D0.x",
    ];
    const value = { value: JSON.stringify(1), holes: 0, runs: 0 } as const;
    const seed = await buildShellLoaderSeed([
      { family: "loader", key: `M0L0D0.${ids[0]}`, value },
      { family: "loader", key: `M0L0I0R12D0.${ids[1]}`, value },
      { family: "loader", key: `M0L0I0R12D1.${ids[2]}`, value },
      // One loader pinned under two segments (a route loader a layout's
      // parallel slots inherit): one run, one pin.
      { family: "loader", key: `M0L0I0R12L3D0.${ids[0]}`, value },
    ]);

    expect([...(seed?.keys() ?? [])]).toEqual(ids);
  });

  it("drops a pin whose key is not a loader segment id", async () => {
    const value = { value: JSON.stringify(1), holes: 0, runs: 0 } as const;
    const seed = await buildShellLoaderSeed([
      { family: "loader", key: "not-a-pin.x#L", value },
      { family: "loader", key: "R0.@slotD0.x#Slot", value },
      { family: "loader", key: "R0D0.x#Good", value },
    ]);

    expect([...(seed?.keys() ?? [])]).toEqual(["x#Good"]);
  });

  it("skips a record that fails to decode (that loader drifts, the pre-snapshot behavior)", async () => {
    const snapshot: ShellSnapshotRecord[] = [
      {
        family: "loader",
        key: "R0D0.K-bad",
        value: { value: "%broken%", holes: 0, runs: 0 },
      },
      {
        family: "loader",
        key: "R0D1.K-good",
        value: { value: JSON.stringify(7), holes: 0, runs: 0 },
      },
    ];

    const seed = await buildShellLoaderSeed(snapshot);
    expect(seed?.has("K-bad")).toBe(false);
    expect(seed?.get("K-good")).toEqual({
      container: 7,
      holes: false,
      runs: false,
      complete: true,
    });
  });

  it("returns undefined when the snapshot carries no loader records", async () => {
    const snapshot: ShellSnapshotRecord[] = [
      { family: "segment", key: "S", value: segData("t") },
    ];
    expect(await buildShellLoaderSeed(snapshot)).toBeUndefined();
  });
});

describe("snapshot round-trip", () => {
  it("a doc record and a loader pin round-trip through MemorySegmentCacheStore putShell/getShell", async () => {
    const store = new MemorySegmentCacheStore();
    const rec = new RecordingShellStore(new MemorySegmentCacheStore());
    rec.recordSegmentWrite("doc:host/p", segData("t"));
    const snapshot: ShellSnapshotRecord[] = [
      ...rec.drainSnapshot()!,
      {
        family: "loader",
        key: "M0L0D0.bake",
        value: { value: JSON.stringify({ a: 1 }), holes: 0, runs: 0 },
      },
    ];

    await store.putShell(
      "/p:shell",
      {
        prelude: btoa("<html></html>"),
        postponed: null,
        reactVersion: "1",
        buildVersion: "b",
        snapshot,
        createdAt: Date.now(),
      },
      300,
    );

    const got = await store.getShell("/p:shell");
    expect(got!.entry.snapshot).toEqual(snapshot);
    // And it seeds correctly.
    const seeded = new SeededShellStore(
      new MemorySegmentCacheStore(),
      got!.entry.snapshot!,
    );
    expect(hit(await seeded.get("doc:host/p"))?.data.tags).toEqual(["t"]);
    expect(
      (await buildShellLoaderSeed(got!.entry.snapshot!))?.get("bake"),
    ).toMatchObject({ container: { a: 1 } });
  });
});

describe("snapshot pruning helpers", () => {
  const DOC: ShellSnapshotRecord = {
    family: "segment",
    key: "doc:host/p",
    value: {
      segments: [{ id: "R0" }],
      handles: "",
      expiresAt: 0,
    } as unknown as CachedEntryData,
  };
  const LOADER: ShellSnapshotRecord = {
    family: "loader",
    key: "M0L0D0.bake",
    value: { value: "{}", holes: 0, runs: 0 },
  };
  const EXPLICIT: ShellSnapshotRecord = {
    ...DOC,
    key: "explicit:consumer-key",
  };
  const SNAPSHOT = [DOC, EXPLICIT, LOADER];

  it("a document entry keeps the doc record and the loader pins", () => {
    const { kept, pruned } = pruneShellSnapshot(SNAPSHOT, false, "doc:host/p");
    expect(kept).toEqual([DOC, LOADER]);
    expect(pruned).toEqual([EXPLICIT]);
    expect(countSnapshotFamilies(pruned)).toBe("segment:1");
  });

  it("a navigation-only entry keeps only the doc record", () => {
    const { kept, pruned } = pruneShellSnapshot(SNAPSHOT, true, "doc:host/p");
    expect(kept).toEqual([DOC]);
    expect(countSnapshotFamilies(pruned)).toBe("segment:1/loader:1");
  });

  it("an entry without a doc record keeps its loader pins alone", () => {
    const { kept } = pruneShellSnapshot(SNAPSHOT, false, undefined);
    expect(kept).toEqual([LOADER]);
  });

  it("hasDocRecord requires the named segment record with at least one segment", () => {
    expect(hasDocRecord(SNAPSHOT, "doc:host/p")).toBe(true);
    expect(hasDocRecord(SNAPSHOT, undefined)).toBe(false);
    expect(hasDocRecord(SNAPSHOT, "doc:host/other")).toBe(false);
    expect(hasDocRecord(undefined, "doc:host/p")).toBe(false);
    expect(
      hasDocRecord(
        [{ ...DOC, value: { ...(DOC.value as object), segments: [] } as any }],
        "doc:host/p",
      ),
    ).toBe(false);
  });
});
