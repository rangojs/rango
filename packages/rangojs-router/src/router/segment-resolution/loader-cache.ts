/**
 * Loader-Level Caching
 *
 * When a LoaderEntry has a cache config (set via loader(Fn, () => [cache({...})])),
 * this module wraps the loader execution with cache lookup/store using the
 * getItem()/setItem() methods on SegmentCacheStore.
 *
 * Cache key resolution (3-tier, matching CacheScope.resolveKey):
 *   1. options.key(requestCtx) — full override
 *   2. store.keyGenerator(requestCtx, defaultKey) — store-level modification
 *   3. loader:{loaderId}:{host}{pathname}:{sortedParams} — default
 *
 * Values are serialized via RSC Flight (serializeResult/deserializeResult),
 * supporting ReactNode, Promises, null, and all RSC-serializable types.
 *
 * On hit: returns cached data directly, skips loader execution.
 * On stale hit (SWR): returns stale data, schedules background revalidation.
 * On miss: executes loader, schedules non-blocking cache write.
 */

import type { LoaderEntry } from "../../server/context.js";
import type { HandlerContext, InternalHandlerContext } from "../../types.js";
import { INTERNAL_RANGO_DEBUG } from "../../internal-debug.js";
import {
  getRequestContext,
  _getRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { observePhase, PHASES } from "../instrument.js";
import { sortedRouteParams } from "../../cache/cache-key-utils.js";
import {
  resolveTtl,
  resolveSwrWindow,
  resolveCacheKey,
  resolveCacheStore,
  resolveTagsOption,
  DEFAULT_ROUTE_TTL,
} from "../../cache/cache-policy.js";
import { readThroughItem } from "../../cache/read-through-swr.js";
import {
  maskNestedContainerThenables,
  overlayLoaderContainer,
} from "./loader-snapshot.js";
import { recordRequestTags } from "../../cache/cache-tag.js";
import {
  isShellCaptureActive,
  createMaskedLoaderPromise,
} from "./loader-mask.js";
// Lazy-loaded to avoid pulling @vitejs/plugin-rsc/rsc into modules that
// import segment-resolution but never use loader caching.
let _serializeResult: typeof import("../../cache/segment-codec.js").serializeResult;
let _deserializeResult: typeof import("../../cache/segment-codec.js").deserializeResult;
async function getCodec() {
  if (!_serializeResult) {
    const mod = await import("../../cache/segment-codec.js");
    _serializeResult = mod.serializeResult;
    _deserializeResult = mod.deserializeResult;
  }
  return {
    serializeResult: _serializeResult,
    deserializeResult: _deserializeResult,
  };
}

function debugLoaderCacheLog(message: string): void {
  if (INTERNAL_RANGO_DEBUG) {
    console.log(message);
  }
}

function getDefaultLoaderCacheKey(
  loaderId: string,
  host: string,
  pathname: string,
  params: Record<string, string>,
): string {
  const paramStr = sortedRouteParams(params);
  const base = paramStr ? `${pathname}:${paramStr}` : pathname;
  return `loader:${loaderId}:${host}${base}`;
}

/**
 * Resolve cache key using the shared 3-tier priority.
 */
async function resolveLoaderKey(
  loaderEntry: LoaderEntry,
  store: import("../../cache/types.js").SegmentCacheStore,
  loaderId: string,
  pathname: string,
  params: Record<string, string>,
): Promise<string> {
  const options = loaderEntry.cache!.options;
  // The host is part of the loader cache identity, matching the route-level
  // cache (cache-scope getCacheKeyBase: `${host}${pathname}`) and "use cache"
  // (cache-runtime pushes ctx.url.host). Without it, a multi-tenant host router
  // serving the same pathname for different hosts would leak one host's cached
  // loader data to another.
  const host = getRequestContext()?.url?.host ?? "localhost";
  const defaultKey = getDefaultLoaderCacheKey(loaderId, host, pathname, params);
  if (options === false) return defaultKey;
  return resolveCacheKey(options.key, store, defaultKey, "LoaderCache");
}

/**
 * Resolve tags from cache options (static array or function).
 * Fails open: a thrown tag callback falls back to no tags rather than
 * aborting the request. Tags are additive metadata (not identity), so
 * a missing tag does not cause cache collisions.
 */
function resolveTags(loaderEntry: LoaderEntry): string[] | undefined {
  const options = loaderEntry.cache?.options;
  if (!options) return undefined;
  return resolveTagsOption(options.tags, getRequestContext(), "LoaderCache");
}

function getLoaderStore(
  loaderEntry: LoaderEntry,
): import("../../cache/types.js").SegmentCacheStore | null {
  const cacheConfig = loaderEntry.cache;
  if (!cacheConfig || cacheConfig.options === false) return null;
  return resolveCacheStore(cacheConfig.options.store);
}

/**
 * Resolve loader data with optional caching.
 *
 * When the LoaderEntry has no cache config, delegates directly to ctx.use(loader).
 * When cached, checks store first and stores on miss via waitUntil.
 *
 * Loader metering is NOT done here — it lives at the ctx.use execution funnel
 * (observePhase; see instrument.ts). A cache HIT returns without calling ctx.use,
 * so it emits no loader phase (the loader did not execute; the hit is only a
 * LoaderCache debug log).
 */
export function resolveLoaderData<TEnv>(
  loaderEntry: LoaderEntry,
  ctx: HandlerContext<any, TEnv>,
  pathname: string,
  bakeSegmentKey?: string | null,
): Promise<any> {
  // One ALS read serves the capture check, the record registration, and the
  // seed lookup — this runs for every loader on every request.
  const reqCtx = _getRequestContext();
  // PPR shell capture policy — gated here, the single funnel every loader
  // segment path routes through (fresh resolveLoaders, cache-hit
  // resolveLoadersOnly, revalidation resolveLoadersOnlyWithRevalidation).
  //
  // Two lanes (docs/design/loader-container-bake.md):
  // - LIVE lane (entry has renderable loading(); no `bakeSegmentKey`): never
  //   execute during capture. The slot gets a never-resolving promise so the
  //   LoaderBoundary postpones (a hole). See loader-mask.ts.
  // - BAKE lane (no renderable loading(); callers pass `bakeSegmentKey`):
  //   execute during capture exactly like axis 1 — the settled container bakes
  //   into the prelude, nested pending promises postpone at the consumer's own
  //   Suspense. The container promise is registered on the derived context so
  //   captureAndStoreShell pins it into the snapshot's loader family; on a
  //   shell HIT the recorded container is overlaid onto the fresh run so the
  //   payload matches the frozen prelude byte-for-byte.
  if (isShellCaptureActive(reqCtx)) {
    // Capture lane, per LOADER (not per entry):
    //
    // - `stream: "navigation"` (awaitBeforeFlush) — the BAKE lane. The flag's
    //   document promise is "this loader's data is in the HTML before first
    //   flush"; under ppr the pre-flush HTML IS the frozen prelude, so the
    //   loader executes at capture and its SETTLED return bakes into the
    //   shell. Nested-promise SHAPE stays the liveness declaration: nested
    //   thenables are masked so their subtrees postpone as holes (per-request
    //   material must be promise-shaped — the #692 cross-session scar). The
    //   masked container registers on _shellCaptureLoaderRecords: it holds
    //   the capture gate (bounded by ppr.captureTimeout) and pins into the
    //   shell snapshot, so a HIT tail replays the baked value and the
    //   hydration payload matches the frozen prelude byte-for-byte.
    // - Every other loader — LIVE unconditionally: masked with a
    //   never-resolving promise, postponed at its boundary (loading() or an
    //   inline Suspense), streamed fresh per request. A masked reader with NO
    //   boundary above it root-postpones and the <body> sanity gate refuses
    //   the shell (eternal-MISS warning) — the degrade for boundary-less ppr
    //   routes. A route whose loaders are ALL flagged therefore needs no
    //   loading() at all: nothing masks, the shell captures complete.
    if (loaderEntry.awaitBeforeFlush && bakeSegmentKey) {
      const containerPromise = executeLoaderData(loaderEntry, ctx, pathname);
      // Pre-attach a no-op catch: a bake-lane rejection during capture must
      // surface through the drain's refusal (and the wrapper's error
      // boundary), never as an unhandled rejection that can kill the worker
      // before the drain probes this record.
      containerPromise.catch(() => {});
      const maskedPromise = containerPromise.then((container: unknown) =>
        maskNestedContainerThenables(container),
      );
      maskedPromise.catch(() => {});
      reqCtx?._shellCaptureLoaderRecords?.set(bakeSegmentKey, maskedPromise);
      return maskedPromise;
    }
    return createMaskedLoaderPromise();
  }

  if (bakeSegmentKey) {
    const seed = reqCtx?._shellLoaderSeed;
    if (seed && seed.has(bakeSegmentKey)) {
      const recorded = seed.get(bakeSegmentKey)!;
      if (!recorded.holes) {
        // Pin-first (hole-free record): the pinned container is what the
        // payload serves either way (recorded paths win wholesale), so
        // resolve it immediately instead of gating on the fresh run's
        // latency — a slow bake-lane loader body otherwise stalls the HIT
        // tail for values that get discarded. The fresh run still executes
        // for its side effects and cache read-through writes, lifetime-
        // extended so the runtime cannot cancel it when the stream closes
        // first; its rejection is swallowed here (the payload already
        // matches the prelude, which a fresh error value never could).
        //
        // CONTRACT (deliberate divergence from the gated overlay's
        // fresh-only-keys passthrough): a hole-free pin serves the pinned
        // SHAPE wholesale — a key the fresh run adds mid-TTL is dropped.
        // It could never render server-side anyway: no hole was postponed
        // for it at capture, so the prelude froze the without-that-field
        // branch and the resume pass has nothing to fill; passing it
        // through only made the hydration payload disagree with the frozen
        // prelude (client-side mismatch repair — the divergence class the
        // snapshot exists to prevent). A field that is per-request must be
        // promise-shaped at capture (masked -> hole marker -> holes: 1 ->
        // the gated path below, which preserves fresh-only passthrough) or
        // live behind loading(). Anything else is uncached nondeterminism
        // in shell material — the documented drift residual.
        const fresh = executeLoaderData(loaderEntry, ctx, pathname);
        fresh.catch(() => {});
        reqCtx?.executionContext?.waitUntil?.(fresh);
        return Promise.resolve(
          overlayLoaderContainer(undefined, recorded.container),
        );
      }
      // Hole-carrying record: run fresh (only the loader body can mint the
      // live nested promises), then pin the recorded paths over it. A fresh
      // REJECTION here skips the overlay and flows to the per-loader error
      // boundary — the payload then diverges from the prelude (same residual
      // class as uncached nondeterminism in shell material).
      return executeLoaderData(loaderEntry, ctx, pathname).then(
        (fresh: unknown) => overlayLoaderContainer(fresh, recorded.container),
      );
    }
  }

  return executeLoaderData(loaderEntry, ctx, pathname);
}

/** The pre-policy loader execution: cache read-through or plain ctx.use. */
function executeLoaderData<TEnv>(
  loaderEntry: LoaderEntry,
  ctx: HandlerContext<any, TEnv>,
  pathname: string,
): Promise<any> {
  const cacheConfig = loaderEntry.cache;

  // No cache config or disabled — run fresh (zero overhead path)
  if (!cacheConfig || cacheConfig.options === false) {
    return ctx.use(loaderEntry.loader);
  }

  const store = getLoaderStore(loaderEntry);
  if (!store?.getItem || !store?.setItem) {
    return ctx.use(loaderEntry.loader);
  }

  // Evaluate runtime condition if provided
  const options = cacheConfig.options;
  if (options.condition) {
    const requestCtx = getRequestContext();
    if (requestCtx && !options.condition(requestCtx)) {
      return ctx.use(loaderEntry.loader);
    }
  }

  const loaderId = loaderEntry.loader.$$id;

  // A handler that later awaits this same loader via ctx.use(loader) must get
  // THIS memoized promise, not a fresh execution. Rather than rebind ctx.use
  // once per cached loader (O(N) chained wrappers + a synchronous
  // capture-before-overwrite invariant), install a single stable interceptor on
  // the first cached loader that consults a per-ctx override table, then just
  // prime the table for each subsequent cached loader. The captured pre-
  // interceptor `originalUse` (whatever setup mode installed it) runs the
  // cache-miss execute, so a loader never awaits its own in-flight promise.
  const internal = ctx as InternalHandlerContext<any, TEnv>;
  let overrides = internal._loaderCacheOverrides;
  if (!overrides) {
    overrides = internal._loaderCacheOverrides = new Map();
    const originalUse = ctx.use;
    internal._loaderCacheOriginalUse = originalUse;
    ctx.use = ((item: any) => {
      const cached = overrides!.get(item?.$$id);
      if (cached) return cached;
      return originalUse(item);
    }) as typeof ctx.use;
  }
  const runMiss = internal._loaderCacheOriginalUse!;

  // Dedup the cache read-through across repeated resolutions of the SAME
  // loaderId in one request. An orphan layout with parallel slots inherits its
  // parent route's loaders, so resolveOrphanLayout (fresh.ts) re-resolves the
  // parent's loaders under a different shortCode — calling resolveLoaderData
  // again for the same loaderId. The cache key (loader:{loaderId}:{host}
  // {pathname}:{sortedParams}) does not include the shortCode and ctx/params
  // are identical, so both resolutions produce the same data. Reuse the already
  // in-flight dataPromise instead of issuing a second getItem/setItem (e.g. a
  // second KV round-trip) for one logical cached loader. The shortCode only
  // affects the emitted segmentId in resolveLoaders, not the cached value.
  const existing = overrides.get(loaderId);
  if (existing) return existing;

  // Compute ttl/swr/tags only AFTER the dedup short-circuit: a deduped second
  // resolution of the same loaderId (the orphan-layout inheritance path) must
  // not re-run the user tags() callback. These values are only consumed inside
  // the read-through below, so they belong here, past the dedup gate.
  const ttl = resolveTtl(options.ttl, store.defaults, DEFAULT_ROUTE_TTL);
  const swrWindow = resolveSwrWindow(options.swr, store.defaults);
  const swr = swrWindow || undefined;
  const tags = resolveTags(loaderEntry);
  recordRequestTags(tags);

  const dataPromise = (async () => {
    const codec = await getCodec();
    const key = await resolveLoaderKey(
      loaderEntry,
      store,
      loaderId,
      pathname,
      ctx.params,
    );

    // Capture the request context up front (foreground, ALS present) so the
    // background stale revalidation can re-establish it. On workerd a waitUntil
    // task runs detached from the request's I/O context, so a loader body that
    // reads the ambient getRequestContext() would otherwise throw "called
    // outside of a request context" and the revalidation would fail silently.
    // The wrap is applied via wrapBackground (background path only); the
    // foreground miss runs execute() directly since its context is present.
    const requestCtxForExecute = getRequestContext();
    return readThroughItem({
      getItem: (k) => store.getItem!(k),
      setItem: (k, v, o) => store.setItem!(k, v, o),
      key,
      execute: () => runMiss(loaderEntry.loader),
      // The rango.background span (kind=loader-revalidation) wraps the WHOLE
      // stale revalidation — the re-execution AND the serialize/setItem write
      // (read-through-swr routes the full task through wrapBackground) — so
      // the loader's rango.loader span, its fetch/KV platform spans, and the
      // store write all nest under one explanatory parent instead of dangling
      // under the ended foreground phases. Inside runWithRequestContext so
      // observePhase can read tracing on workerd (ALS detaches in waitUntil).
      wrapBackground: (run) =>
        runWithRequestContext(requestCtxForExecute, () =>
          observePhase(PHASES.background("loader-revalidation"), run),
        ),
      serialize: (d) => codec.serializeResult(d),
      deserialize: (v) => codec.deserializeResult(v),
      storeOptions: { ttl, swr, tags },
      onHit: () => debugLoaderCacheLog(`[LoaderCache] HIT: ${key}`),
      onStale: () => debugLoaderCacheLog(`[LoaderCache] STALE: ${key}`),
      onMiss: () => debugLoaderCacheLog(`[LoaderCache] MISS: ${key}`),
      onCached: () => debugLoaderCacheLog(`[LoaderCache] Cached: ${key}`),
      host: requestCtxForExecute,
    });
  })();

  overrides.set(loaderId, dataPromise);

  return dataPromise;
}
