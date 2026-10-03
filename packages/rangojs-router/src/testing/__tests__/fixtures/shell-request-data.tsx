// Data and harness for the serve-shell-request*.rsc-test.tsx files. Every
// value carries the source generation it was computed from, so a value the
// shell captured is visibly different from one read after the source moved
// on. getProduct is a "use cache" function (wrapped by
// rangoUseCacheTransform() in vitest.rsc.config.ts) that tags its entry with
// its product.
import { vi } from "vitest";
import { cacheTag } from "../../../cache/cache-tag.js";
import {
  MemorySegmentCacheStore,
  type SegmentCacheStore,
} from "../../../cache/index.js";
import {
  createHandle,
  createLoader,
  type Handle,
  type LoaderContext,
  type LoaderDefinition,
} from "../../../index.rsc.js";
import {
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../../flight.entry.js";

export const source: { generation: number } = { generation: 1 };

type ShellRouter = Parameters<typeof serveShellRequest>[0];

/** A router and a store, and `serve` bound to both. */
export interface ShellHarness<
  R extends ShellRouter,
  S extends SegmentCacheStore,
> {
  router: R;
  cacheStore: S;
  serve(
    url: string,
    extra?: Omit<ServeShellRequestOptions, "cacheStore">,
  ): Promise<ServeShellRequestResult>;
  /** Item reads under `prefix` miss while `fn` runs: that entry refills. */
  withItemMiss<T>(prefix: string, fn: () => Promise<T>): Promise<T>;
  /** `loader:` reads miss while `fn` runs: a cached loader refills its entry. */
  withLoaderMiss<T>(fn: () => Promise<T>): Promise<T>;
}

export function shellHarness<
  R extends ShellRouter,
  S extends SegmentCacheStore = MemorySegmentCacheStore,
>(router: R, store?: S): ShellHarness<R, S> {
  const cacheStore = store ?? (new MemorySegmentCacheStore() as unknown as S);
  const withItemMiss = async <T,>(
    prefix: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const getItem = cacheStore.getItem!.bind(cacheStore);
    const spy = vi
      .spyOn(cacheStore as SegmentCacheStore, "getItem")
      .mockImplementation(async (key) =>
        key.startsWith(prefix) ? null : getItem(key),
      );
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  };
  return {
    router,
    cacheStore,
    serve: (url, extra = {}) =>
      serveShellRequest(router, url, { cacheStore, ...extra }),
    withItemMiss,
    withLoaderMiss: (fn) => withItemMiss("loader:", fn),
  };
}

export async function getProduct(id: string): Promise<string> {
  "use cache";
  cacheTag(`product:${id}`);
  return `product-${id}@g${source.generation}`;
}

/** Read by a layout (the shell) and a loader under loading() (a hole). */
export async function getStamp(): Promise<string> {
  "use cache";
  return `stamp@g${source.generation}`;
}

/** A handle only CachedDepLoader pushes to. */
const DepNotes = createHandle<string>();

/** Awaited inside readCachedDep: its push rides that entry, owned by it. */
const CachedDepLoader = createLoader(async (ctx) => {
  ctx.use(DepNotes)(`dep-note@g${source.generation}`);
  return { dep: `dep@g${source.generation}` };
});

/**
 * A "use cache" function that awaits a loader: on a hit it replays the
 * loader's push inside the caller's loader body.
 */
export async function readCachedDep(ctx: LoaderContext): Promise<string> {
  "use cache";
  const { dep } = await ctx.use(CachedDepLoader);
  return dep;
}

/**
 * A promise-carrying bake-lane loader (it runs on a HIT and on a navigation
 * replay) whose body reads a "use cache" function that awaits a loader: the
 * entry replays that loader's push inside this body.
 */
export const OuterDepLoader: LoaderDefinition<{
  outer: string;
  later: Promise<string>;
}> = createLoader(async (ctx) => ({
  outer: await readCachedDep(ctx),
  later: Promise.resolve("outer-later"),
}));

/** A handle only the two loaders below push to. */
const BakeNotes = createHandle<string>();

/** Body runs of DeferredOwnedLoader, across the tests of one file. */
export const deferredOwnedRuns: { body: number } = { body: 0 };

/**
 * A promise-free bake-lane loader, registered with its own cache(), that
 * pushes a settled note and a deferred one. The shell's record keeps only
 * the settled push, so the loader's pin asks for a run on a HIT (`runs`).
 */
export const DeferredOwnedLoader: LoaderDefinition<{
  deferredOwned: string;
}> = createLoader(async (ctx) => {
  deferredOwnedRuns.body += 1;
  const run = deferredOwnedRuns.body;
  ctx.use(BakeNotes)(`settled-note-${run}`);
  ctx.use(BakeNotes)(Promise.resolve(`deferred-note-${run}`));
  return { deferredOwned: `deferred-owned-run-${run}` };
});

/** A promise-carrying bake-lane loader that pushes at capture only. */
export const OnceNotedBakeLoader: LoaderDefinition<{
  once: string;
  later: Promise<string>;
}> = createLoader(async (ctx) => {
  if (source.generation === 1) {
    ctx.use(BakeNotes)(`once-note@g${source.generation}`);
  }
  return {
    once: `once@g${source.generation}`,
    later: Promise.resolve("once-later"),
  };
});

/** A handle only RecaptureLiveLoader pushes to. */
export const RecaptureNotes: Handle<string> = createHandle<string>();

/** Registered live on /recapture-live; readRecaptureLive awaits it too. */
export const RecaptureLiveLoader: LoaderDefinition<{
  recaptureLive: string;
}> = createLoader(async (ctx) => {
  ctx.use(RecaptureNotes)(`recapture-note@g${source.generation}`);
  return { recaptureLive: `recapture-live@g${source.generation}` };
});

/**
 * A "use cache" function that awaits the live loader. Called only during a
 * capture, where the live loader is masked, so its entry records the live
 * loader's push; a recapture's hit replays it inside the caller's body.
 */
export async function readRecaptureLive(ctx: LoaderContext): Promise<string> {
  "use cache";
  const { recaptureLive } = await ctx.use(RecaptureLiveLoader);
  return recaptureLive;
}
