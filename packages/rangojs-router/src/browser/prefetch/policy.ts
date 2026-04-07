/**
 * Prefetch Policy
 *
 * Determines whether speculative prefetching should run for the current user.
 * Honors browser reduced-data preferences when available.
 */

import { isPrefetchCacheDisabled } from "./cache.js";

type NavigatorWithConnection = Navigator & {
  connection?: {
    saveData?: boolean;
  };
};

/**
 * Evaluate on every call so runtime changes to Save-Data or
 * prefers-reduced-data are respected immediately.
 */
export function shouldPrefetch(): boolean {
  if (typeof window === "undefined") return false;

  // When prefetchCacheTTL is false/0, prefetching is fully disabled —
  // no point issuing requests whose responses will be discarded.
  if (isPrefetchCacheDisabled()) return false;

  const nav =
    typeof navigator !== "undefined"
      ? (navigator as NavigatorWithConnection)
      : undefined;

  if (nav?.connection?.saveData) return false;

  if (typeof window.matchMedia === "function") {
    try {
      if (window.matchMedia("(prefers-reduced-data: reduce)").matches) {
        return false;
      }
    } catch {
      // Ignore unsupported query errors and allow prefetch.
    }
  }

  return true;
}

/** No-op, kept for test compatibility. */
export function resetPrefetchPolicy(): void {}
