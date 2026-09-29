/**
 * Tags recorded by the body of a loader with its own cache()
 * (`loader(Def, () => [cache({...})])`), through the real segment funnel:
 * resolveLoaders -> resolveLoaderData -> executeLoaderData -> the real
 * setupLoaderAccess executor (#964).
 *
 * A loader-cache HIT skips the body, so its cacheTag() calls and the tags of
 * the "use cache" reads it makes must come from the entry: stored with the
 * config tags on a MISS (or a stale refresh), re-recorded on a HIT through
 * the loader's tag owner, and invalidating the entry itself.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";

// segment-codec pulls @vitejs/plugin-rsc (unresolvable in plain vitest). A
// JSON codec stands in for Flight on the loader value and on "use cache"
// values.
vi.mock("../../../cache/segment-codec.js", () => ({
  serializeResult: vi.fn(async (value: unknown) => JSON.stringify(value)),
  deserializeResult: vi.fn(async (encoded: string) => JSON.parse(encoded)),
}));
vi.mock("../../../cache/handle-snapshot.js", async (importActual) => ({
  ...(await importActual<object>()),
  encodeHandles: async () => "",
  decodeHandles: async () => null,
}));
vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);

// loader-cache imports the codec lazily (getCodec). Two bindings starting in
// one request import it concurrently, and Vitest 4 serves the second
// concurrent import() of a factory-mocked module from the native loader,
// whose stub serializer fails (the write is then skipped). One cached loader
// resolved alone first leaves loader-cache holding the mocked codec.
beforeAll(async () => {
  await runRequest(
    entryWith([cachedEntry(bodyTaggedLoader(), new MemorySegmentCacheStore())]),
  );
});

import { resolveLoaders } from "../fresh.js";
import { setupLoaderAccess } from "../../loader-resolution.js";
import { createHandlerContext } from "../../handler-context.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import { CFCacheStore } from "../../../cache/cf/cf-cache-store.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../../../cache/vercel/vercel-cache-store.js";
import * as cacheTags from "../../../cache/cache-tag.js";
import {
  armLoaderTagSets,
  armRecordTagOwners,
  cacheTag,
  getSegmentTags,
  runInSegmentTagScope,
} from "../../../cache/cache-tag.js";
import { bindsLoaderCache } from "../loader-cache.js";
import { getLoaderBodyTags } from "../../../server/context.js";
import { updateTag } from "../../../cache/tag-invalidation.js";
import { registerCachedFunction } from "../../../cache/cache-runtime.js";
import type { EntryData, LoaderEntry } from "../../../server/context.js";
import type {
  HandlerContext,
  LoaderContext,
  LoaderDefinition,
} from "../../../types.js";
import type { SegmentCacheStore } from "../../../cache/types.js";
import type { SegmentResolutionDeps } from "../../types.js";

const deps = {
  wrapLoaderPromise: (p: Promise<unknown>) => p,
} as unknown as SegmentResolutionDeps<any>;

function defineLoader(
  id: string,
  fn: (ctx: LoaderContext<any, any>) => Promise<unknown>,
): LoaderDefinition<any, any> & { calls: number } {
  const def = {
    __brand: "loader" as const,
    $$id: id,
    calls: 0,
    fn: (ctx: LoaderContext<any, any>) => {
      def.calls++;
      return fn(ctx);
    },
  };
  return def;
}

function entryWith(loaderEntries: LoaderEntry[]): EntryData {
  return {
    id: "route-product",
    shortCode: "R0",
    type: "route",
    loader: loaderEntries,
    // Loading-disabled: resolveLoaders awaits every loader before returning.
    loading: false,
  } as unknown as EntryData;
}

function cachedEntry(
  loader: LoaderDefinition<any, any>,
  store: SegmentCacheStore,
  options: Record<string, unknown> = {},
): LoaderEntry {
  return {
    loader,
    revalidate: [],
    cache: { options: { store, ttl: 60, ...options } },
  } as LoaderEntry;
}

/** Tags itself "product:1"; returns its run count. */
function bodyTaggedLoader(): LoaderDefinition<any, any> & { calls: number } {
  const loader = defineLoader("ProductLoader#L", async () => {
    cacheTag("product:1");
    return { version: loader.calls };
  });
  return loader;
}

/** The tags each setItem stored so far, in write order. */
function writtenTags(store: MemorySegmentCacheStore): () => string[][] {
  const setItem = vi.spyOn(store, "setItem");
  return () => setItem.mock.calls.map(([, , o]) => [...(o?.tags ?? [])].sort());
}

/** Serve reads as stale while `state.stale` is set (the read-through's SWR branch). */
function serveStaleWhile(store: MemorySegmentCacheStore): { stale: boolean } {
  const state = { stale: false };
  const getItem = store.getItem.bind(store);
  store.getItem = async (key) => {
    const hit = await getItem(key);
    return hit && state.stale ? { ...hit, shouldRevalidate: true } : hit;
  };
  return state;
}

function newRequestContext(store?: SegmentCacheStore): RequestContext {
  const request = new Request("http://localhost/product");
  return createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
    cacheStore: store,
    cacheProfiles: { default: { ttl: 60 } },
  });
}

/**
 * One request through the segment funnel. `read` runs as the segment R0's
 * handler (its tag scope, so a ctx.use(loader) read links the loader to it)
 * once the loaders were kicked off; the request is armed for record tag
 * owners, like one whose match resolved a cache scope. `appStore` backs
 * "use cache".
 */
async function runRequest(
  entry: EntryData,
  opts: {
    read?: (ctx: HandlerContext<any, any>) => Promise<unknown>;
    appStore?: SegmentCacheStore;
    /** A layout above the route: its loaders start first. */
    layout?: EntryData;
  } = {},
) {
  const { read, appStore, layout } = opts;
  const reqCtx = newRequestContext(appStore);
  // Armed as the match arms them (match-api.ts).
  armRecordTagOwners(reqCtx);
  if (bindsLoaderCache(layout ? [layout, entry] : [entry])) {
    armLoaderTagSets(reqCtx);
  }
  const data = await runWithRequestContext(reqCtx, async () => {
    const request = reqCtx.request;
    const url = new URL(request.url);
    const ctx = createHandlerContext(
      {},
      request,
      url.searchParams,
      url.pathname,
      url,
      {},
    );
    setupLoaderAccess(ctx, new Map());
    const resolutions = [
      ...(layout ? [resolveLoaders(layout, ctx, false, deps)] : []),
      resolveLoaders(entry, ctx, true, deps),
    ];
    if (read) await runInSegmentTagScope("R0", () => read(ctx));
    const segments = (await Promise.all(resolutions)).flat();
    const values = await Promise.all(segments.map((s) => s.loaderData));
    // Deferred cache writes (and any stale revalidation) ride waitUntil.
    await Promise.all(reqCtx._pendingBackgroundTasks ?? []);
    return values;
  });
  return {
    data,
    requestTags: [...reqCtx._requestTags].sort(),
    readerTags: [...getSegmentTags(reqCtx, "R0")].sort(),
    loaderTagSetsArmed: reqCtx._recordLoaderTags === true,
  };
}

async function invalidate(store: SegmentCacheStore, tag: string) {
  await runWithRequestContext(newRequestContext(store), () => updateTag(tag));
}

describe("loader-level cache: the tags its body recorded", () => {
  it("a MISS stores the body's cacheTag() tags with the cache() tags", async () => {
    const store = new MemorySegmentCacheStore();
    const writes = writtenTags(store);

    await runRequest(
      entryWith([
        cachedEntry(bodyTaggedLoader(), store, { tags: ["products"] }),
      ]),
    );

    expect(writes()).toEqual([["product:1", "products"]]);
  });

  it("a HIT records the stored body tags, through the loader's owner onto the segment that reads it", async () => {
    const store = new MemorySegmentCacheStore();
    const loader = bodyTaggedLoader();
    const entry = entryWith([
      cachedEntry(loader, store, { tags: ["products"] }),
    ]);
    const read = (ctx: HandlerContext<any, any>) => ctx.use(loader);

    const miss = await runRequest(entry, { read });
    const hit = await runRequest(entry, { read });

    expect(loader.calls).toBe(1);
    expect(hit.data).toEqual([{ version: 1 }]);
    expect(miss.readerTags).toEqual(["product:1", "products"]);
    expect(hit.requestTags).toEqual(["product:1", "products"]);
    expect(hit.readerTags).toEqual(["product:1", "products"]);
  });

  it('stores the tags of a "use cache" read in the body, and of the loaders it starts', async () => {
    const store = new MemorySegmentCacheStore();
    const writes = writtenTags(store);
    const getPrice = registerCachedFunction(
      async () => {
        cacheTag("price:1");
        return 42;
      },
      "test#loaderCacheTagsPrice",
      "default",
    );
    const category = defineLoader("CategoryLoader#L", async () => {
      cacheTag("category:c");
      return { slug: "c" };
    });
    const product = defineLoader("ProductLoader#L", async (ctx) => {
      const { slug } = await ctx.use(category);
      return { slug, price: await getPrice() };
    });

    await runRequest(entryWith([cachedEntry(product, store)]), {
      appStore: new MemorySegmentCacheStore(),
    });

    expect(writes()).toEqual([["category:c", "price:1"]]);
  });

  it("a stale refresh stores the refreshed body's tags, not the stale entry's", async () => {
    const store = new MemorySegmentCacheStore();
    const writes = writtenTags(store);
    const state = serveStaleWhile(store);
    const loader = defineLoader("ProductLoader#L", async () => {
      const version = loader.calls;
      cacheTag(`product-v${version}`);
      return { version };
    });
    const entry = entryWith([
      cachedEntry(loader, store, { tags: ["products"], swr: 60 }),
    ]);

    await runRequest(entry);
    state.stale = true;
    const stale = await runRequest(entry);
    state.stale = false;

    expect(loader.calls).toBe(2);
    expect(stale.data).toEqual([{ version: 1 }]);
    expect(writes()).toEqual([
      ["product-v1", "products"],
      ["product-v2", "products"],
    ]);

    // The refreshed entry answers to its own body tag only.
    await invalidate(store, "product-v1");
    expect((await runRequest(entry)).data).toEqual([{ version: 2 }]);
    await invalidate(store, "product-v2");
    expect((await runRequest(entry)).data).toEqual([{ version: 3 }]);
  });
});

function uncachedEntry(loader: LoaderDefinition<any, any>): LoaderEntry {
  return { loader, revalidate: [] } as unknown as LoaderEntry;
}

function layoutWith(loaderEntries: LoaderEntry[]): EntryData {
  return {
    id: "layout-shop",
    shortCode: "L0",
    type: "layout",
    loader: loaderEntries,
    loading: false,
  } as unknown as EntryData;
}

describe("loader-level cache: the tags of the loaders its body reads", () => {
  /** `product` (cached) reads `category`, which tags itself. */
  function readerGraph() {
    const category = defineLoader("CategoryLoader#L", async () => {
      cacheTag("category:c");
      return { slug: "c", run: category.calls };
    });
    const product = defineLoader("ProductLoader#L", async (ctx) => {
      cacheTag("product:1");
      const { run } = await ctx.use(category);
      return { category: run, run: product.calls };
    });
    return { category, product };
  }

  it.each([
    [
      "bound after it on the same route",
      (g: ReturnType<typeof readerGraph>, store: MemorySegmentCacheStore) =>
        [
          entryWith([cachedEntry(g.product, store), uncachedEntry(g.category)]),
          {},
        ] as const,
    ],
    [
      "bound on the layout",
      (g: ReturnType<typeof readerGraph>, store: MemorySegmentCacheStore) =>
        [
          entryWith([cachedEntry(g.product, store)]),
          { layout: layoutWith([uncachedEntry(g.category)]) },
        ] as const,
    ],
    [
      "read by the handler first",
      (g: ReturnType<typeof readerGraph>, store: MemorySegmentCacheStore) =>
        [
          entryWith([cachedEntry(g.product, store)]),
          {
            read: (ctx: HandlerContext<any, any>) => ctx.use(g.category),
          },
        ] as const,
    ],
  ])(
    "a dependency another reader started (%s): its tags drop the entry",
    async (_label, route) => {
      const store = new MemorySegmentCacheStore();
      const writes = writtenTags(store);
      const g = readerGraph();
      const [entry, opts] = route(g, store);

      await runRequest(entry, opts);
      expect(writes()).toEqual([["category:c", "product:1"]]);
      expect(g.product.calls).toBe(1);

      await invalidate(store, "category:c");
      await runRequest(entry, opts);
      expect(g.product.calls).toBe(2);
    },
  );

  it("a cache()-bound loader it reads: that loader's cache() tags and entry tags, on its MISS and its HIT", async () => {
    const store = new MemorySegmentCacheStore();
    const writes = writtenTags(store);
    const g = readerGraph();
    const categoryEntry = cachedEntry(g.category, store, {
      tags: ["categories"],
    });
    const productEntry = cachedEntry(g.product, store);

    // Both MISS.
    await runRequest(entryWith([categoryEntry, productEntry]));
    // category HITs; product MISSes over it.
    await invalidate(store, "product:1");
    await runRequest(entryWith([categoryEntry, productEntry]));

    const productWrites = writes().filter((tags) => tags.includes("product:1"));
    expect(productWrites).toEqual([
      ["categories", "category:c", "product:1"],
      ["categories", "category:c", "product:1"],
    ]);
    expect(g.category.calls).toBe(1);
    expect(g.product.calls).toBe(2);
  });

  it("a cache()-bound loader another loader started before its binding: its cache() tags reach a cached reader", async () => {
    const store = new MemorySegmentCacheStore();
    const writes = writtenTags(store);
    const g = readerGraph();
    // `starter` starts category before category's binding does; `reader`
    // (cached) consumes starter's value.
    const starter = defineLoader("StarterLoader#L", async (ctx) => ({
      starter: await ctx.use(g.category),
    }));
    const reader = defineLoader("ReaderLoader#L", async (ctx) => ({
      reader: await ctx.use(starter),
    }));

    await runRequest(
      entryWith([
        uncachedEntry(starter),
        cachedEntry(g.category, store, { tags: ["categories"] }),
        cachedEntry(reader, store),
      ]),
    );

    // category's entry, then reader's.
    expect(writes()).toEqual([
      ["categories", "category:c"],
      ["categories", "category:c"],
    ]);
  });

  it("a stale refresh reads a stale cache()-bound loader fresh, with that binding's cache() tags", async () => {
    const store = new MemorySegmentCacheStore();
    const writes = writtenTags(store);
    const state = serveStaleWhile(store);
    const g = readerGraph();
    const route = entryWith([
      cachedEntry(g.category, store, { tags: ["categories"], swr: 60 }),
      cachedEntry(g.product, store, { swr: 60 }),
    ]);

    await runRequest(route);
    state.stale = true;
    await runRequest(route);
    state.stale = false;
    const fresh = await runRequest(route);

    // The refresh ran category itself (run 3) instead of reusing the page's
    // stale copy (run 1): product's refreshed entry is as fresh as category's.
    expect(g.category.calls).toBe(3);
    expect(fresh.data[1]).toEqual({ category: 3, run: 2 });
    const productRefresh = writes().filter((tags) =>
      tags.includes("product:1"),
    )[1];
    expect(productRefresh).toEqual(["categories", "category:c", "product:1"]);
  });
});

describe("per-execution loader tag sets run only where a loader cache() reads them", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** `reader` reads `dep`; the handler reads `dep` too. */
  function plainGraph() {
    const seen: Array<Set<string> | undefined> = [];
    const dep = defineLoader("DepLoader#L", async () => {
      seen.push(getLoaderBodyTags());
      return { dep: 1 };
    });
    const reader = defineLoader("ReaderLoader#L", async (ctx) => {
      seen.push(getLoaderBodyTags());
      return { read: await ctx.use(dep) };
    });
    return { dep, reader, seen };
  }

  it("a request without a loader cache() allocates no set and links nothing", async () => {
    const tagValue = vi.spyOn(cacheTags, "tagLoaderValue");
    const readValue = vi.spyOn(cacheTags, "readValueTags");
    const { dep, reader, seen } = plainGraph();

    const result = await runRequest(
      entryWith([uncachedEntry(reader), uncachedEntry(dep)]),
      { read: (ctx) => ctx.use(dep) },
    );

    expect(result.data).toEqual([{ read: { dep: 1 } }, { dep: 1 }]);
    expect(result.loaderTagSetsArmed).toBe(false);
    expect(seen).toEqual([undefined, undefined]);
    expect(tagValue).not.toHaveBeenCalled();
    expect(readValue).not.toHaveBeenCalled();
  });

  it("control: a route binding a loader cache() gives every execution its own set", async () => {
    const tagValue = vi.spyOn(cacheTags, "tagLoaderValue");
    const readValue = vi.spyOn(cacheTags, "readValueTags");
    const { dep, reader, seen } = plainGraph();

    const result = await runRequest(
      entryWith([
        uncachedEntry(reader),
        uncachedEntry(dep),
        cachedEntry(bodyTaggedLoader(), new MemorySegmentCacheStore()),
      ]),
    );

    expect(result.loaderTagSetsArmed).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(Set);
    expect(seen[1]).toBeInstanceOf(Set);
    expect(seen[0]).not.toBe(seen[1]);
    expect(tagValue).toHaveBeenCalled();
    expect(readValue).toHaveBeenCalled();
  });

  it("bindsLoaderCache finds a binding on the chain, a parallel slot, an orphan layout or an intercept", () => {
    const store = new MemorySegmentCacheStore();
    const cached = [cachedEntry(bodyTaggedLoader(), store)];
    const plain = [uncachedEntry(bodyTaggedLoader())];
    const off = [
      {
        loader: bodyTaggedLoader(),
        revalidate: [],
        cache: { options: false },
      } as LoaderEntry,
    ];
    const entry = (fields: Record<string, unknown>) =>
      ({
        loader: plain,
        layout: [],
        parallel: {},
        intercept: [],
        ...fields,
      }) as unknown as EntryData;

    expect(bindsLoaderCache([entry({})])).toBe(false);
    expect(bindsLoaderCache([entry({ loader: off })])).toBe(false);
    expect(bindsLoaderCache([entry({}), entry({ loader: cached })])).toBe(true);
    expect(
      bindsLoaderCache([
        entry({ parallel: { "@side": entry({ loader: cached }) } }),
      ]),
    ).toBe(true);
    expect(
      bindsLoaderCache([entry({ layout: [entry({ loader: cached })] })]),
    ).toBe(true);
    expect(bindsLoaderCache([entry({ intercept: [{ loader: cached }] })])).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Every built-in store carries the item's tags through setItem/getItem.
// ---------------------------------------------------------------------------

/** Cloudflare Cache API (L1). */
class MockCache {
  private entries = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response.clone());
  }
  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
  clear(): void {
    this.entries.clear();
  }
}

class MockKV {
  private entries = new Map<string, string>();
  async get(key: string, options?: { type?: string }): Promise<unknown> {
    const raw = this.entries.get(key);
    if (raw === undefined) return null;
    return options?.type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/** Vercel Runtime Cache: JSON round-trip, expireTag deletes tagged entries. */
function fakeRuntimeCache(): VercelRuntimeCache {
  const entries = new Map<string, { value: unknown; tags: string[] }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      return entry ? JSON.parse(JSON.stringify(entry.value)) : undefined;
    },
    async set(key, value, options) {
      entries.set(key, {
        value: JSON.parse(JSON.stringify(value)),
        tags: options?.tags ?? [],
      });
    },
    async delete(key) {
      entries.delete(key);
    },
    async expireTag(tag) {
      const tags = Array.isArray(tag) ? tag : [tag];
      for (const [key, entry] of entries) {
        if (entry.tags.some((t) => tags.includes(t))) entries.delete(key);
      }
    },
  };
}

interface StoreUnderTest {
  store: SegmentCacheStore;
  /** Settle the store's own background writes. */
  flush: () => Promise<void>;
}

function cfStore(): StoreUnderTest & { dropL1: () => void } {
  const l1 = new MockCache();
  vi.stubGlobal("caches", { default: l1, open: async () => l1 });
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(Promise.resolve(p));
    },
    passThroughOnException: () => {},
  };
  return {
    store: new CFCacheStore({ ctx, kv: new MockKV() as never }),
    flush: async () => {
      while (pending.length) await Promise.all(pending.splice(0));
    },
    dropL1: () => l1.clear(),
  };
}

const STORES: Array<[string, () => StoreUnderTest]> = [
  [
    "MemorySegmentCacheStore",
    () => ({ store: new MemorySegmentCacheStore(), flush: async () => {} }),
  ],
  ["CFCacheStore (Cache API + KV)", cfStore],
  [
    "VercelCacheStore",
    () => ({
      store: new VercelCacheStore({ cache: fakeRuntimeCache() }),
      flush: async () => {},
    }),
  ],
];

describe("loader-level cache body tags per store", () => {
  // Tag markers compare timestamps: every step lands on a later millisecond.
  let now = 1_700_000_000_000;
  const tick = () => {
    vi.setSystemTime((now += 1000));
  };
  const request = async ({ flush }: StoreUnderTest, entry: EntryData) => {
    tick();
    const result = await runRequest(entry);
    await flush();
    return result;
  };
  const invalidateLater = (store: SegmentCacheStore, tag: string) => {
    tick();
    return invalidate(store, tag);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe.each(STORES)("%s", (_name, make) => {
    it("stores the body tag, records it on a HIT, and is dropped by it", async () => {
      const target = make();
      const entry = entryWith([
        cachedEntry(bodyTaggedLoader(), target.store, {
          ttl: 600,
          tags: ["products"],
        }),
      ]);

      await request(target, entry);
      const hit = await request(target, entry);
      expect(hit.data).toEqual([{ version: 1 }]);
      expect(hit.requestTags).toEqual(["product:1", "products"]);

      await invalidateLater(target.store, "product:1");
      expect((await request(target, entry)).data).toEqual([{ version: 2 }]);
      expect((await request(target, entry)).data).toEqual([{ version: 2 }]);

      // Rewritten with the tag: a second invalidation drops it again.
      await invalidateLater(target.store, "product:1");
      expect((await request(target, entry)).data).toEqual([{ version: 3 }]);
    });
  });

  it("CFCacheStore: a HIT served from KV records the body tag and is dropped by it", async () => {
    const target = cfStore();
    const entry = entryWith([
      cachedEntry(bodyTaggedLoader(), target.store, { ttl: 600 }),
    ]);

    await request(target, entry);
    target.dropL1();
    const hit = await request(target, entry);
    expect(hit.data).toEqual([{ version: 1 }]);
    expect(hit.requestTags).toEqual(["product:1"]);

    await invalidateLater(target.store, "product:1");
    expect((await request(target, entry)).data).toEqual([{ version: 2 }]);
  });
});
