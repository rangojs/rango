/**
 * MemorySegmentCacheStore refuses a write whose execution started before an
 * invalidation of one of its tags (#1068). It deletes tagged entries on
 * invalidation and checks no marker on read, so a late write would repopulate
 * and outlive the invalidation until its ttl.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { markResponseStart } from "../tag-invalidation.js";
import type { CachedEntryData } from "../types.js";

const T0 = 1_700_000_000_000;

function segment(tags: string[], taggedAt?: number): CachedEntryData {
  return {
    segments: [],
    handles: "",
    expiresAt: T0 + 600_000,
    tags,
    ...(taggedAt === undefined ? {} : { taggedAt }),
  };
}

interface Family {
  name: string;
  write(
    store: MemorySegmentCacheStore,
    tags: string[],
    startedAt?: number,
  ): Promise<void>;
  read(store: MemorySegmentCacheStore): Promise<unknown>;
}

const FAMILIES: Family[] = [
  {
    name: "set",
    write: (store, tags, at) => store.set("k", segment(tags, at), 60),
    read: (store) => store.get("k"),
  },
  {
    name: "setItem",
    write: (store, tags, at) =>
      store.setItem("k", "v", { ttl: 60, tags, startedAt: at }),
    read: (store) => store.getItem("k"),
  },
  {
    name: "putResponse",
    write: (store, tags, at) => {
      const response = new Response("v");
      if (at !== undefined) markResponseStart(response, { seq: 0, at });
      return store.putResponse("k", response, 60, undefined, tags);
    },
    read: (store) => store.getResponse("k"),
  },
];

describe.each(FAMILIES)(
  "MemorySegmentCacheStore $name: a write started before an invalidation (#1068)",
  ({ write, read }) => {
    let store: MemorySegmentCacheStore;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(T0));
      MemorySegmentCacheStore.resetGlobalCache();
      store = new MemorySegmentCacheStore();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** The execution starts at T0, the invalidation lands at T0+10, the write at T0+20. */
    async function invalidateWhileRunning() {
      vi.advanceTimersByTime(10);
      await store.invalidateTags(["x"]);
      vi.advanceTimersByTime(10);
    }

    it.each([
      ["started before the invalidation: refused", T0, false],
      ["started after the invalidation: stored", T0 + 15, true],
      ["no known start: stored", undefined, true],
    ])("%s", async (_label, startedAt, stored) => {
      await invalidateWhileRunning();
      await write(store, ["x"], startedAt);
      expect((await read(store)) !== null).toBe(stored);
    });

    it("an invalidation in the start's own millisecond does not refuse the write", async () => {
      await store.invalidateTags(["x"]);
      await write(store, ["x"], T0);
      expect(await read(store)).not.toBeNull();
    });

    it("an invalidation of another tag does not refuse the write", async () => {
      vi.advanceTimersByTime(10);
      await store.invalidateTags(["other"]);
      await write(store, ["x"], T0);
      expect(await read(store)).not.toBeNull();
    });
  },
);
