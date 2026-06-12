/**
 * Client seat of `invalidateClientCache()` (the `default` export condition).
 *
 * Makes the current client behave as if a server action had just completed:
 * the history cache is marked stale (SWR), the prefetch map is flushed, the
 * state rotates, and sibling tabs are broadcast to — the same
 * `markCacheAsStaleAndBroadcast()` path the server-action bridge uses. This is
 * the gentler mark-stale (not hard-clear) behavior, so Back renders the cached
 * entry instantly and revalidates.
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
    store.markCacheAsStaleAndBroadcast();
    return;
  }

  // Pre-boot: no store registered yet. clearPrefetchCache() (which rotates the
  // state) is complete at this point — there is no history cache to mark and no
  // sibling state worth broadcasting.
  clearPrefetchCache();
}
