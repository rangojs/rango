import type { ResolvedSegment } from "./types.js";

/**
 * Cache of aggregate Promise.all results keyed on the first loader's
 * `loaderData` reference. Each entry holds the source refs it was built from
 * plus the resulting Promise/array; lookup scans entries for the matching
 * source array (typically a single entry, since distinct loader groups rarely
 * share a first source). Object first-refs live in a WeakMap (auto-GC);
 * primitive first-refs (strings/numbers/booleans/null) live in a Map so
 * loaders that resolve to primitive data are memoized too — bounded in
 * practice by the application's loader set.
 *
 * Keying externally means reconciliation's fresh segment objects no longer
 * drop memoization — the cache survives as long as the underlying loader
 * segments do, and GC collects entries when those loaders are released
 * (object keys only).
 *
 * Browser-only. On the server each SSR render needs a fresh Promise so
 * Suspense can actually suspend and emit the loading fallback HTML before
 * content streams. A shared already-resolved promise has `.status` attached
 * by React on first `use()`; subsequent observations return synchronously
 * and skip the fallback. The zero-loader case is especially prone because
 * every empty-loader site would otherwise share one promise across requests.
 */
const IS_BROWSER = typeof window !== "undefined";

interface LoaderCacheEntry {
  sources: any[];
  promise: Promise<any[]> | any[];
}

const objectLoaderCache = IS_BROWSER
  ? new WeakMap<object, LoaderCacheEntry[]>()
  : null;
const primitiveLoaderCache = IS_BROWSER
  ? new Map<unknown, LoaderCacheEntry[]>()
  : null;

// In the browser, a single shared empty aggregate is safe (and desirable) —
// reusing the same resolved promise keeps React's `use()` in a known-fulfilled
// state across renders. On the server it would leak `.status = "fulfilled"`
// across requests and skip the Suspense fallback, so we rebuild on each call.
const SHARED_EMPTY_LOADER_PROMISE: Promise<any[]> | null = IS_BROWSER
  ? Promise.resolve([])
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

function buildLoaderPromise(loaders: ResolvedSegment[]): Promise<any[]> {
  if (loaders.length === 0) {
    return Promise.resolve([]);
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
 * Memoize an aggregate Promise.all for a set of loader segments. Reusing the
 * same aggregate across renders — invalidated only when any underlying
 * loader.loaderData ref changes — keeps React's `use()` in "known fulfilled"
 * state and prevents a fresh Promise.all from suspending (and briefly
 * committing the Suspense fallback) on every partial update that doesn't
 * actually change loader data.
 *
 * @internal
 */
export function getMemoizedLoaderPromise(
  loaders: ResolvedSegment[],
): Promise<any[]> | any[] {
  if (loaders.length === 0) {
    return SHARED_EMPTY_LOADER_PROMISE ?? buildLoaderPromise(loaders);
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
        return entry.promise;
      }
    }
  }

  const promise = buildLoaderPromise(loaders);
  const newEntry: LoaderCacheEntry = { sources, promise };
  if (entries) {
    entries.push(newEntry);
  } else if (isObjectLike(first)) {
    objectLoaderCache.set(first, [newEntry]);
  } else {
    primitiveLoaderCache.set(first, [newEntry]);
  }
  return promise;
}
