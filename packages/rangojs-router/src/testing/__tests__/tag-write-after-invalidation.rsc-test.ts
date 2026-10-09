/**
 * An execution that started before another request invalidated one of its
 * tags, and finished after (issue #977), through the public testing
 * primitives in the react-server Flight project. Request A starts a
 * `"use cache"` call or a loader's own cache() on "old" data and is held;
 * request B changes the data and calls updateTag(); A is released. A still
 * returns what it read, but its write would outlive the invalidation (every
 * built-in store stamps an entry at write time), so it is skipped and the
 * next read runs the body on the new data.
 *
 * "Another isolate": a second store instance over the same backing
 * (KV + Cache API, the Vercel runtime cache) invalidates with
 * invalidateTags(), which this isolate's invalidation order never sees, so
 * only the store's own markers can reject the write.
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

import { dispatch, runInRequestContext, runLoader } from "../index.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { updateTag } from "../../cache/tag-invalidation.js";
import { cacheTag } from "../../cache/cache-tag.js";
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
  getHeldShelf,
  getHotItem,
  getVersionedInner,
  getPrice,
  priceSource,
  runs,
  shelfGate,
  shelfSource,
} from "./fixtures/use-cache-data.js";

interface StoreUnderTest {
  cacheStore: SegmentCacheStore;
  /** Another isolate's store over the same backing (CF, Vercel). */
  otherIsolate?: SegmentCacheStore;
  /** Settle the background writes started so far. */
  settle(): Promise<void>;
  /** The store's backing reads so far (CF: KV keys; Vercel: cache keys). */
  reads?: string[];
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

function memoryStore(): StoreUnderTest {
  return { cacheStore: new MemorySegmentCacheStore(), settle: async () => {} };
}

function cfStore(
  options: {
    /** Each tag-marker KV read resolves this late, with the value it read. */
    markerReadDelayMs?: number;
  } = {},
): StoreUnderTest {
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
  const reads: string[] = [];
  const kv = {
    async get(key: string, getOptions?: { type?: string }) {
      reads.push(key);
      const value = values.get(key);
      if (options.markerReadDelayMs && key.includes(TAG_MARKER_PREFIX)) {
        await pause(options.markerReadDelayMs);
      }
      if (value === undefined) return null;
      return getOptions?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
  const ctx = executionContext();
  const other = executionContext();
  return {
    cacheStore: new CFCacheStore({ ctx: ctx as never, kv: kv as never }),
    otherIsolate: new CFCacheStore({ ctx: other as never, kv: kv as never }),
    settle: async () => {
      await ctx.settle();
      await other.settle();
    },
    reads,
  };
}

function vercelStore(): StoreUnderTest {
  const values = new Map<string, { value: unknown; tags: string[] }>();
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
      const tags = Array.isArray(tag) ? tag : [tag];
      for (const [key, entry] of values) {
        if (entry.tags.some((t) => tags.includes(t))) values.delete(key);
      }
    },
  };
  return {
    cacheStore: new VercelCacheStore({ cache, waitUntil: ctx.waitUntil }),
    otherIsolate: new VercelCacheStore({ cache, waitUntil: ctx.waitUntil }),
    settle: () => ctx.settle(),
  };
}

const STORES = [
  ["MemorySegmentCacheStore", memoryStore],
  ["CFCacheStore with KV", cfStore],
  ["VercelCacheStore", vercelStore],
] as const;

const OTHER_ISOLATE_STORES = [
  ["CFCacheStore with KV", cfStore],
  ["VercelCacheStore", vercelStore],
] as const;

/** A held gate: `held` settles once `release()` is called. */
function hold(): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  return { held, release };
}

/** How each case invalidates while request A is held. */
type Invalidate = (store: StoreUnderTest, tag: string) => Promise<void>;

/** Request B, in this isolate: updateTag() in its own request. */
const inAnotherRequest: Invalidate = async (store, tag) => {
  await runInRequestContext(() => updateTag(tag), {
    cacheStore: store.cacheStore,
  });
};

/** Another isolate's invalidation, which only the store's markers carry. */
const inAnotherIsolate: Invalidate = async (store, tag) => {
  // A later millisecond than A's start: the store's clock is all it has.
  await pause(2);
  await store.otherIsolate!.invalidateTags!([tag]);
};

afterEach(() => {
  shelfGate.held = Promise.resolve();
  vi.unstubAllGlobals();
});

/**
 * A `"use cache"` miss: A reads "old" and is held while `invalidate` runs.
 */
async function useCacheMiss(
  store: StoreUnderTest,
  invalidate: Invalidate,
  sku: string,
): Promise<[string, string]> {
  const options = {
    cacheStore: store.cacheStore,
    cacheProfiles: { default: { ttl: 60 } },
  };
  runs.getHeldShelf = 0;
  shelfSource.value = "old";
  const gate = hold();
  shelfGate.held = gate.held;
  const first = runLoader(() => getHeldShelf(sku), options);
  await vi.waitFor(() => expect(runs.getHeldShelf).toBe(1));

  shelfSource.value = "new";
  await invalidate(store, "held-shelf");
  // A finishes in a later millisecond than the invalidation, as a real
  // execution does: a store that stamps the write time then accepts it.
  await pause(2);
  gate.release();
  const served = await first;
  await pause(20);
  await store.settle();

  return [served, await runLoader(() => getHeldShelf(sku), options)];
}

/**
 * A `"use cache"` stale hit: A serves the stale entry and its refresh reads
 * "old" and is held while `invalidate` runs.
 */
async function useCacheRefresh(
  store: StoreUnderTest,
  invalidate: Invalidate,
  sku: string,
): Promise<[string, string]> {
  const options = {
    cacheStore: store.cacheStore,
    cacheProfiles: { default: { ttl: 0, swr: 60 } },
  };
  runs.getHeldShelf = 0;
  shelfSource.value = "old";
  await runLoader(() => getHeldShelf(sku), options);
  await pause(20);
  await store.settle();

  const gate = hold();
  shelfGate.held = gate.held;
  const stale = await runLoader(() => getHeldShelf(sku), options);
  await vi.waitFor(() => expect(runs.getHeldShelf).toBe(2));

  shelfSource.value = "new";
  await invalidate(store, "held-shelf");
  // A finishes in a later millisecond than the invalidation, as a real
  // execution does: a store that stamps the write time then accepts it.
  await pause(2);
  gate.release();
  await pause(20);
  await store.settle();

  shelfGate.held = Promise.resolve();
  return [stale, await runLoader(() => getHeldShelf(sku), options)];
}

/**
 * A loader's own cache(): A's body reads "old" and is held while
 * `invalidate` runs. `swr` makes A a stale hit whose refresh is held.
 */
async function loaderCache(
  store: StoreUnderTest,
  invalidate: Invalidate,
  mode: "miss" | "refresh",
): Promise<[string, string]> {
  let source = "old";
  let gate: Promise<void> = Promise.resolve();
  let bodyRuns = 0;
  const stockLoader = async () => {
    cacheTag("held-loader");
    bodyRuns++;
    const value = source;
    await gate;
    return value;
  };
  const load = () =>
    runLoader(stockLoader, {
      cacheStore: store.cacheStore,
      cache: mode === "miss" ? { ttl: 60 } : { ttl: 0, swr: 60 },
    });

  if (mode === "refresh") {
    await load();
    await pause(20);
    await store.settle();
  }
  const held = hold();
  gate = held.held;
  const first = load();
  await vi.waitFor(() => expect(bodyRuns).toBe(mode === "miss" ? 1 : 2));

  source = "new";
  await invalidate(store, "held-loader");
  await pause(2);
  held.release();
  const served = await first;
  await pause(20);
  await store.settle();

  gate = Promise.resolve();
  return [served, await load()];
}

describe("a write that started before another request's updateTag() (#977)", () => {
  it.each(STORES)(
    '%s: a "use cache" miss does not write its value; the next read is fresh',
    async (_label, makeStore) => {
      expect(
        await useCacheMiss(makeStore(), inAnotherRequest, "a-miss"),
      ).toEqual(["a-miss:old", "a-miss:new"]);
    },
  );

  it.each(STORES)(
    '%s: a "use cache" stale refresh does not write its value; the next read is fresh',
    async (_label, makeStore) => {
      expect(
        await useCacheRefresh(makeStore(), inAnotherRequest, "a-refresh"),
      ).toEqual(["a-refresh:old", "a-refresh:new"]);
    },
  );

  it.each(STORES)(
    "%s: a loader's own cache() miss does not write its value; the next read is fresh",
    async (_label, makeStore) => {
      expect(await loaderCache(makeStore(), inAnotherRequest, "miss")).toEqual([
        "old",
        "new",
      ]);
    },
  );

  it.each(STORES)(
    "%s: a loader's own cache() stale refresh does not write its value; the next read is fresh",
    async (_label, makeStore) => {
      expect(
        await loaderCache(makeStore(), inAnotherRequest, "refresh"),
      ).toEqual(["old", "new"]);
    },
  );
});

describe("a write that started before another isolate's invalidation (#977)", () => {
  it.each(OTHER_ISOLATE_STORES)(
    '%s: a "use cache" miss does not write its value',
    async (_label, makeStore) => {
      expect(
        await useCacheMiss(makeStore(), inAnotherIsolate, "b-miss"),
      ).toEqual(["b-miss:old", "b-miss:new"]);
    },
  );

  // The stale read memoizes the tag's marker for the request; the refresh's
  // write check must read past that value.
  it.each(OTHER_ISOLATE_STORES)(
    '%s: a "use cache" stale refresh does not write its value',
    async (_label, makeStore) => {
      expect(
        await useCacheRefresh(makeStore(), inAnotherIsolate, "b-refresh"),
      ).toEqual(["b-refresh:old", "b-refresh:new"]);
    },
  );

  // The join check reads this isolate's order; the leader asks the store
  // before it hands its value to the calls waiting on it.
  it.each(OTHER_ISOLATE_STORES)(
    '%s: a "use cache" call that joins an execution started before the invalidation runs fresh',
    async (_label, makeStore) => {
      const store = makeStore();
      const options = {
        cacheStore: store.cacheStore,
        cacheProfiles: { default: { ttl: 60 } },
      };
      runs.getHeldShelf = 0;
      shelfSource.value = "old";
      const gate = hold();
      shelfGate.held = gate.held;
      const first = runLoader(() => getHeldShelf("b-join"), options);
      await vi.waitFor(() => expect(runs.getHeldShelf).toBe(1));

      shelfSource.value = "new";
      await inAnotherIsolate(store, "held-shelf");
      // Request B joins request A's in-flight execution.
      const joined = runLoader(() => getHeldShelf("b-join"), options);
      await pause(5);
      shelfGate.held = Promise.resolve();
      gate.release();

      expect(await first).toBe("b-join:old");
      expect(await joined).toBe("b-join:new");
    },
  );

  it.each(OTHER_ISOLATE_STORES)(
    "%s: a loader's own cache() miss does not write its value",
    async (_label, makeStore) => {
      expect(await loaderCache(makeStore(), inAnotherIsolate, "miss")).toEqual([
        "old",
        "new",
      ]);
    },
  );
});

/**
 * A memory store whose tag-history check answers 40 ms late with what it
 * saw when asked, as a remote marker read in flight does.
 */
class LateAnsweringMemoryStore extends MemorySegmentCacheStore {
  override async isTagsInvalidatedSince(
    tags: string[],
    sinceMs: number,
  ): Promise<boolean> {
    const answer = await super.isTagsInvalidatedSince(tags, sinceMs);
    await pause(40);
    return answer;
  }
}

// #973 read-your-own-writes through the #977 gate: an action reads a
// "use cache" miss (its write runs in waitUntil), changes the data and
// awaits updateTag() while the write's gate is waiting on the store's
// marker read, which answers with the state from before the invalidation.
describe("the write gate's store read in flight during the request's own updateTag() (#973, #977)", () => {
  it.each([
    [
      "CFCacheStore with KV, 40 ms marker reads",
      () => cfStore({ markerReadDelayMs: 40 }),
    ],
    [
      "MemorySegmentCacheStore, a late tag-history answer",
      () => ({
        cacheStore: new LateAnsweringMemoryStore(),
        settle: async () => {},
      }),
    ],
  ] as const)(
    "%s: the value read before the invalidation is not written",
    async (_label, makeStore) => {
      const store: StoreUnderTest = makeStore();
      const options = {
        cacheStore: store.cacheStore,
        cacheProfiles: { default: { ttl: 60 } },
      };
      priceSource.value = "old";

      const inAction = await runLoader(async () => {
        const before = await getPrice();
        // db.update(): the write's gate passes this isolate's order and
        // starts its store read meanwhile.
        await pause(10);
        priceSource.value = "new";
        await updateTag("price");
        // The write's gate settles meanwhile.
        await pause(80);
        return [before, await getPrice()];
      }, options);
      await pause(80);
      await store.settle();

      expect(inAction).toEqual(["old", "new"]);
      expect(await runLoader(() => getPrice(), options)).toBe("new");
    },
  );
});

/**
 * Let the clock pass the invalidation's millisecond. CFCacheStore reads an
 * entry stamped in its tag marker's own millisecond as invalidated (marker
 * >= taggedAt, a same-millisecond invalidation wins), so a write that lands
 * in that millisecond misses on its next read; that rule is older than the
 * write gate. On Workers the invalidation's KV put is I/O, which advances
 * the clock.
 */
function afterInvalidationMillisecond(): Promise<void> {
  return pause(2);
}

// The gate only skips work that started before an invalidation: a call
// made after this isolate's own updateTag() fills the store as before.
describe("a write that started after this isolate's updateTag() (#977)", () => {
  it.each(OTHER_ISOLATE_STORES)(
    '%s: a "use cache" miss is written; the next read is a HIT',
    async (_label, makeStore) => {
      const store = makeStore();
      const options = {
        cacheStore: store.cacheStore,
        cacheProfiles: { default: { ttl: 60 } },
      };
      runs.getHeldShelf = 0;
      shelfSource.value = "v1";
      await inAnotherRequest(store, "held-shelf");
      await afterInvalidationMillisecond();
      const setItem = vi.spyOn(store.cacheStore, "setItem");

      expect(await runLoader(() => getHeldShelf("after"), options)).toBe(
        "after:v1",
      );
      await pause(20);
      await store.settle();
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(await runLoader(() => getHeldShelf("after"), options)).toBe(
        "after:v1",
      );
      expect(runs.getHeldShelf).toBe(1);
    },
  );

  it.each(OTHER_ISOLATE_STORES)(
    "%s: a loader's own cache() miss is written; the next read is a HIT",
    async (_label, makeStore) => {
      const store = makeStore();
      let bodyRuns = 0;
      const stockLoader = async () => {
        cacheTag("after-loader");
        bodyRuns++;
        return "v1";
      };
      const load = () =>
        runLoader(stockLoader, {
          cacheStore: store.cacheStore,
          cache: { ttl: 60 },
        });
      await inAnotherRequest(store, "after-loader");
      await afterInvalidationMillisecond();
      const setItem = vi.spyOn(store.cacheStore, "setItem");

      expect(await load()).toBe("v1");
      await pause(20);
      await store.settle();
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(await load()).toBe("v1");
      expect(bodyRuns).toBe(1);
    },
  );
});

describe("the write gate's marker reads (#977)", () => {
  // A page's "use cache" misses finish together and share tags: the gate
  // reads each tag's marker once for them, not once per write.
  it("CFCacheStore with KV: concurrent misses sharing a tag read its marker once", async () => {
    const store = cfStore();
    await runLoader(
      () => Promise.all([1, 2, 3, 4, 5].map((id) => getHotItem(id))),
      {
        cacheStore: store.cacheStore,
        cacheProfiles: { default: { ttl: 60 } },
      },
    );
    await pause(20);
    await store.settle();

    const markerReads = store.reads!.filter((key) =>
      key.includes("__tag__/hot-shared"),
    );
    expect(markerReads).toHaveLength(1);
  });
});

describe("a route cache() response entry whose handler ran before another request's updateTag() (#977)", () => {
  it("dispatch: the entry is not written; the next request runs the handler on the new data", async () => {
    const store = new MemorySegmentCacheStore();
    // Memory refuses a late write itself (#1068): pin the gate by asserting
    // the write never reached the store.
    const putResponse = vi.spyOn(store, "putResponse");
    let source = "old";
    let gate: Promise<void> = Promise.resolve();
    let calls = 0;
    const router = createRouter<{}>({ cache: { store } }).routes(
      urls(({ path, cache }) => [
        cache({ ttl: 600, tags: ["held-json"] }, () => [
          path.json(
            "/held-json",
            async () => {
              calls++;
              const value = source;
              await gate;
              return { value };
            },
            { name: "held.json" },
          ),
        ]),
      ]),
    ) as Parameters<typeof dispatch>[0];

    const held = hold();
    gate = held.held;
    const first = dispatch(router, { request: "/held-json" });
    await vi.waitFor(() => expect(calls).toBe(1));
    source = "new";
    await runInRequestContext(() => updateTag("held-json"), {
      cacheStore: store,
    });
    await pause(2);
    held.release();
    expect(await (await first).json()).toEqual({ value: "old" });
    await pause(20);
    expect(putResponse).not.toHaveBeenCalled();

    gate = Promise.resolve();
    const next = await dispatch(router, { request: "/held-json" });
    expect(await next.json()).toEqual({ value: "new" });
    expect(calls).toBe(2);
  });
});

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A store whose write gate cannot see the invalidation: its marker read
 * answers "not invalidated", as a KV read does that has not seen another
 * colo's marker yet, or when the marker lands between the gate and the put.
 * Only the stamp the store writes can reject the entry then (#1068). The
 * read path keeps its own marker check, which is not asked fail-closed.
 */
function blindGate(store: StoreUnderTest): StoreUnderTest {
  const target = store.cacheStore;
  const ask = target.isTagsInvalidatedSince?.bind(target);
  if (ask) {
    target.isTagsInvalidatedSince = (tags, sinceMs, options) =>
      options?.failClosed
        ? Promise.resolve(false)
        : ask(tags, sinceMs, options);
  }
  return store;
}

/** An invalidation no request order sees: straight on the store's markers. */
const directInvalidation: Invalidate = async (store, tag) => {
  await pause(2);
  await (store.otherIsolate ?? store.cacheStore).invalidateTags!([tag]);
};

const STAMP_STORES = [
  ["MemorySegmentCacheStore", memoryStore],
  ["CFCacheStore with KV", cfStore],
] as const;

// #1068: the write gate can pass a value that predates the invalidation (an
// eventually consistent KV read, a marker landing between the gate and the
// put). The store's stamp is the second line: the entry carries the start of
// the execution, so the read-side marker check rejects it.
describe("a write the gate let through, started before an invalidation (#1068)", () => {
  it.each(STAMP_STORES)(
    '%s: a "use cache" miss is rejected on the next request',
    async (_label, makeStore) => {
      expect(
        await useCacheMiss(
          blindGate(makeStore()),
          directInvalidation,
          "s-miss",
        ),
      ).toEqual(["s-miss:old", "s-miss:new"]);
    },
  );

  it.each(STAMP_STORES)(
    '%s: a "use cache" stale refresh is rejected on the next request',
    async (_label, makeStore) => {
      expect(
        await useCacheRefresh(
          blindGate(makeStore()),
          directInvalidation,
          "s-refresh",
        ),
      ).toEqual(["s-refresh:old", "s-refresh:new"]);
    },
  );

  it.each(STAMP_STORES)(
    "%s: a loader's own cache() miss is rejected on the next request",
    async (_label, makeStore) => {
      expect(
        await loaderCache(blindGate(makeStore()), directInvalidation, "miss"),
      ).toEqual(["old", "new"]);
    },
  );

  it.each(STAMP_STORES)(
    "%s: a loader's own cache() stale refresh is rejected on the next request",
    async (_label, makeStore) => {
      expect(
        await loaderCache(
          blindGate(makeStore()),
          directInvalidation,
          "refresh",
        ),
      ).toEqual(["old", "new"]);
    },
  );

  // The invalidating request reads its own writes: the store's request mask
  // compares the same stamp (VercelCacheStore has no other read-side check).
  it.each(STORES)(
    '%s: a "use cache" miss is not served to the request that invalidated meanwhile',
    async (_label, makeStore) => {
      const store = blindGate(makeStore());
      const options = {
        cacheStore: store.cacheStore,
        cacheProfiles: { default: { ttl: 60 } },
      };
      runs.getHeldShelf = 0;
      shelfSource.value = "old";
      const gate = hold();
      shelfGate.held = gate.held;

      const served = await runLoader(async () => {
        const first = getHeldShelf("s-same");
        await vi.waitFor(() => expect(runs.getHeldShelf).toBe(1));
        shelfSource.value = "new";
        await pause(2);
        await store.cacheStore.invalidateTags!(["held-shelf"]);
        await pause(2);
        gate.release();
        const before = await first;
        await pause(20);
        await store.settle();
        return [before, await getHeldShelf("s-same")];
      }, options);

      expect(served).toEqual(["s-same:old", "s-same:new"]);
    },
  );

  it.each(STAMP_STORES)(
    "%s: a route cache() response entry is rejected on the next request",
    async (_label, makeStore) => {
      const store = blindGate(makeStore());
      let source = "old";
      let gate: Promise<void> = Promise.resolve();
      let calls = 0;
      const router = createRouter<{}>({
        cache: { store: store.cacheStore },
      }).routes(
        urls(({ path, cache }) => [
          cache({ ttl: 600, tags: ["stamp-json"] }, () => [
            path.json(
              "/stamp-json",
              async () => {
                calls++;
                const value = source;
                await gate;
                return { value };
              },
              { name: "stamp.json" },
            ),
          ]),
        ]),
      ) as Parameters<typeof dispatch>[0];

      const held = hold();
      gate = held.held;
      const first = dispatch(router, { request: "/stamp-json" });
      await vi.waitFor(() => expect(calls).toBe(1));
      source = "new";
      await directInvalidation(store, "stamp-json");
      await pause(2);
      held.release();
      expect(await (await first).json()).toEqual({ value: "old" });
      await pause(20);
      await store.settle();

      gate = Promise.resolve();
      const next = await dispatch(router, { request: "/stamp-json" });
      expect(await next.json()).toEqual({ value: "new" });
      expect(calls).toBe(2);
    },
  );
});

// Known limit (#1068): VercelCacheStore compares an entry's `ta` with the
// invalidating request's mask only (expireTag keeps no queryable history), so
// a write the gate let through is served to a later request. These cases pin
// today's behaviour. When a data-read marker check lands on VercelCacheStore,
// flip each expectation to the fresh value and move the store into
// STAMP_STORES.
describe("VercelCacheStore: a write the gate let through is served to a later request (known limit, #1068)", () => {
  it('a "use cache" miss serves the old value', async () => {
    expect(
      await useCacheMiss(vercelBlind(), directInvalidation, "v-miss"),
    ).toEqual(["v-miss:old", "v-miss:old"]);
  });

  it('a "use cache" stale refresh serves the old value', async () => {
    expect(
      await useCacheRefresh(vercelBlind(), directInvalidation, "v-refresh"),
    ).toEqual(["v-refresh:old", "v-refresh:old"]);
  });

  it("a loader's own cache() miss serves the old value", async () => {
    expect(
      await loaderCache(vercelBlind(), directInvalidation, "miss"),
    ).toEqual(["old", "old"]);
  });

  it("a loader's own cache() stale refresh serves the old value", async () => {
    expect(
      await loaderCache(vercelBlind(), directInvalidation, "refresh"),
    ).toEqual(["old", "old"]);
  });

  it("a route cache() response entry serves the old value", async () => {
    const store = vercelBlind();
    let source = "old";
    let gate: Promise<void> = Promise.resolve();
    const router = createRouter<{}>({
      cache: { store: store.cacheStore },
    }).routes(
      urls(({ path, cache }) => [
        cache({ ttl: 600, tags: ["limit-json"] }, () => [
          path.json(
            "/limit-json",
            async () => {
              const value = source;
              await gate;
              return { value };
            },
            { name: "limit.json" },
          ),
        ]),
      ]),
    ) as Parameters<typeof dispatch>[0];

    const held = hold();
    gate = held.held;
    const first = dispatch(router, { request: "/limit-json" });
    await pause(10);
    source = "new";
    await directInvalidation(store, "limit-json");
    await pause(2);
    held.release();
    expect(await (await first).json()).toEqual({ value: "old" });
    await pause(20);
    await store.settle();

    gate = Promise.resolve();
    const next = await dispatch(router, { request: "/limit-json" });
    expect(await next.json()).toEqual({ value: "old" });
  });
});

function vercelBlind(): StoreUnderTest {
  return blindGate(vercelStore());
}

// A refresh is its own execution: its stamp is its own start. This request
// started before the invalidation of the tag the refresh records; the
// refresh started after it and is kept.
describe("a background refresh that started after an invalidation (#1068)", () => {
  it.each(OTHER_ISOLATE_STORES)(
    '%s: a "use cache" refresh is stored although its request started earlier',
    async (_label, makeStore) => {
      const store = makeStore();
      const options = {
        cacheStore: store.cacheStore,
        cacheProfiles: { stale: { ttl: 0, swr: 60 } },
      };
      runs.getVersionedInner = 0;
      await runLoader(() => getVersionedInner("s-late"), options);
      await pause(20);
      await store.settle();
      expect(runs.getVersionedInner).toBe(1);

      // Request R starts, then "versioned-v2" (the tag the refresh will
      // record) is invalidated, then R reads the stale entry: the refresh
      // starts after the invalidation.
      const stale = await runLoader(async () => {
        await pause(5);
        await inAnotherRequest(store, "versioned-v2");
        await afterInvalidationMillisecond();
        return getVersionedInner("s-late");
      }, options);
      expect(stale).toBe("s-late:v1");
      await pause(20);
      await store.settle();
      expect(runs.getVersionedInner).toBe(2);

      // The refreshed entry (v2) was stored, not skipped.
      expect(await runLoader(() => getVersionedInner("s-late"), options)).toBe(
        "s-late:v2",
      );
    },
  );
});
