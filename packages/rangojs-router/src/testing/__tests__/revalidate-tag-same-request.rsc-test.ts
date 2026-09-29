/**
 * revalidateTag() then a read in the same request, through the public testing
 * primitives (issue #973), in the react-server Flight project: a
 * `runLoader()` body plays a server action that calls `revalidateTag()` and
 * then renders its revalidation, which reads a `"use cache"` function tagged
 * with the invalidated tag.
 *
 * revalidateTag() does not wait for the store's durable write (a KV marker
 * put, a tag purge, a Vercel expireTag). Each store double here holds that
 * write until the request is over, as a slow KV or platform call would, so
 * the read can only be fresh when the store masked the tag for the request
 * before revalidateTag() returned.
 */
import { afterEach, describe, it, expect, vi } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { runLoader } from "../index.js";
import { revalidateTag, updateTag } from "../../cache/tag-invalidation.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import {
  CFCacheStore,
  TAG_MARKER_PREFIX,
} from "../../cache/cf/cf-cache-store.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../cache/vercel/vercel-cache-store.js";
import type { SegmentCacheStore } from "../../cache/types.js";
import {
  getPrice,
  getSlowStock,
  getStock,
  getUnrelated,
  priceSource,
  runs,
} from "./fixtures/use-cache-data.js";

interface HeldStore {
  cacheStore: SegmentCacheStore;
  /** Settle the background writes started so far. */
  settle(): Promise<void>;
  /** Let the held durable invalidation write land. */
  release(): void;
}

function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  return { held, release };
}

/** An execution context double whose waitUntil tasks settle() drains. */
function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => {},
    async settle() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

function cfStore(): HeldStore {
  const entries = new Map<string, Response>();
  const edge = {
    async match(request: Request) {
      return entries.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      entries.set(request.url, response.clone());
    },
    async delete(request: Request) {
      return entries.delete(request.url);
    },
  };
  vi.stubGlobal("caches", { default: edge, open: async () => edge });
  const values = new Map<string, string>();
  const markers = gate();
  const kv = {
    async get(key: string, options?: { type?: string }) {
      const value = values.get(key);
      if (value === undefined) return null;
      return options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      if (key.includes(TAG_MARKER_PREFIX)) await markers.held;
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
  const ctx = executionContext();
  return {
    cacheStore: new CFCacheStore({ ctx: ctx as never, kv: kv as never }),
    settle: () => ctx.settle(),
    release: markers.release,
  };
}

function vercelStore(): HeldStore {
  const values = new Map<string, { value: unknown; tags: string[] }>();
  const expire = gate();
  const ctx = executionContext();
  const cache: VercelRuntimeCache = {
    async get(key) {
      const entry = values.get(key);
      return entry === undefined ? undefined : structuredClone(entry.value);
    },
    async set(key, value, options) {
      values.set(key, {
        value: structuredClone(value),
        tags: options?.tags ?? [],
      });
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag(tag) {
      await expire.held;
      const tags = Array.isArray(tag) ? tag : [tag];
      for (const [key, entry] of values) {
        if (entry.tags.some((t) => tags.includes(t))) values.delete(key);
      }
    },
  };
  return {
    cacheStore: new VercelCacheStore({ cache, waitUntil: ctx.waitUntil }),
    settle: () => ctx.settle(),
    release: expire.release,
  };
}

function memoryStore(): HeldStore {
  return {
    cacheStore: new MemorySegmentCacheStore(),
    settle: async () => {},
    release: () => {},
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("revalidateTag() then a read in the same request (#973)", () => {
  it.each([
    ["CFCacheStore with KV", cfStore],
    ["VercelCacheStore", vercelStore],
    ["MemorySegmentCacheStore", memoryStore],
  ])(
    "%s: the action's own render reads past the invalidated entry",
    async (_label, makeStore) => {
      const store = makeStore();
      const setItem = vi.spyOn(store.cacheStore, "setItem");
      const options = {
        cacheStore: store.cacheStore,
        cacheProfiles: { default: { ttl: 60 } },
      };
      runs.getStock = 0;

      expect(await runLoader(async () => getStock("wine"), options)).toBe(
        "wine #1",
      );
      // The write is a background task: settle it before the next request.
      await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(1));
      await setItem.mock.results[0]!.value;
      await store.settle();
      // A later request reads the entry.
      expect(await runLoader(async () => getStock("wine"), options)).toBe(
        "wine #1",
      );

      const afterAction = await runLoader(async () => {
        revalidateTag("stock");
        return getStock("wine");
      }, options);

      expect(afterAction).toBe("wine #2");
      store.release();
    },
  );

  // The first call returns before its result is serialized for the store
  // write, so it stays in the isolate's in-flight executions
  // (cache-runtime.ts inFlightExecutions) for a few ticks. Started before the
  // invalidation, it must be neither joined nor written after it.
  // - revalidateTag: the second call finds it still in flight, so this case
  //   pins the join check; the write assertion pins the write skip.
  // - await updateTag: the first call's write settles during the await, so
  //   the second call finds no in-flight entry; this case pins the write
  //   skip (written, the second call would read "beer #1").
  it.each(["revalidateTag", "updateTag"] as const)(
    "%s: a call made earlier in the request, its write still pending, is neither reused nor written after the invalidation",
    async (verb) => {
      runs.getStock = 0;
      const cacheStore = new MemorySegmentCacheStore();
      const setItem = vi.spyOn(cacheStore, "setItem");
      const values = await runLoader(
        async () => {
          const before = await getStock("beer");
          if (verb === "updateTag") await updateTag("stock");
          else revalidateTag("stock");
          const after = await getStock("beer");
          return [before, after];
        },
        { cacheStore, cacheProfiles: { default: { ttl: 60 } } },
      );

      expect(values).toEqual(["beer #1", "beer #2"]);
      await pause(50);
      const written = setItem.mock.calls.map(([, value]) => String(value));
      expect(written.some((value) => value.includes("beer #1"))).toBe(false);
    },
  );

  // A stale hit serves the stale value and refreshes the entry in the
  // background. A refresh that started before the invalidation read the
  // data from before it, so its write must not land after it.
  it.each(["revalidateTag", "updateTag"] as const)(
    "%s: a stale entry's refresh started before the call does not write its value",
    async (verb) => {
      priceSource.value = "old";
      const cacheStore = new MemorySegmentCacheStore();
      const setItem = vi.spyOn(cacheStore, "setItem");
      const options = {
        cacheStore,
        cacheProfiles: { default: { ttl: 0, swr: 60 } },
      };
      expect(await runLoader(async () => getPrice(), options)).toBe("old");
      await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(1));
      await pause(5);

      const values = await runLoader(async () => {
        // Stale: served, and the refresh starts, reading "old".
        const stale = await getPrice();
        priceSource.value = "new";
        if (verb === "updateTag") await updateTag("price");
        else revalidateTag("price");
        await pause(60);
        return [stale, await getPrice()];
      }, options);

      expect(values).toEqual(["old", "new"]);
      await pause(60);
      expect(await runLoader(async () => getPrice(), options)).toBe("new");
    },
  );

  it("concurrent calls after the call share one fresh execution", async () => {
    runs.getSlowStock = 0;
    await runLoader(
      async () => {
        const leader = getSlowStock("rum");
        await pause(5);
        revalidateTag("stock");
        const after = await Promise.all(
          Array.from({ length: 5 }, () => getSlowStock("rum")),
        );
        expect(await leader).toBe("rum #1");
        expect(new Set(after)).toEqual(new Set(["rum #2"]));
      },
      {
        cacheStore: new MemorySegmentCacheStore(),
        cacheProfiles: { default: { ttl: 60 } },
      },
    );

    expect(runs.getSlowStock).toBe(2);
  });

  it("an execution started before the call, with other tags, still fills the store", async () => {
    runs.getUnrelated = 0;
    const options = {
      cacheStore: new MemorySegmentCacheStore(),
      cacheProfiles: { default: { ttl: 60 } },
    };
    await runLoader(async () => {
      const pending = getUnrelated("gin");
      await pause(5);
      revalidateTag("stock");
      return pending;
    }, options);
    await pause(60);

    expect(await runLoader(async () => getUnrelated("gin"), options)).toBe(
      "gin #1",
    );
  });

  // Workers advance Date.now() only on I/O, so an execution that starts
  // right after the call usually shares its millisecond.
  it("an execution started right after the call, in the same millisecond, fills the store", async () => {
    runs.getStock = 0;
    const options = {
      cacheStore: new MemorySegmentCacheStore(),
      cacheProfiles: { default: { ttl: 60 } },
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await runLoader(async () => {
        revalidateTag("stock");
        return getStock("ale");
      }, options);
    } finally {
      vi.useRealTimers();
    }
    await pause(20);

    expect(await runLoader(async () => getStock("ale"), options)).toBe(
      "ale #1",
    );
  });
});

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
