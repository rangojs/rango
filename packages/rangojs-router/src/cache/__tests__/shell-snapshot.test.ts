import { describe, it, expect, vi } from "vitest";
import {
  RecordingShellStore,
  SeededShellStore,
  getRecordingStore,
} from "../shell-snapshot.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import type {
  SegmentCacheStore,
  CachedEntryData,
  ShellSnapshotRecord,
} from "../types.js";

// The capture data snapshot: RecordingShellStore records the cache-store reads
// and writes the CAPTURE render performed; SeededShellStore replays them AS
// FRESH on a HIT so the fresh hydration payload matches the frozen prelude while
// everything not recorded stays live. See cache/shell-snapshot.ts and
// docs/design/ppr-shell-resume.md.

function segData(tag: string): CachedEntryData {
  return {
    segments: [],
    handles: "",
    expiresAt: Date.now() + 60_000,
    tags: [tag],
  };
}

describe("RecordingShellStore", () => {
  it("records read-HITS for the item, segment, and response families (last-write-wins)", async () => {
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
    // Reads that HIT are recorded.
    expect(await rec.get("seg1")).not.toBeNull();
    expect(await rec.getItem("item1")).not.toBeNull();
    expect(await rec.getResponse("res1")).not.toBeNull();
    // A read that MISSES records nothing.
    expect(await rec.get("absent")).toBeNull();

    const snapshot = rec.drainSnapshot()!;
    const byKey = new Map(snapshot.map((r) => [r.key, r]));
    expect(byKey.size).toBe(3);

    expect(byKey.get("seg1")!.family).toBe("segment");
    expect((byKey.get("seg1")!.value as CachedEntryData).tags).toEqual(["s"]);

    const item = byKey.get("item1")!;
    expect(item.family).toBe("item");
    expect(item.value).toMatchObject({
      value: "ITEM-VALUE",
      handles: "H",
      tags: ["it"],
    });

    const resp = byKey.get("res1")!;
    expect(resp.family).toBe("response");
    expect((resp.value as any).status).toBe(201);
  });

  it("records WRITES (setItem/set/putResponse) — the value a MISS baked", async () => {
    const inner = new MemorySegmentCacheStore();
    const rec = new RecordingShellStore(inner);

    await rec.set("seg1", segData("s"), 60);
    await rec.setItem("item1", "WRITTEN", { ttl: 60 });
    await rec.putResponse("res1", new Response("R", { status: 200 }), 60);

    const snapshot = rec.drainSnapshot()!;
    expect(snapshot.map((r) => r.family).sort()).toEqual([
      "item",
      "response",
      "segment",
    ]);
    // Writes delegated through to the underlying store.
    expect(await inner.getItem("item1")).not.toBeNull();
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
    await rec.settleWrites(1000);
    expect(resolved).toBe(true);
    const snapshot = rec.drainSnapshot()!;
    expect(snapshot.find((r) => r.key === "deferred")).toBeTruthy();
  });

  it("settleWrites is bounded: a hung write does not stall past the timeout", async () => {
    const inner = new MemorySegmentCacheStore();
    const rec = new RecordingShellStore(inner);
    rec.trackWrite(new Promise(() => {})); // never settles
    const start = Date.now();
    await rec.settleWrites(30);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("delegates defaults/keyGenerator to the underlying store", () => {
    const inner = new MemorySegmentCacheStore({ defaults: { ttl: 42 } });
    const rec = new RecordingShellStore(inner);
    expect(rec.defaults).toEqual({ ttl: 42 });
  });

  it("getRecordingStore duck-types a RecordingShellStore, ignores others", () => {
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
      {
        family: "response",
        key: "res1",
        value: { status: 203, headers: [["x-h", "v"]], body: btoa("PINNED") },
      },
    ];
  }

  it("serves snapshot values AS FRESH (shouldRevalidate: false) without touching the real store", async () => {
    const inner = new MemorySegmentCacheStore();
    // The real store is EMPTY / different — the seed must win and not fall through.
    const getItemSpy = vi.spyOn(inner, "getItem");
    const getSpy = vi.spyOn(inner, "get");
    const seeded = new SeededShellStore(inner, snapshotOf());

    const seg = await seeded.get("seg1");
    expect(seg).toEqual({
      data: (snapshotOf()[0] as any).value,
      shouldRevalidate: false,
    });
    expect(getSpy).not.toHaveBeenCalled(); // pinned key never hits the real store

    const item = await seeded.getItem("item1");
    expect(item).toMatchObject({
      value: "PINNED-ITEM",
      handles: "PH",
      tags: ["pt"],
      shouldRevalidate: false, // MUST NOT kick SWR revalidation for a pinned key
    });
    expect(getItemSpy).not.toHaveBeenCalled();

    const resp = await seeded.getResponse("res1");
    expect(resp!.shouldRevalidate).toBe(false);
    expect(resp!.response.status).toBe(203);
    expect(resp!.response.headers.get("x-h")).toBe("v");
    expect(await resp!.response.text()).toBe("PINNED");
  });

  it("falls through to the real store for non-pinned keys", async () => {
    const inner = new MemorySegmentCacheStore();
    await inner.setItem("live", "LIVE-VALUE", { ttl: 60 });
    const seeded = new SeededShellStore(inner, snapshotOf());

    const item = await seeded.getItem("live");
    expect(item!.value).toBe("LIVE-VALUE");
    expect(await seeded.get("live-seg")).toBeNull();
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
        createdAt: Date.now(),
      },
      300,
    );
    expect(await seeded.getShell("sk")).not.toBeNull();
  });
});

describe("snapshot round-trip", () => {
  it("the response family round-trips body/headers/status through record -> JSON -> seed", async () => {
    const inner = new MemorySegmentCacheStore();
    await inner.putResponse(
      "r",
      new Response("HELLO-BODY", {
        status: 202,
        headers: { "content-type": "text/plain", "x-custom": "yes" },
      }),
      60,
    );
    const rec = new RecordingShellStore(inner);
    await rec.getResponse("r");
    const snapshot = rec.drainSnapshot()!;

    // The wire form must survive a JSON store round-trip.
    const roundTripped: ShellSnapshotRecord[] = JSON.parse(
      JSON.stringify(snapshot),
    );

    const seeded = new SeededShellStore(
      new MemorySegmentCacheStore(),
      roundTripped,
    );
    const served = await seeded.getResponse("r");
    expect(served!.response.status).toBe(202);
    expect(served!.response.headers.get("content-type")).toBe("text/plain");
    expect(served!.response.headers.get("x-custom")).toBe("yes");
    expect(await served!.response.text()).toBe("HELLO-BODY");
  });

  it("a full snapshot round-trips through MemorySegmentCacheStore putShell/getShell", async () => {
    const store = new MemorySegmentCacheStore();
    const inner = new MemorySegmentCacheStore();
    await inner.setItem("it", "V", { ttl: 60, tags: ["t"] });
    const rec = new RecordingShellStore(inner);
    await rec.getItem("it");
    const snapshot = rec.drainSnapshot();

    await store.putShell(
      "/p:shell",
      {
        prelude: btoa("<html></html>"),
        postponed: null,
        reactVersion: "1",
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
