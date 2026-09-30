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
import {
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
} from "../../server/context.js";

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

// The capture data snapshot: RecordingShellStore records the "use cache" item
// reads and writes the CAPTURE render performed, and the doc record;
// SeededShellStore replays them AS FRESH on a HIT so the fresh hydration
// payload matches the frozen prelude while everything not recorded stays live.
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
  it("records item read-HITS; segment and response reads pass through unrecorded", async () => {
    const inner = new MemorySegmentCacheStore();
    await inner.set("seg1", segData("s"), 60);
    await inner.setItem("item1", "ITEM-VALUE", {
      ttl: 60,
      handles: "H",
      tags: ["it"],
    });
    await inner.putResponse(
      "res1",
      new Response("BODY", { status: 201, headers: { "x-a": "1" } }),
      60,
    );

    const rec = new RecordingShellStore(inner);
    // Every read passes through; only the item hit is recorded.
    expect(await rec.get("seg1")).not.toBeNull();
    expect(await rec.getItem("item1")).not.toBeNull();
    expect(await rec.getResponse("res1")).not.toBeNull();
    // A read that MISSES records nothing.
    expect(await rec.getItem("absent")).toBeNull();

    const snapshot = rec.drainSnapshot()!;
    expect(snapshot).toHaveLength(1);
    const item = snapshot[0]!;
    expect(item.key).toBe("item1");
    expect(item.family).toBe("item");
    expect(item.value).toMatchObject({
      value: "ITEM-VALUE",
      handles: "H",
      tags: ["it"],
    });
  });

  it("records item WRITES — the value a MISS baked; segment and response writes pass through unrecorded", async () => {
    const inner = new MemorySegmentCacheStore();
    const rec = new RecordingShellStore(inner);

    await rec.set("seg1", segData("s"), 60);
    await rec.setItem("item1", "WRITTEN", { ttl: 60 });
    await rec.putResponse("res1", new Response("R", { status: 200 }), 60);

    const snapshot = rec.drainSnapshot()!;
    expect(snapshot.map((r) => r.family)).toEqual(["item"]);
    // Writes delegated through to the underlying store.
    expect(await inner.getItem("item1")).not.toBeNull();
    expect(hit(await inner.get("seg1"))).not.toBeNull();
    expect(await inner.getResponse("res1")).not.toBeNull();
  });

  it("last-write-wins: a write after a read-hit overwrites the recorded value", async () => {
    const inner = new MemorySegmentCacheStore();
    await inner.setItem("item1", "OLD", { ttl: 60 });
    const rec = new RecordingShellStore(inner);

    await rec.getItem("item1"); // records OLD
    await rec.setItem("item1", "NEW", { ttl: 60 }); // overwrites -> NEW

    const snapshot = rec.drainSnapshot()!;
    const item = snapshot.find((r) => r.key === "item1")!;
    expect((item.value as any).value).toBe("NEW");
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

    // Simulate a deferred cache write (waitUntil): the setItem runs on a later
    // microtask, exactly how cache-runtime schedules it.
    let resolved = false;
    rec.trackWrite(
      (async () => {
        await new Promise((r) => setTimeout(r, 10));
        await rec.setItem("deferred", "LATE", { ttl: 60 });
        resolved = true;
      })(),
    );

    // Before settling, the record may not exist yet.
    await expect(rec.settleWrites(1000)).resolves.toBe(true);
    expect(resolved).toBe(true);
    const snapshot = rec.drainSnapshot()!;
    expect(snapshot.find((r) => r.key === "deferred")).toBeTruthy();
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

  it("getRecord reads one recorded value by family and key", async () => {
    const rec = new RecordingShellStore(new MemorySegmentCacheStore());
    await rec.setItem("k", "V", { ttl: 60 });
    expect(rec.getRecord("item", "k")).toMatchObject({ value: "V" });
    expect(rec.getRecord("segment", "k")).toBeUndefined();
  });

  it("delegates defaults/keyGenerator to the underlying store", () => {
    const inner = new MemorySegmentCacheStore({ defaults: { ttl: 42 } });
    const rec = new RecordingShellStore(inner);
    expect(rec.defaults).toEqual({ ttl: 42 });
  });

  it("attributes item accesses made inside a loader scope (hits, misses, writes)", async () => {
    const inner = new MemorySegmentCacheStore();
    await inner.setItem("item-hit", "V", { ttl: 60 });
    const rec = new RecordingShellStore(inner);

    await runInsideLoaderScope(async () => {
      await rec.getItem("item-hit");
      await rec.getItem("item-miss");
      await rec.setItem("item-write", "W", { ttl: 60 });
    });
    // A loader body invoked outside a DSL loader scope counts too.
    await runInsideLoaderBodyScope(() => rec.getItem("item-body"));
    // Handler code does not.
    await rec.getItem("item-handler");
    await rec.setItem("item-handler-write", "H", { ttl: 60 });

    expect([...rec.loaderKeys].map((k) => k.replace("\u0000", " "))).toEqual([
      "item item-hit",
      "item item-miss",
      "item item-write",
      "item item-body",
    ]);
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
        family: "item",
        key: "item1",
        value: { value: "PINNED-ITEM", handles: "PH", tags: ["pt"] },
      },
    ];
  }

  it("serves snapshot values AS FRESH (shouldRevalidate: false) without touching the real store: items by default, segments in segmentsOnly mode", async () => {
    // Pin the clock: snapshotOf() -> segData() embeds `Date.now() + 60_000` as
    // expiresAt, and this test builds the seed and the expected value from two
    // SEPARATE snapshotOf() calls. On real timers a millisecond tick between them
    // makes the deep-equal below flake by 1ms (seen on CI). Same pattern as
    // src/cache/__tests__/shell-cache.test.ts.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const inner = new MemorySegmentCacheStore();
      // The real store is EMPTY / different — the seed must win and not fall through.
      const getItemSpy = vi.spyOn(inner, "getItem");
      const getSpy = vi.spyOn(inner, "get");
      const segments = new SeededShellStore(inner, snapshotOf(), {
        segmentsOnly: true,
      });

      const seg = hit(await segments.get("seg1"));
      expect(seg).toEqual({
        data: (snapshotOf()[0] as any).value,
        shouldRevalidate: false,
      });
      expect(getSpy).not.toHaveBeenCalled(); // pinned key never hits the real store

      const seeded = new SeededShellStore(inner, snapshotOf());
      const item = await seeded.getItem("item1");
      expect(item).toMatchObject({
        value: "PINNED-ITEM",
        handles: "PH",
        tags: ["pt"],
        shouldRevalidate: false, // MUST NOT kick SWR revalidation for a pinned key
      });
      expect(getItemSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls through to the real store for non-pinned keys", async () => {
    const inner = new MemorySegmentCacheStore();
    await inner.setItem("live", "LIVE-VALUE", { ttl: 60 });
    const seeded = new SeededShellStore(inner, snapshotOf());

    const item = await seeded.getItem("live");
    expect(item!.value).toBe("LIVE-VALUE");
    expect(hit(await seeded.get("live-seg"))).toBeNull();
  });

  it("can seed only segments so navigation loaders keep item and response reads live", async () => {
    const inner = new MemorySegmentCacheStore();
    await inner.setItem("item1", "LIVE-ITEM", { ttl: 60 });
    await inner.putResponse("res1", new Response("LIVE-RESPONSE"), 60);
    const seeded = new SeededShellStore(inner, snapshotOf(), {
      segmentsOnly: true,
    });

    expect(hit(await seeded.get("seg1"))?.data.tags).toEqual(["pinned"]);
    expect((await seeded.getItem("item1"))?.value).toBe("LIVE-ITEM");
    expect(await (await seeded.getResponse("res1"))?.response.text()).toBe(
      "LIVE-RESPONSE",
    );
  });

  it("isolates all segment reads and mutations in segmentsOnly mode", async () => {
    const inner = new MemorySegmentCacheStore();
    await inner.set("seg1", segData("original"), 60);
    await inner.set("unseeded", segData("inner"), 60);
    const seeded = new SeededShellStore(inner, snapshotOf(), {
      segmentsOnly: true,
    });

    expect(await seeded.delete("seg1")).toBe(true);
    expect(hit(await seeded.get("seg1"))).toBeNull();
    expect(hit(await seeded.get("unseeded"))).toBeNull();

    await seeded.set("unseeded", segData("fresh"), 60);

    expect(hit(await seeded.get("unseeded"))?.data.tags).toEqual(["fresh"]);
    expect(hit(await inner.get("seg1"))?.data.tags).toEqual(["original"]);
    expect(hit(await inner.get("unseeded"))?.data.tags).toEqual(["inner"]);
  });

  it("passes ALL writes through to the real store unchanged (a live hole may write)", async () => {
    const inner = new MemorySegmentCacheStore();
    const setItemSpy = vi.spyOn(inner, "setItem");
    const seeded = new SeededShellStore(inner, snapshotOf());

    await seeded.setItem("hole-write", "FROM-HOLE", { ttl: 60 });
    expect(setItemSpy).toHaveBeenCalledWith("hole-write", "FROM-HOLE", {
      ttl: 60,
    });
    expect(await inner.getItem("hole-write")).not.toBeNull();
  });

  it("getShell/putShell always pass through", async () => {
    const inner = new MemorySegmentCacheStore();
    const seeded = new SeededShellStore(inner, snapshotOf());
    await seeded.putShell(
      "sk",
      {
        prelude: "p",
        postponed: null,
        reactVersion: "1",
        buildVersion: "b",
        snapshot: [],
        createdAt: Date.now(),
      },
      300,
    );
    expect(await seeded.getShell("sk")).not.toBeNull();
  });
});

// A capture and a HIT tail run on these wrappers as the request's store; the
// writes they pass through gate on the inner store's markers (#977).
describe("the shell store wrappers forward isTagsInvalidatedSince", () => {
  it.each([
    [
      "RecordingShellStore",
      (inner: SegmentCacheStore) => new RecordingShellStore(inner),
    ],
    [
      "SeededShellStore",
      (inner: SegmentCacheStore) => new SeededShellStore(inner, []),
    ],
  ] as const)(
    "%s: to the inner store, and is absent without one",
    async (_label, wrap) => {
      const isTagsInvalidatedSince = vi.fn(async () => true);
      const inner = { isTagsInvalidatedSince } as unknown as SegmentCacheStore;

      expect(
        await wrap(inner).isTagsInvalidatedSince?.(["t"], 5, {
          failClosed: true,
        }),
      ).toBe(true);
      expect(isTagsInvalidatedSince).toHaveBeenCalledWith(["t"], 5, {
        failClosed: true,
      });
      expect(
        wrap({} as SegmentCacheStore).isTagsInvalidatedSince,
      ).toBeUndefined();
    },
  );
});

describe("buildShellLoaderSeed", () => {
  it("maps the stored hole and runs bits onto seed entries", async () => {
    const snapshot: ShellSnapshotRecord[] = [
      {
        family: "loader",
        key: "K-full",
        value: { value: JSON.stringify({ a: 1 }), holes: 0, runs: 0 },
      },
      {
        family: "loader",
        key: "K-holey",
        value: { value: JSON.stringify({ a: 1 }), holes: 1, runs: 0 },
      },
      {
        family: "loader",
        key: "K-runs",
        value: { value: JSON.stringify({ a: 1 }), holes: 0, runs: 1 },
      },
    ];

    const seed = await buildShellLoaderSeed(snapshot);
    expect(seed?.get("K-full")).toEqual({
      container: { a: 1 },
      holes: false,
      runs: false,
    });
    expect(seed?.get("K-holey")?.holes).toBe(true);
    // A capture that saw an unrecordable loader push asks the HIT to run it.
    expect(seed?.get("K-runs")).toMatchObject({ holes: false, runs: true });
  });

  it("a record stored before the bits existed reads as hole-carrying and as runs (the body supplies what the pin lacks)", async () => {
    // A v0.17 entry: its snapshot lacks the loader-owned pushes, so serving it
    // pin-only would drop them.
    const legacy = {
      family: "loader",
      key: "K-legacy",
      value: { value: JSON.stringify({ a: 1 }) },
    } as unknown as ShellSnapshotRecord;
    const preRuns = {
      family: "loader",
      key: "K-pre-runs",
      value: { value: JSON.stringify({ a: 1 }), holes: 0 },
    } as unknown as ShellSnapshotRecord;

    const seed = await buildShellLoaderSeed([legacy, preRuns]);
    expect(seed?.get("K-legacy")).toMatchObject({ holes: true, runs: true });
    expect(seed?.get("K-pre-runs")).toMatchObject({
      holes: false,
      runs: true,
    });
  });

  it("skips a record that fails to decode (that loader drifts, the pre-snapshot behavior)", async () => {
    const snapshot: ShellSnapshotRecord[] = [
      {
        family: "loader",
        key: "K-bad",
        value: { value: "%broken%", holes: 0, runs: 0 },
      },
      {
        family: "loader",
        key: "K-good",
        value: { value: JSON.stringify(7), holes: 0, runs: 0 },
      },
    ];

    const seed = await buildShellLoaderSeed(snapshot);
    expect(seed?.has("K-bad")).toBe(false);
    expect(seed?.get("K-good")).toEqual({
      container: 7,
      holes: false,
      runs: false,
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
  it("a full snapshot round-trips through MemorySegmentCacheStore putShell/getShell", async () => {
    const store = new MemorySegmentCacheStore();
    const inner = new MemorySegmentCacheStore();
    await inner.setItem("it", "V", { ttl: 60, tags: ["t"] });
    const rec = new RecordingShellStore(inner);
    await rec.getItem("it");
    const snapshot = rec.drainSnapshot()!;

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
    expect((await seeded.getItem("it"))!.value).toBe("V");
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
  const HANDLER_ITEM: ShellSnapshotRecord = {
    family: "item",
    key: "use-cache:handler",
    value: { value: "h" },
  };
  const LOADER_ITEM: ShellSnapshotRecord = {
    family: "item",
    key: "use-cache:loader",
    value: { value: "l" },
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
  const SNAPSHOT = [DOC, EXPLICIT, HANDLER_ITEM, LOADER_ITEM, LOADER];
  const LOADER_KEYS = new Set(["item\u0000use-cache:loader"]);

  it('"loaders" keeps the doc record, loader containers and loader-touched records', () => {
    const { kept, pruned } = pruneShellSnapshot(
      SNAPSHOT,
      "loaders",
      LOADER_KEYS,
      "doc:host/p",
    );
    expect(kept).toEqual([DOC, LOADER_ITEM, LOADER]);
    expect(pruned).toEqual([EXPLICIT, HANDLER_ITEM]);
    expect(countSnapshotFamilies(pruned)).toBe("segment:1/item:1");
  });

  it('"segments" keeps only the doc record', () => {
    const { kept, pruned } = pruneShellSnapshot(
      SNAPSHOT,
      "segments",
      LOADER_KEYS,
      "doc:host/p",
    );
    expect(kept).toEqual([DOC]);
    expect(countSnapshotFamilies(pruned)).toBe("segment:1/item:2/loader:1");
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
