/**
 * A data entry is stamped with the start of the execution that produced it,
 * not with the write time (#1068): an invalidation that lands while the
 * execution runs writes a marker the entry's `taggedAt` is not newer than, so
 * the read-side marker check rejects it. putShell already stamped the
 * capture's start; set, setItem and putResponse did not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CFCacheStore } from "../cf-cache-store.js";
import type { CachedEntryData, CacheGetResult } from "../../types.js";
import { CACHE_READ_ERROR } from "../../types.js";
import { markResponseStart } from "../../tag-invalidation.js";

function hit(r: CacheGetResult | typeof CACHE_READ_ERROR | null) {
  return r === CACHE_READ_ERROR ? null : r;
}

class MockCache {
  private store = new Map<string, Response>();
  async match(request: Request) {
    return this.store.get(request.url)?.clone();
  }
  async put(request: Request, response: Response) {
    this.store.set(request.url, response.clone());
  }
  async delete(request: Request) {
    return this.store.delete(request.url);
  }
  clear() {
    this.store.clear();
  }
}
const mockCache = new MockCache();
(globalThis as any).caches = {
  default: mockCache,
  open: async () => mockCache,
};

class MockKV {
  store = new Map<string, string>();
  async get(key: string, options?: { type?: string }) {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return options?.type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

function createCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(Promise.resolve(p));
    },
    passThroughOnException: () => {},
    flush: async () => {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

const T0 = 1_700_000_000_000;

function segmentData(tags: string[], taggedAt?: number): CachedEntryData {
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
  write(store: CFCacheStore, tags: string[], startedAt?: number): Promise<void>;
  read(store: CFCacheStore): Promise<unknown>;
}

const FAMILIES: Family[] = [
  {
    name: "set",
    write: (store, tags, at) => store.set("k", segmentData(tags, at), 300),
    read: async (store) => hit(await store.get("k")),
  },
  {
    name: "setItem",
    write: (store, tags, at) =>
      store.setItem("k", "v", { ttl: 300, tags, startedAt: at }),
    read: (store) => store.getItem("k"),
  },
  {
    name: "putResponse",
    write: (store, tags, at) => {
      const response = new Response("v");
      if (at !== undefined) markResponseStart(response, { seq: 0, at });
      return store.putResponse("k", response, 300, undefined, tags);
    },
    read: (store) => store.getResponse("k"),
  },
];

describe.each(FAMILIES)(
  "CFCacheStore $name stamps the execution start (#1068)",
  ({ write, read }) => {
    let ctx: ReturnType<typeof createCtx>;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(T0));
      mockCache.clear();
      ctx = createCtx();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function makeStore() {
      return new CFCacheStore({
        ctx: ctx as any,
        kv: new MockKV() as any,
        baseUrl: "https://test.internal/",
        version: "v1",
      });
    }

    /** An execution starts at T0, "x" is invalidated at T0+10, the write lands at T0+20. */
    async function invalidateWhileRunning(store: CFCacheStore) {
      vi.advanceTimersByTime(10);
      await store.invalidateTags(["x"]);
      vi.advanceTimersByTime(10);
    }

    it.each([
      ["started before the invalidation: a miss", T0, false],
      ["started after the invalidation: served", T0 + 15, true],
      ["no known start (write time): served", undefined, true],
    ])("%s, in L1 and in KV", async (_label, startedAt, served) => {
      const store = makeStore();
      await invalidateWhileRunning(store);
      await write(store, ["x"], startedAt);
      await ctx.flush();
      expect((await read(store)) !== null).toBe(served);
      mockCache.clear();
      expect((await read(store)) !== null).toBe(served);
    });

    // A start in the future must stamp now (the clamp in entryStamp): left
    // as is it would be newer than the invalidation below and never rejected.
    // A start of 0 must stamp now too: a zero stamp is "no stamp" to the
    // read side, which would never reject it.
    it.each([
      ["a start in the future", T0 + 99_000],
      ["a start of 0", 0],
    ])("%s stamps the write time", async (_label, startedAt) => {
      const store = makeStore();
      await invalidateWhileRunning(store);
      await write(store, ["x"], startedAt);
      await ctx.flush();
      expect(await read(store)).not.toBeNull();

      vi.advanceTimersByTime(10);
      await store.invalidateTags(["x"]);
      expect(await read(store)).toBeNull();
    });
  },
);
