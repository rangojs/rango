/**
 * A loader with its own cache() (`loader(Def, () => [cache({...})])`) whose
 * body reads request identity (#972), through the real segment funnel:
 * resolveLoaders -> resolveLoaderData -> executeLoaderData -> the real
 * setupLoaderAccess executor.
 *
 * The entry's default key is loader id, host, path and params, so it is
 * shared across users. Unless the binding declares identity (a cache() key()
 * or a store keyGenerator), a fill whose execution read cookies()/headers()/
 * a non-cacheable ctx.get(), in the body or in a loader it read via ctx.use,
 * fails with the same error and stores nothing: on the MISS, on the stale
 * refresh, and when a reader started the loader before its binding did.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

// segment-codec pulls @vitejs/plugin-rsc (unresolvable in plain vitest). A
// JSON codec stands in for Flight on the loader value; like Flight, it waits
// for a promise in a top-level field.
vi.mock("../../../cache/segment-codec.js", () => ({
  serializeResult: vi.fn(async (value: unknown) => {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    const settled: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) settled[k] = await v;
    return JSON.stringify(settled);
  }),
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

import { resolveLoaders } from "../fresh.js";
import { bindsLoaderCache, resolveLoaderData } from "../loader-cache.js";
import { armLoaderTagSets } from "../../../cache/cache-tag.js";
import { setupLoaderAccess } from "../../loader-resolution.js";
import { createHandlerContext } from "../../handler-context.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";
import { RangoContext } from "../../../server/context.js";
import { cookies, headers } from "../../../server/cookie-store.js";
import { createVar } from "../../../context-var.js";
import { resolveThemeConfig } from "../../../theme/constants.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
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

// loader-cache imports the codec lazily (getCodec); resolve it once so every
// test's first binding reads the mocked module.
beforeAll(async () => {
  const loader = defineLoader("Warmup#L", async () => 1);
  await runRequest(
    entryWith([cachedEntry(loader, new MemorySegmentCacheStore())]),
  );
});

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
    id: "route-account",
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

function liveEntry(loader: LoaderDefinition<any, any>): LoaderEntry {
  return { loader, revalidate: [] } as unknown as LoaderEntry;
}

const SessionVar = createVar<string>({ cache: false });

/** One request as `session` (cookie and x-session header). */
function newRequestContext(session: string, theme?: string): RequestContext {
  const cookie = `session=${session}${theme ? `; theme=${theme}` : ""}`;
  const request = new Request("http://localhost/account", {
    headers: { cookie, "x-session": session },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
    themeConfig: theme ? resolveThemeConfig(true) : undefined,
  });
  reqCtx.set(SessionVar, session);
  reqCtx.set("sessionKey", session, { cache: false });
  return reqCtx;
}

/**
 * One request through the segment funnel. Returns each loader's settled
 * result and the background errors the request reported (a failed stale
 * refresh lands there).
 */
async function runRequest(
  entry: EntryData,
  opts: {
    session?: string;
    /** A theme-enabled request whose visitor has this theme cookie. */
    theme?: string;
    /** Resolve inside a route cache() scope (the render-store flag). */
    underRouteCache?: boolean;
    /**
     * A reader that runs before the entry's loaders start, like a parent
     * layout's handler; its result is `read`.
     */
    readFirst?: (ctx: HandlerContext<any, any>) => Promise<unknown>;
    /** A host without waitUntil: the read-through awaits its cache write. */
    noWaitUntil?: boolean;
  } = {},
) {
  const reqCtx = newRequestContext(opts.session ?? "a", opts.theme);
  // Armed as the match arms them (match-api.ts), before any reader runs.
  if (bindsLoaderCache([entry])) armLoaderTagSets(reqCtx);
  const reported: unknown[] = [];
  reqCtx._reportBackgroundError = (error) => {
    reported.push(error);
  };
  const run = async () => {
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
    // After the handler ctx bound it: the loader cache reads it off reqCtx.
    if (opts.noWaitUntil) delete (reqCtx as { waitUntil?: unknown }).waitUntil;
    const read = opts.readFirst ? await opts.readFirst(ctx) : undefined;
    // Loading-disabled resolution awaits every loader, so a throwing body
    // rejects the resolution itself.
    const results = await resolveLoaders(entry, ctx, true, deps).then(
      (segments) => Promise.allSettled(segments.map((s) => s.loaderData)),
      (reason: unknown) => [{ status: "rejected" as const, reason }],
    );
    // Deferred cache writes (and any stale revalidation) ride waitUntil.
    await Promise.all(reqCtx._pendingBackgroundTasks ?? []);
    return { results, read };
  };
  const { results, read } = await runWithRequestContext(reqCtx, () =>
    opts.underRouteCache
      ? RangoContext.run({ insideCacheScope: true } as any, run)
      : run(),
  );
  return {
    values: results.map((r) => (r.status === "fulfilled" ? r.value : r)),
    errors: results.flatMap((r) =>
      r.status === "rejected" ? [(r.reason as Error).message] : [],
    ),
    reported: reported.map((e) => (e as Error).message),
    read,
  };
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

const cookieLoader = (id = "SessionLoader#L") =>
  defineLoader(id, async () => ({
    session: cookies().get("session")?.value,
  }));

/** GreetingLoader#L reads UserLoader#L (a cookies() read) via ctx.use. */
function greetingChain() {
  const user = cookieLoader("UserLoader#L");
  return defineLoader("GreetingLoader#L", async (ctx) => {
    const { session } = await ctx.use(user);
    return `hello ${session}`;
  });
}

describe("loader cache() without key(): request-identity reads throw on the MISS (#972)", () => {
  it.each([
    ["cookies()", async () => cookies().get("session")?.value],
    ["headers()", async () => headers().get("x-session")],
    [
      "ctx.get() for a non-cacheable variable",
      async (ctx: LoaderContext<any, any>) => ctx.get(SessionVar),
    ],
    [
      'ctx.get() for a non-cacheable variable "sessionKey"',
      async (ctx: LoaderContext<any, any>) => ctx.get("sessionKey" as never),
    ],
  ] as const)("%s", async (surface, read) => {
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");
    const loader = defineLoader("SessionLoader#L", async (ctx) => ({
      session: await read(ctx),
    }));

    const { errors } = await runRequest(
      entryWith([cachedEntry(loader, store)]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${surface} cannot be called inside loader`);
    expect(errors[0]).toContain('"SessionLoader#L"');
    expect(errors[0]).toMatch(/shared across users/);
    expect(errors[0]).toMatch(/key: \(ctx\) =>/);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("the second user never receives the first user's value", async () => {
    const store = new MemorySegmentCacheStore();
    const entry = entryWith([cachedEntry(cookieLoader(), store)]);

    const a = await runRequest(entry, { session: "a" });
    const b = await runRequest(entry, { session: "b" });

    expect(b.values).not.toContainEqual({ session: "a" });
    expect(a.errors).toHaveLength(1);
    expect(b.errors).toHaveLength(1);
  });

  it("throws under a route cache() scope too: the loader entry does not inherit the route key", async () => {
    const store = new MemorySegmentCacheStore();

    const { errors } = await runRequest(
      entryWith([cachedEntry(cookieLoader(), store)]),
      { underRouteCache: true },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cookies() cannot be called inside loader");
  });

  it("a stale refresh runs the same guard: the refresh fails, the stale entry keeps serving", async () => {
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");
    const state = serveStaleWhile(store);
    // The first run reads nothing request-scoped; the refresh does.
    const loader = defineLoader("SessionLoader#L", async () => ({
      session: loader.calls > 1 ? cookies().get("session")?.value : "none",
    }));
    const entry = entryWith([cachedEntry(loader, store, { swr: 60 })]);

    const miss = await runRequest(entry);
    state.stale = true;
    const stale = await runRequest(entry, { session: "b" });

    expect(miss.values).toEqual([{ session: "none" }]);
    expect(stale.values).toEqual([{ session: "none" }]);
    expect(loader.calls).toBe(2);
    expect(stale.reported).toHaveLength(1);
    expect(stale.reported[0]).toContain(
      "cookies() cannot be called inside loader",
    );
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("a loader the cached body reads via ctx.use runs under the guard: its value lands in the entry", async () => {
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");
    const greeting = greetingChain();

    const { errors } = await runRequest(
      entryWith([cachedEntry(greeting, store)]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      'cookies() cannot be called inside loader "UserLoader#L", which loader "GreetingLoader#L" reads',
    );
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe("a reader starts the loader before its binding does: the MISS reuses that run", () => {
  /** The binding-first error, for the same loader ids. */
  async function bindingFirstErrors(loader: LoaderDefinition<any, any>) {
    const store = new MemorySegmentCacheStore();
    return (await runRequest(entryWith([cachedEntry(loader, store)]))).errors;
  }

  it("the fill fails with the binding-first error, and the second user never receives the first user's value", async () => {
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");
    const loader = cookieLoader();
    const entry = entryWith([cachedEntry(loader, store)]);
    const readFirst = (ctx: HandlerContext<any, any>) => ctx.use(loader);

    const a = await runRequest(entry, { session: "a", readFirst });
    const b = await runRequest(entry, { session: "b", readFirst });

    expect(b.values).not.toContainEqual({ session: "a" });
    // The reader's own run is live: each user reads their own value.
    expect(a.read).toEqual({ session: "a" });
    expect(b.read).toEqual({ session: "b" });
    const expected = await bindingFirstErrors(cookieLoader());
    expect(expected).toHaveLength(1);
    expect(a.errors).toEqual(expected);
    expect(b.errors).toEqual(expected);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("the same for a cached loader whose ctx.use dependency read cookies()", async () => {
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");
    const greeting = greetingChain();
    const readFirst = (ctx: HandlerContext<any, any>) => ctx.use(greeting);

    const { errors } = await runRequest(
      entryWith([cachedEntry(greeting, store)]),
      { readFirst },
    );

    expect(errors).toEqual(await bindingFirstErrors(greetingChain()));
    expect(setItem).not.toHaveBeenCalled();
  });

  it("the same when the reader started only the dependency", async () => {
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");
    const user = cookieLoader("UserLoader#L");
    const greeting = defineLoader("GreetingLoader#L", async (ctx) => {
      const { session } = await ctx.use(user);
      return `hello ${session}`;
    });

    const { errors, read } = await runRequest(
      entryWith([cachedEntry(greeting, store)]),
      { readFirst: (ctx) => ctx.use(user) },
    );

    expect(read).toEqual({ session: "a" });
    expect(errors).toEqual(await bindingFirstErrors(greetingChain()));
    expect(setItem).not.toHaveBeenCalled();
  });

  it("with a key(), the reused run is stored per user", async () => {
    const store = new MemorySegmentCacheStore();
    const loader = cookieLoader();
    const entry = entryWith([
      cachedEntry(loader, store, {
        key: () => `session:${cookies().get("session")?.value}`,
      }),
    ]);
    const readFirst = (ctx: HandlerContext<any, any>) => ctx.use(loader);

    const a = await runRequest(entry, { session: "a", readFirst });
    const b = await runRequest(entry, { session: "b", readFirst });

    expect(a.values).toEqual([{ session: "a" }]);
    expect(b.values).toEqual([{ session: "b" }]);
  });
});

describe("loader cache() that declares identity: reads are allowed", () => {
  it("key(): each user gets their own entry", async () => {
    const store = new MemorySegmentCacheStore();
    const loader = cookieLoader();
    const entry = entryWith([
      cachedEntry(loader, store, {
        key: () => `session:${cookies().get("session")?.value}`,
      }),
    ]);

    const a = await runRequest(entry, { session: "a" });
    const b = await runRequest(entry, { session: "b" });
    const aHit = await runRequest(entry, { session: "a" });

    expect(a.values).toEqual([{ session: "a" }]);
    expect(b.values).toEqual([{ session: "b" }]);
    expect(aHit.values).toEqual([{ session: "a" }]);
    expect(loader.calls).toBe(2);
  });

  it("store keyGenerator: each user gets their own entry", async () => {
    const store = new MemorySegmentCacheStore({
      keyGenerator: (ctx, defaultKey) =>
        `${defaultKey}:${ctx.request.headers.get("x-session")}`,
    });
    const loader = cookieLoader();
    const entry = entryWith([cachedEntry(loader, store)]);

    const a = await runRequest(entry, { session: "a" });
    const b = await runRequest(entry, { session: "b" });

    expect(a.values).toEqual([{ session: "a" }]);
    expect(b.values).toEqual([{ session: "b" }]);
    expect(loader.calls).toBe(2);
  });

  it("key(): the loaders the body reads via ctx.use may read identity too", async () => {
    const store = new MemorySegmentCacheStore();
    const greeting = greetingChain();
    const entry = entryWith([
      cachedEntry(greeting, store, {
        key: () => `greeting:${cookies().get("session")?.value}`,
      }),
    ]);

    expect((await runRequest(entry, { session: "a" })).values).toEqual([
      "hello a",
    ]);
    expect((await runRequest(entry, { session: "b" })).values).toEqual([
      "hello b",
    ]);
  });

  it("a false condition runs the loader live, outside the cache", async () => {
    const store = new MemorySegmentCacheStore();
    const entry = entryWith([
      cachedEntry(cookieLoader(), store, { condition: () => false }),
    ]);

    expect((await runRequest(entry, { session: "a" })).values).toEqual([
      { session: "a" },
    ]);
  });
});

describe("live loaders stay unaffected", () => {
  it("a loader with no cache() reads cookies(), under a route cache() scope too", async () => {
    const entry = entryWith([liveEntry(cookieLoader())]);

    expect((await runRequest(entry, { session: "a" })).values).toEqual([
      { session: "a" },
    ]);
    expect(
      (await runRequest(entry, { session: "b", underRouteCache: true })).values,
    ).toEqual([{ session: "b" }]);
  });

  it("a live sibling reads cookies() while an unkeyed cached loader's MISS is in flight", async () => {
    const store = new MemorySegmentCacheStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowCached = defineLoader("CatalogLoader#L", async () => {
      await gate;
      return { catalog: 1 };
    });
    const live = defineLoader("SessionLoader#L", async () => {
      const session = cookies().get("session")?.value;
      release();
      return { session };
    });

    const { values } = await runRequest(
      entryWith([cachedEntry(slowCached, store), liveEntry(live)]),
    );

    expect(values).toEqual([{ catalog: 1 }, { session: "a" }]);
  });

  it("a headers() view taken outside the loader and read inside it counts", async () => {
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");
    let handed: ReturnType<typeof headers> | undefined;
    const loader = defineLoader("Handed#L", async () => ({
      s: handed!.get("x-session"),
    }));
    const entry = entryWith([cachedEntry(loader, store)]);
    const readFirst = async () => {
      handed = headers();
    };

    const a = await runRequest(entry, { session: "a", readFirst });
    const b = await runRequest(entry, { session: "b", readFirst });

    expect(b.values).not.toContainEqual({ s: "a" });
    expect(a.errors).toHaveLength(1);
    expect(a.errors[0]).toContain(
      'headers() cannot be called inside loader "Handed#L"',
    );
    expect(setItem).not.toHaveBeenCalled();
  });

  it("with no waitUntil the write blocks: a late read skips it and is reported, the value is served", async () => {
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");
    const late = defineLoader("Late#L", async () => ({
      session: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return cookies().get("session")?.value;
      })(),
    }));

    const { errors, reported } = await runRequest(
      entryWith([cachedEntry(late, store)]),
      { noWaitUntil: true },
    );

    expect(errors).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(
      'cookies() cannot be called inside loader "Late#L", whose own cache() has no key()',
    );
    expect(setItem).not.toHaveBeenCalled();
  });

  it("a write alone (cookies().set()) is not a read: the entry is stored", async () => {
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");
    const writer = defineLoader("Writer#L", async () => {
      cookies().set("seen", "1");
      return { pure: 1 };
    });

    const { errors, values } = await runRequest(
      entryWith([cachedEntry(writer, store)]),
    );

    expect(errors).toEqual([]);
    expect(values).toEqual([{ pure: 1 }]);
    expect(setItem).toHaveBeenCalledTimes(1);
  });
});

describe("an unkeyed loader that reads a keyed cached loader via ctx.use", () => {
  const bySession = { key: () => `k:${cookies().get("session")?.value}` };

  /** Greeting#L (unkeyed) reads KeyedSession#L (keyed per session). */
  function page(keyedStore: SegmentCacheStore, readerStore: SegmentCacheStore) {
    const keyed = cookieLoader("KeyedSession#L");
    const reader = defineLoader("Greeting#L", async (ctx) => {
      const { session } = await ctx.use(keyed);
      return `hello ${session}`;
    });
    const keyedEntry = cachedEntry(keyed, keyedStore, bySession);
    return {
      /** The keyed loader alone, on another route. */
      warm: entryWith([keyedEntry]),
      page: entryWith([cachedEntry(reader, readerStore), keyedEntry]),
    };
  }

  const expected =
    'cookies() cannot be called inside loader "KeyedSession#L", which loader "Greeting#L" reads';

  it("fails on the dependency's HIT: its entry carries the read its MISS made", async () => {
    const keyedStore = new MemorySegmentCacheStore();
    const readerStore = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(readerStore, "setItem");
    const routes = page(keyedStore, readerStore);
    for (const session of ["a", "b"]) {
      expect((await runRequest(routes.warm, { session })).errors).toEqual([]);
    }

    const a = await runRequest(routes.page, { session: "a" });
    const b = await runRequest(routes.page, { session: "b" });

    expect(b.values).not.toContain("hello a");
    expect(a.errors).toHaveLength(1);
    expect(a.errors[0]).toContain(expected);
    expect(b.errors).toEqual(a.errors);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("the same error on the dependency's MISS and on its stale hit", async () => {
    const keyedStore = new MemorySegmentCacheStore();
    const readerStore = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(readerStore, "setItem");
    const state = serveStaleWhile(keyedStore);
    const routes = page(keyedStore, readerStore);

    const miss = await runRequest(routes.page, { session: "a" });
    state.stale = true;
    const stale = await runRequest(routes.page, { session: "a" });

    expect(miss.errors).toHaveLength(1);
    expect(miss.errors[0]).toContain(expected);
    expect(stale.errors).toEqual(miss.errors);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("a read the keyed dependency made through another loader is named as such, on its MISS and its HIT", async () => {
    const keyedStore = new MemorySegmentCacheStore();
    const readerStore = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(readerStore, "setItem");
    const session = cookieLoader("Session#L");
    const account = defineLoader("Account#L", async (ctx) => ({
      account: (await ctx.use(session)).session,
    }));
    const greeting = defineLoader("Greeting#L", async (ctx) => {
      const { account: name } = await ctx.use(account);
      return `hello ${name}`;
    });
    const routes = entryWith([
      cachedEntry(greeting, readerStore),
      cachedEntry(account, keyedStore, bySession),
    ]);

    const miss = await runRequest(routes, { session: "a" });
    const hit = await runRequest(routes, { session: "a" });

    expect(miss.errors).toHaveLength(1);
    expect(miss.errors[0]).toContain(
      'cookies() cannot be called inside loader "Session#L", which loader "Greeting#L" reads through another loader ("Account#L")',
    );
    expect(hit.errors).toEqual(miss.errors);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("a stale refresh of the dependency that reads cookies() does not mark the stale value it serves; the refreshed entry does", async () => {
    const keyedStore = new MemorySegmentCacheStore();
    const state = serveStaleWhile(keyedStore);
    // Keyed without identity: its first run reads no cookie, the refresh does.
    const profile = defineLoader("Profile#L", async () => ({
      session: profile.calls > 1 ? cookies().get("session")?.value : "anon",
    }));
    const greeting = defineLoader("ProfileGreeting#L", async (ctx) => {
      const { session } = await ctx.use(profile);
      // The background refresh settles before this fill checks its reads.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `hello ${session}`;
    });
    const profileEntry = cachedEntry(profile, keyedStore, {
      key: () => "profile",
    });
    const page = (readerStore: SegmentCacheStore) =>
      entryWith([cachedEntry(greeting, readerStore), profileEntry]);
    await runRequest(entryWith([profileEntry]));

    state.stale = true;
    const staleStore = new MemorySegmentCacheStore();
    const staleWrites = vi.spyOn(staleStore, "setItem");
    const stale = await runRequest(page(staleStore));
    state.stale = false;
    const hitStore = new MemorySegmentCacheStore();
    const hitWrites = vi.spyOn(hitStore, "setItem");
    const hit = await runRequest(page(hitStore));

    expect(profile.calls).toBe(2);
    expect(stale.errors).toEqual([]);
    expect(stale.values[0]).toBe("hello anon");
    expect(staleWrites).toHaveBeenCalledTimes(1);
    expect(hit.errors).toHaveLength(1);
    expect(hit.errors[0]).toContain(
      'cookies() cannot be called inside loader "Profile#L", which loader "ProfileGreeting#L" reads',
    );
    expect(hitWrites).not.toHaveBeenCalled();
  });

  it("a dependency keyed by what it reads, with no identity read, does not trip it", async () => {
    const catalogStore = new MemorySegmentCacheStore();
    const summaryStore = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(summaryStore, "setItem");
    const catalog = defineLoader("Catalog#L", async () => ({ items: 3 }));
    const summary = defineLoader("Summary#L", async (ctx) => {
      const { items } = await ctx.use(catalog);
      return `items ${items}`;
    });
    const catalogEntry = cachedEntry(catalog, catalogStore, {
      key: () => "catalog:v1",
    });
    await runRequest(entryWith([catalogEntry]));

    const { errors, values } = await runRequest(
      entryWith([cachedEntry(summary, summaryStore), catalogEntry]),
    );

    expect(errors).toEqual([]);
    expect(values).toEqual(["items 3", { items: 3 }]);
    expect(setItem).toHaveBeenCalledTimes(1);
  });
});

describe("a theme read (#971) in a loader with its own cache()", () => {
  let handlerCtx: HandlerContext<any, any> | undefined;
  const readFirst = async (ctx: HandlerContext<any, any>) => {
    handlerCtx = ctx;
  };
  const READS: Array<[string, () => unknown]> = [
    ["getRequestContext().theme", () => getRequestContext().theme],
    ["ctx.theme", () => handlerCtx!.theme],
  ];

  it.each(READS)(
    "%s without a key(): the fill fails like a cookies() read and stores nothing",
    async (surface, read) => {
      const store = new MemorySegmentCacheStore();
      const setItem = vi.spyOn(store, "setItem");
      const themed = defineLoader("ThemedLoader#L", async () => ({
        theme: read(),
      }));

      const { errors } = await runRequest(
        entryWith([cachedEntry(themed, store)]),
        { theme: "dark", readFirst },
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(
        `${surface} cannot be read inside loader "ThemedLoader#L", whose own cache() has no key()`,
      );
      expect(setItem).not.toHaveBeenCalled();
    },
  );

  it("with a key() that includes the theme, each theme stores its own entry", async () => {
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");
    const themed = defineLoader("ThemedLoader#L", async () => ({
      theme: getRequestContext().theme,
    }));
    const entry = entryWith([
      cachedEntry(themed, store, {
        key: () => `theme:${cookies().get("theme")?.value}`,
      }),
    ]);

    const dark = await runRequest(entry, { theme: "dark" });
    const light = await runRequest(entry, { theme: "light" });

    expect(dark.values).toEqual([{ theme: "dark" }]);
    expect(light.values).toEqual([{ theme: "light" }]);
    expect(setItem).toHaveBeenCalledTimes(2);
  });
});

describe("a bake-lane loader pinned on a PPR shell HIT", () => {
  it("carries no identity mark: an unkeyed reader runs it and checks that run", async () => {
    // Its keyed entry carries a mark: the MISS read the cookie.
    const pinnedStore = new MemorySegmentCacheStore();
    let personalize = true;
    const pinned = defineLoader("Pinned#L", async () => ({
      v: personalize ? cookies().get("session")?.value : "plain",
    }));
    const pinnedEntry = cachedEntry(pinned, pinnedStore, { key: () => "p" });
    await runRequest(entryWith([pinnedEntry]));
    personalize = false;

    // The HIT tail: the seed pins the loader's container (no body run).
    const readerStore = new MemorySegmentCacheStore();
    const readerWrites = vi.spyOn(readerStore, "setItem");
    const reader = defineLoader("PinReader#L", async (ctx) => {
      const { v } = await ctx.use(pinned);
      return `read ${v}`;
    });
    const bakeKey = "R0D0.localhost/account#Pinned";
    const reqCtx = newRequestContext("b");
    armLoaderTagSets(reqCtx);
    reqCtx._shellLoaderSeed = new Map([
      [bakeKey, { container: { v: "shell" }, holes: false, runs: false }],
    ]);
    const { pinnedValue, readerValue } = await runWithRequestContext(
      reqCtx,
      async () => {
        const url = new URL(reqCtx.request.url);
        const ctx = createHandlerContext(
          {},
          reqCtx.request,
          url.searchParams,
          url.pathname,
          url,
          {},
        );
        setupLoaderAccess(ctx, new Map());
        const pinnedValue = await resolveLoaderData(
          pinnedEntry,
          ctx,
          "/account",
          bakeKey,
        );
        const readerValue = await resolveLoaderData(
          cachedEntry(reader, readerStore),
          ctx,
          "/account",
        );
        await Promise.all(reqCtx._pendingBackgroundTasks ?? []);
        return { pinnedValue, readerValue };
      },
    );

    expect(pinnedValue).toEqual({ v: "shell" });
    // The reader ran the loader itself: that run read no cookie.
    expect(readerValue).toBe("read plain");
    expect(readerWrites).toHaveBeenCalledTimes(1);
    expect(pinned.calls).toBe(2);
  });
});

// Last: vi.resetModules() leaves a second copy of cache-tag.ts evaluated.
describe("a second evaluated copy of cache-tag.ts", () => {
  it("keeps the check on: its recorder shares the capture scope and the recorded reads", async () => {
    vi.resetModules();
    await import("../../../cache/cache-tag.js");
    const store = new MemorySegmentCacheStore();
    const setItem = vi.spyOn(store, "setItem");

    const { errors } = await runRequest(
      entryWith([cachedEntry(cookieLoader("Dup#L"), store)]),
    );

    expect(errors).toHaveLength(1);
    expect(setItem).not.toHaveBeenCalled();
  });
});
