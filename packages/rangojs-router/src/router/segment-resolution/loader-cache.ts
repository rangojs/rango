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
 *
 * Identity (#972): without a key() or a store keyGenerator the entry is
 * shared across users, so a fill whose execution recorded a request-identity
 * read fails and is not stored, whoever started that execution
 * (server/context.ts recordLoaderIdentityRead).
 *
 * Handle pushes (`ctx.use(Handle)(...)` in the loader body) are a side effect
 * the HIT must reproduce: the MISS records the pushes of the body and of the
 * loaders it awaits via ctx.use into the entry's `handles` blob (the
 * "use cache" capture/encode), and every HIT — stale included — replays
 * them, each loader's pushes at most once per request (a dependency another
 * reader already ran keeps its live pushes). See replayLoaderHandles.
 *
 * Tags too (#964): the entry stores its cache() tags plus every tag its
 * execution recorded, those of the loader values it read included
 * (cache-tag.ts "Recorded-tag sets"), so updateTag() of any of them drops it.
 * Every HIT records the stored tags through the loader's tag owner
 * (recordLoaderTags), so a route cache() record, PPR shell or document built
 * over the HIT carries them, and a loader that reads this one takes them on.
 * Once the binding started, a loader body's ctx.use of it gets the same
 * dataPromise as a handler read (createLoaderExecutor's useLoader); a stale
 * refresh does not (setupLoaderAccess _runLoaderIsolated).
 */

import {
  getCurrentLoaderBodyId,
  isInsideLoaderBody,
  loaderCacheIdentityError,
  type EntryData,
  type LoaderEntry,
  type LoaderIdentityRead,
} from "../../server/context.js";
import type { HandlerContext, InternalHandlerContext } from "../../types.js";
import type { HandleStore } from "../../server/handle-store.js";
import type { CacheItemResult } from "../../cache/types.js";
import {
  startHandleCapture,
  type HandleCapture,
} from "../../cache/handle-capture.js";
import { encodeHandles, decodeHandles } from "../../cache/handle-snapshot.js";
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
  executionStart,
  predatesInvalidation,
} from "../../cache/tag-invalidation.js";
import {
  maskNestedContainerThenables,
  overlayLoaderContainer,
} from "./loader-snapshot.js";
import {
  SHELL_BAKE_TAG_OWNER,
  captureRecordedTags,
  earliestRecordedStart,
  flattenRecordedTags,
  linkLoaderTags,
  linkLoaderTagsTo,
  linkRecordedTags,
  markIdentityRead,
  markTagSetStart,
  readValueTags,
  recordedIdentityRead,
  recordLoaderTags,
  tagLoaderValue,
} from "../../cache/cache-tag.js";
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
 * Resolve cache key using the shared 3-tier priority. `declared`: a key() or
 * store keyGenerator produced it, so it can carry request identity (#972).
 */
async function resolveLoaderKey(
  loaderEntry: LoaderEntry,
  store: import("../../cache/types.js").SegmentCacheStore,
  loaderId: string,
  pathname: string,
  params: Record<string, string>,
): Promise<{ key: string; declared: boolean }> {
  const options = loaderEntry.cache!.options;
  // The host is part of the loader cache identity, matching the route-level
  // cache (cache-scope getCacheKeyBase: `${host}${pathname}`) and "use cache"
  // (cache-runtime pushes ctx.url.host). Without it, a multi-tenant host router
  // serving the same pathname for different hosts would leak one host's cached
  // loader data to another.
  const host = getRequestContext()?.url?.host ?? "localhost";
  const defaultKey = getDefaultLoaderCacheKey(loaderId, host, pathname, params);
  if (options === false) return { key: defaultKey, declared: false };
  return {
    key: await resolveCacheKey(options.key, store, defaultKey),
    declared: Boolean(options.key || store.keyGenerator),
  };
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

const bindsLoaderCacheMemo = new WeakMap<EntryData, boolean>();

const hasLoaderCache = (loaders: readonly LoaderEntry[] | undefined) =>
  loaders?.some((l) => l.cache !== undefined && l.cache.options !== false) ??
  false;

function entryBindsLoaderCache(entry: EntryData): boolean {
  let binds = bindsLoaderCacheMemo.get(entry);
  if (binds === undefined) {
    binds =
      hasLoaderCache(entry.loader) ||
      (entry.intercept?.some((i) => hasLoaderCache(i.loader)) ?? false) ||
      (entry.layout?.some(entryBindsLoaderCache) ?? false) ||
      Object.values(entry.parallel ?? {}).some(
        (p) => p !== undefined && entryBindsLoaderCache(p),
      );
    bindsLoaderCacheMemo.set(entry, binds);
  }
  return binds;
}

/**
 * Whether a request over the matched chain `entries` resolves a loader bound
 * with its own cache(): on a chain entry, or on its parallel slots, orphan
 * layouts or intercepts. The match arms the per-execution loader tag sets on
 * it (cache-tag.ts armLoaderTagSets), before any loader starts, so a
 * dependency the handler or another binding starts first still records.
 * Memoized per entry.
 */
export function bindsLoaderCache(entries: readonly EntryData[]): boolean {
  return entries.some(entryBindsLoaderCache);
}

function getLoaderStore(
  loaderEntry: LoaderEntry,
): import("../../cache/types.js").SegmentCacheStore | null {
  const cacheConfig = loaderEntry.cache;
  if (!cacheConfig || cacheConfig.options === false) return null;
  return resolveCacheStore(cacheConfig.options.store);
}

/**
 * Replay a loader-cache entry's recorded handle pushes on a HIT.
 *
 * Pushed to the CURRENT owning segment (the recorded ids are the MISS
 * request's), in recorded order.
 *
 * One delivery per loader per request: each recorded group is one loader
 * body's pushes (recordOwnerKey), and `claim` (setupLoaderAccess
 * _claimLoaderPushes) skips a group whose loader already ran in this request
 * — a sibling loader or the handler read the dependency, and its live pushes
 * stand — or that another replay delivered. A claimed loader that runs later
 * (loaders stay live) replaces its replayed values with its live pushes
 * (HandleStore.pushReplayed).
 *
 * Deliberately NOT inside the loader's body scope: a stale hit's background
 * revalidation of the same loader can be running with a diverting capture
 * keyed on that body scope (executeLoaderData), which would swallow the
 * replay; and the store reads the body scope to tell a live push from a
 * replayed one.
 * A PPR shell capture records the replayed pushes under this loader (its
 * push funnel reads the pushReplayed owner, shell-capture.ts), so a shell
 * HIT restores them owned: the claim above then skips this replay when the
 * loader runs on that HIT, and its live pushes replace the restored ones.
 */
async function replayLoaderHandles(
  encoded: string,
  handleStore: HandleStore,
  segmentId: string,
  claim: ((loaderId: string) => boolean) | undefined,
): Promise<void> {
  const recorded = await decodeHandles(encoded);
  if (!recorded) return;
  const delivers = new Map<string, boolean>();
  for (const key in recorded) {
    const owner = key.slice(key.indexOf(":") + 1);
    let deliver = delivers.get(owner);
    if (deliver === undefined) {
      deliver = claim ? claim(owner) : true;
      delivers.set(owner, deliver);
    }
    if (!deliver) continue;
    for (const [handleName, values] of Object.entries(recorded[key])) {
      for (const value of values) {
        handleStore.pushReplayed(handleName, segmentId, value, owner);
      }
    }
  }
}

/**
 * Identity mark (#972): a declared-key entry whose MISS recorded a
 * request-identity read stores that read ahead of its payload. A HIT skips the
 * body, so without the mark an unkeyed loader reading this value on a HIT
 * would store another user's data. The value string is this module's own
 * (serialize/deserialize below), so the mark needs no store support; Flight
 * and JSON payloads never start with "~".
 */
const IDENTITY_MARK = "~identity:";

function markIdentity(
  value: string,
  read: LoaderIdentityRead | undefined,
): string {
  return read ? `${IDENTITY_MARK}${JSON.stringify(read)}\n${value}` : value;
}

function unmarkIdentity(value: string): {
  read: LoaderIdentityRead | undefined;
  payload: string;
} {
  if (!value.startsWith(IDENTITY_MARK))
    return { read: undefined, payload: value };
  const end = value.indexOf("\n");
  return {
    read: JSON.parse(value.slice(IDENTITY_MARK.length, end)),
    payload: value.slice(end + 1),
  };
}

/**
 * Record key for the MISS capture: run-length groups by the innermost loader
 * body, `${seq}:${loaderId}` — the cached loader or a dependency it awaits
 * via ctx.use. Groups keep push order across bodies; the owner lets the
 * replay deliver each loader's pushes at most once per request.
 */
function recordOwnerKey(cachedLoaderId: string): () => string {
  let seq = 0;
  let owner: string | undefined;
  return () => {
    const current = getCurrentLoaderBodyId() ?? cachedLoaderId;
    if (current !== owner) {
      owner = current;
      seq++;
    }
    return `${seq}:${current}`;
  };
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
 *
 * PPR loader lane rule — the canonical source statement; other sites point
 * here (consumer docs: skills/ppr/SKILL.md "The loader lane rule";
 * docs/design/loader-container-bake.md). This is the single funnel every
 * loader segment path routes through (fresh resolveLoaders, cache-hit
 * resolveLoadersOnly, revalidation resolveLoadersOnlyWithRevalidation, and
 * intercept loaders in intercept-resolution.ts, which pass no bake key and
 * never run under a shell capture), so the lane is decided here, per LOADER,
 * never by the entry's loading():
 *
 * - BAKE lane: `loader(Def, { ssr: false })` (LoaderEntry `bake`: the
 *   caller passes a `bakeSegmentKey` for it on document and navigation
 *   evaluations alike; a capture, a document evaluation, also has
 *   awaitBeforeFlush). The loader EXECUTES at capture (the
 *   flag's "data in the HTML before first flush" maps to the frozen prelude)
 *   and its settled non-promise data bakes into the shell. Promises nested in
 *   plain objects, arrays and JSX props are masked (mask-nested.ts) and stay
 *   live holes at the consumer's own Suspense — per-request material must be
 *   promise-shaped (the #692 cross-session scar). The masked container
 *   registers on `_shellCaptureLoaderRecords`: it holds the capture gate
 *   (bounded by `ppr.captureTimeout`) and pins into the snapshot's loader
 *   family, and on a HIT the recorded container is overlaid onto the fresh
 *   run (below) so the payload matches the frozen prelude outside the holes.
 *   A server-component element holding a promise is a hole as a whole, so its
 *   other props come from the fresh run (loader-snapshot.ts
 *   elideLoaderContainer). cookies()/headers() in its body (nested promise
 *   bodies included) trip the capture guard.
 * - LIVE lane: every other loader, whatever its entry's loading(). Never
 *   executes at capture: the slot gets a never-resolving promise
 *   (loader-mask.ts) and postpones at the reader's boundary — loading() or an
 *   inline Suspense — then streams fresh per request. A masked read with NO
 *   boundary above it root-postpones and the <body> sanity gate refuses the
 *   shell (eternal-MISS warning). A route whose loaders are ALL `ssr: false`
 *   needs no loading(): nothing masks.
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
  if (isShellCaptureActive(reqCtx)) {
    // Lane rule: see this function's JSDoc. Flagged = bake, else masked.
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
      // Its data bakes into the shell, so its tags tag the shell.
      linkLoaderTagsTo(SHELL_BAKE_TAG_OWNER, loaderEntry.loader.$$id, reqCtx);
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
        // payload serves (recorded paths win wholesale), resolved
        // immediately. The body does not run: a HIT is rendered from the
        // shell, like the handlers it replays, and the loader's settled
        // pushes (and those of loaders it awaits) are restored from the
        // record. Only a record whose capture saw a push it could not keep
        // (`runs`) still runs the body, in the background, lifetime-extended
        // so the runtime cannot cancel it when the stream closes first; its
        // rejection is swallowed (the payload already matches the prelude,
        // which a fresh error value never could).
        //
        // CONTRACT (deliberate divergence from the gated overlay's
        // fresh-only-keys passthrough): a hole-free pin serves the pinned
        // SHAPE wholesale. A field the body would return now had no hole
        // postponed for it at capture, so the prelude froze the
        // without-that-field branch and the resume pass has nothing to
        // fill. A field that is per-request must be promise-shaped at
        // capture (masked -> hole marker -> holes: 1 -> the gated path
        // below, which preserves fresh-only passthrough) or live behind
        // loading(). Anything else is uncached nondeterminism in shell
        // material — the documented drift residual.
        if (recorded.runs) {
          const fresh = executeLoaderData(loaderEntry, ctx, pathname);
          fresh.catch(() => {});
          reqCtx?.executionContext?.waitUntil?.(fresh);
        }
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
      if (cached) {
        // A read is a consumption (#957, #964): see createLoaderExecutor's
        // useLoader.
        linkLoaderTags(item.$$id);
        readValueTags(cached);
        return cached;
      }
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
  recordLoaderTags(loaderId, tags);
  // The per-execution loader tag sets were armed before any loader ran: by
  // the match (match-api.ts, bindsLoaderCache), or by runLoader.
  // An execution of this loader outside the binding (a reader started it
  // first, a stale refresh) answers for the cache() tags too.
  if (tags && tags.length > 0) {
    internal._bindLoaderCacheTags?.(loaderId, new Set(tags));
  }

  // Handle pushes: the store and the owning segment are read synchronously
  // at kickoff, as createLoaderExecutor does for the body's own pushes.
  const handleStore = _getRequestContext()?._handleStore;
  const owningSegmentId = internal._currentSegmentId;
  // Record only pushes from THIS loader's body and the loaders it awaits via
  // ctx.use: the handler and sibling loaders push into the same store
  // concurrently. A dependency can still run on a HIT for another reader
  // (memoized per request); the replay's claim keeps its pushes to one copy.
  const isOwnBodyPush = () => isInsideLoaderBody(loaderId);
  // What a reader of this value takes on (tagLoaderValue below,
  // readValueTags): the cache() tags, plus the entry's tags on a HIT or the
  // execution's on a MISS. A HIT's value is as old as its lookup: a cached
  // reader gates its own write from here at the latest (#977).
  const valueTags = new Set(tags);
  markTagSetStart(valueTags, executionStart());

  const dataPromise = (async () => {
    const codec = await getCodec();
    const { key, declared } = await resolveLoaderKey(
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

    // One readThroughItem call runs at most one execution — the foreground
    // MISS or the background stale revalidation (flagged by wrapBackground)
    // — so one handle capture and one tag set serve the setItem after it.
    // The entry's tags: its cache() tags plus what the execution recorded.
    let capture: HandleCapture | undefined;
    const bodyTags = new Set(tags);
    let revalidating = false;
    let hitHandles: string | undefined;
    const onCachedRead = (label: string, cached: CacheItemResult) => {
      hitHandles = cached.handles;
      const { read } = unmarkIdentity(cached.value);
      if (read) markIdentityRead(valueTags, read);
      recordLoaderTags(loaderId, cached.tags);
      for (const tag of cached.tags ?? []) valueTags.add(tag);
      debugLoaderCacheLog(`[LoaderCache] ${label}: ${key}`);
    };
    const runBody = async (): Promise<any> => {
      // A stale-hit revalidation runs on its own executor: it diverts its
      // pushes (below), so sharing the page's memoized run of a dependency
      // would take that dependency's pushes off the page.
      const run = (revalidating && internal._runLoaderIsolated) || runMiss;
      if (!handleStore) return run(loaderEntry.loader);
      // A stale-hit revalidation diverts the body's pushes: the foreground
      // already replayed the stale entry's, so the fresh ones belong only to
      // the refreshed entry (not a duplicate in the live response).
      const c = startHandleCapture(handleStore, {
        accept: isOwnBodyPush,
        divert: revalidating,
        key: recordOwnerKey(loaderId),
      });
      capture = c.capture;
      try {
        return await run(loaderEntry.loader);
      } finally {
        c.stop();
      }
    };
    // #972: the execution's identity reads, and those of the loader values it
    // read, are on the bodyTags links whoever started them. With an undeclared
    // key one fails the fill (the MISS or the stale refresh); one that settles
    // after the value (a nested promise, a pending handle push) skips the write
    // instead. With a declared key it is stored as the entry's identity mark
    // for the HITs, as this loader's readers see it (through this loader when
    // another made it), and a foreground execution marks the value it serves.
    // A stale refresh does not: the page is served the stale entry, which its
    // own mark (or its lack) describes.
    const identityRead = (): LoaderIdentityRead | undefined => {
      const read = recordedIdentityRead(bodyTags);
      if (!read) return undefined;
      if (!declared) throw loaderCacheIdentityError(read, loaderId);
      const seen =
        read.bodyId === undefined || read.bodyId === loaderId
          ? { ...read, bodyId: loaderId, via: undefined }
          : { ...read, via: loaderId };
      if (!revalidating) markIdentityRead(valueTags, seen);
      return seen;
    };

    // Flight encodes a rejected promise in the value or a handle push as an
    // error row and completes normally. setItem runs after serialize and
    // throws instead of storing it, into readThroughItem's cache-write /
    // stale-revalidation report; a stale entry keeps serving.
    const flightErrors: unknown[] = [];
    const onFlightError = (error: unknown): void => {
      flightErrors.push(error);
    };

    const data = await readThroughItem({
      getItem: (k) => store.getItem!(k),
      // Handles ride the entry like "use cache" (encodeHandles: Flight, pending
      // pushes awaited up to its timeout, the whole blob dropped on a timeout
      // or a thrown encode). Encoded here, inside the deferred write, so a
      // MISS response never waits on it.
      setItem: (k, v, o) =>
        captureRecordedTags(bodyTags, async () => {
          const handles = capture
            ? await encodeHandles(capture.data, onFlightError)
            : "";
          if (flightErrors.length > 0) throw flightErrors[0];
          // After the handle encode: it settles pending pushes, which can read.
          const read = identityRead();
          const entryTags = [...flattenRecordedTags(bodyTags)];
          // One of the entry's tags was invalidated after the value's oldest
          // part started (#977): this execution, or the run of this loader or
          // of a dependency another reader started earlier. Written now, a
          // value that may predate it would outlive it. Skip the write; the
          // next read runs the body.
          const start = earliestRecordedStart(bodyTags);
          if (start && (await predatesInvalidation(store, entryTags, start))) {
            return;
          }
          await store.setItem!(k, markIdentity(v, read), {
            ...o,
            tags: entryTags.length > 0 ? entryTags : undefined,
            ...(handles ? { handles } : {}),
          });
        }),
      key,
      execute: async () => {
        markTagSetStart(bodyTags, executionStart());
        const value = await captureRecordedTags(bodyTags, runBody);
        identityRead();
        return value;
      },
      // The rango.background span (kind=loader-revalidation) wraps the WHOLE
      // stale revalidation — the re-execution AND the serialize/setItem write
      // (read-through-swr routes the full task through wrapBackground) — so
      // the loader's rango.loader span, its fetch/KV platform spans, and the
      // store write all nest under one explanatory parent instead of dangling
      // under the ended foreground phases. Inside runWithRequestContext so
      // observePhase can read tracing on workerd (ALS detaches in waitUntil).
      wrapBackground: (run) => {
        revalidating = true;
        return runWithRequestContext(requestCtxForExecute, () =>
          observePhase(PHASES.background("loader-revalidation"), run),
        );
      },
      serialize: (d) =>
        captureRecordedTags(bodyTags, () =>
          codec.serializeResult(d, onFlightError),
        ),
      deserialize: (v) => codec.deserializeResult(unmarkIdentity(v).payload),
      storeOptions: { ttl, swr, tags },
      onHit: (cached) => onCachedRead("HIT", cached),
      onStale: (cached) => onCachedRead("STALE", cached),
      onMiss: () => {
        linkRecordedTags(valueTags, bodyTags);
        debugLoaderCacheLog(`[LoaderCache] MISS: ${key}`);
      },
      onCached: () => debugLoaderCacheLog(`[LoaderCache] Cached: ${key}`),
      host: requestCtxForExecute,
    });

    // An entry written before handles were recorded has none: no replay.
    if (hitHandles && handleStore && owningSegmentId) {
      await replayLoaderHandles(
        hitHandles,
        handleStore,
        owningSegmentId,
        internal._claimLoaderPushes,
      );
    }
    return data;
  })();

  // Keep the store open for the replay: a HIT runs no loader body, so nothing
  // else holds the auxiliary lane while getItem/decode are in flight, and a
  // push after full drain throws LateHandlePushError.
  handleStore?.trackAuxiliary(dataPromise);

  tagLoaderValue(dataPromise, valueTags);
  overrides.set(loaderId, dataPromise);

  return dataPromise;
}
