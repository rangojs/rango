/**
 * Client seat of `invalidateClientCache()` (the `default` export condition).
 *
 * The full client invalidation, more than a server action without a
 * directive does: the history cache is marked stale (SWR), the prefetch map
 * is flushed (in-flight prefetches aborted, visible links prefetch again), the
 * state rotates, and sibling tabs are broadcast to, which adopt the new state
 * and flush too (`invalidateCacheAndBroadcast()`). A directive-free action
 * only marks history and prefetches stale and rotates nothing
 * (`markCacheAsStaleAndBroadcast()`). History is marked stale, not cleared, so
 * Back renders the cached entry instantly and revalidates.
 */

import { getRegisteredStore } from "./navigation-store-handle.js";
import { clearPrefetchCache } from "./prefetch/cache.js";

export function invalidateClientCache(): void {
  if (typeof document === "undefined") {
    // SSR pass of a client component also resolves the default condition. A
    // render-time call must not take down the page; no-op with a dev warning.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[rango] invalidateClientCache() was called during a server render; " +
          "it is a no-op outside the browser.",
      );
    }
    return;
  }

  const store = getRegisteredStore();
  if (store) {
    store.invalidateCacheAndBroadcast();
    return;
  }

  // Pre-boot: no store registered yet. clearPrefetchCache() (which rotates the
  // state) is complete at this point — there is no history cache to mark and no
  // sibling state worth broadcasting.
  clearPrefetchCache();
}

/**
 * Client no-op for `keepClientCache()`. It is a server action directive (the
 * `react-server` condition sets a response header the action bridge reads);
 * there is nothing to suppress from the client side.
 */
export function keepClientCache(): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "[rango] keepClientCache() has no effect on the client; it is a server " +
        "action directive. Call it from inside a server action.",
    );
  }
}
