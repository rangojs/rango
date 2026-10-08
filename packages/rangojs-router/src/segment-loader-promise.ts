import type { ResolvedSegment } from "./types.js";
import { INTERNAL_RANGO_DEBUG } from "./internal-debug.js";

/**
 * Browser: a boundary is handed the settled value. React treats a promise as
 * fulfilled only after it has read it, and a boundary on screen handed a
 * promise it has not read, in a render that cannot wait, shows its fallback.
 * So a cache entry records its array once the aggregate fulfils and later
 * calls return that same array; until then (and when it rejects) they return
 * the promise. A boundary with no loaders gets one shared empty array.
 *
 * Server: a fresh promise per call, so Suspense emits the fallback in the
 * streamed HTML. A shared resolved promise would carry React's `.status`
 * across requests and skip it.
 *
 * Entries are keyed on the first loader's `loaderData` reference (object refs
 * in a WeakMap, primitives in a Map), so reconciliation's fresh segment
 * objects keep hitting them. Each key's entry list is capped (see
 * MAX_ENTRIES_PER_KEY).
 */
const IS_BROWSER = typeof window !== "undefined";

interface LoaderCacheEntry {
  sources: any[];
  // Resolves to the same array it records in `value`; a rejection passes
  // through untouched.
  promise: Promise<any[]>;
  value?: any[];
}

// Cap the per-key entries array. A stable first-ref (e.g. a layout loader whose
// loaderData object survives reconciliation across navigations) keeps its
// WeakMap/Map key alive, while a per-route loader whose ref changes each
// navigation appends a brand-new sources array under that same live key on
// every navigation. Nothing was ever removed, so the array grew linearly with
// navigation count, pinning each stale Promise + sources array from GC — a
// steady client-side leak over a long session. Only the current render's combo
// needs to stay warm; evict the oldest beyond the cap.
const MAX_ENTRIES_PER_KEY = 8;

const objectLoaderCache = IS_BROWSER
  ? new WeakMap<object, LoaderCacheEntry[]>()
  : null;
const primitiveLoaderCache = IS_BROWSER
  ? new Map<unknown, LoaderCacheEntry[]>()
  : null;

const SHARED_EMPTY_LOADERS: any[] | null = IS_BROWSER
  ? (Object.freeze([]) as unknown as any[])
  : null;

function hasSameReferences(a: any[], b: any[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Build a fresh aggregate Promise.all over the loaders' resolved data refs.
 * Unlike getMemoizedLoaderPromise this never caches, so each call yields a new
 * Promise — correct for sites that await the result immediately (a shared,
 * already-resolved promise would leak React's `.status` across server requests
 * and skip the Suspense fallback).
 *
 * @internal
 */
export function buildLoaderPromise(loaders: ResolvedSegment[]): Promise<any[]> {
  if (loaders.length === 0) {
    return Promise.resolve([]);
  }
  // Debug tap (browser only): log when each PENDING loader promise settles —
  // i.e. when its data actually lands from the flight stream — independent of
  // when the tree build awaits it. `.then(cb, cb)` observes on a branch, so
  // rejections still propagate to the real consumers untouched.
  if (INTERNAL_RANGO_DEBUG && IS_BROWSER) {
    const tapStart = performance.now();
    for (const loader of loaders) {
      if (loader.loaderData instanceof Promise) {
        const settle = (outcome: string) => () =>
          console.log(
            `[Browser][segments] loader ${loader.loaderId} ${outcome} @ ${Math.round(performance.now())}ms`,
            { msSinceRequested: Math.round(performance.now() - tapStart) },
          );
        loader.loaderData.then(settle("settled"), settle("rejected"));
      }
    }
  }
  return Promise.all(
    loaders.map((loader) =>
      loader.loaderData instanceof Promise
        ? loader.loaderData
        : Promise.resolve(loader.loaderData),
    ),
  );
}

function isObjectLike(value: unknown): value is object {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}

/**
 * The aggregate for a set of loader segments, memoized on their `loaderData`
 * refs: the settled array once it has fulfilled, the promise before that.
 *
 * @internal
 */
export function getMemoizedLoaderPromise(
  loaders: ResolvedSegment[],
): Promise<any[]> | any[] {
  if (loaders.length === 0) {
    return SHARED_EMPTY_LOADERS ?? buildLoaderPromise(loaders);
  }
  if (!objectLoaderCache || !primitiveLoaderCache) {
    return buildLoaderPromise(loaders);
  }

  const sources = loaders.map((loader) => loader.loaderData);
  const first = sources[0];
  const entries = isObjectLike(first)
    ? objectLoaderCache.get(first)
    : primitiveLoaderCache.get(first);

  if (entries) {
    for (const entry of entries) {
      if (hasSameReferences(entry.sources, sources)) {
        return entry.value ?? entry.promise;
      }
    }
  }

  const newEntry = { sources } as LoaderCacheEntry;
  const promise = buildLoaderPromise(loaders).then((values) => {
    newEntry.value = values;
    return values;
  });
  newEntry.promise = promise;
  if (entries) {
    // Bound the array: drop the oldest entry before appending when at the cap.
    if (entries.length >= MAX_ENTRIES_PER_KEY) {
      entries.shift();
    }
    entries.push(newEntry);
  } else if (isObjectLike(first)) {
    objectLoaderCache.set(first, [newEntry]);
  } else {
    primitiveLoaderCache.set(first, [newEntry]);
  }
  return promise;
}
