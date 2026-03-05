/**
 * Prefetch Policy
 *
 * Determines whether speculative prefetching should run for the current user.
 * Honors browser reduced-data preferences when available.
 */

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
