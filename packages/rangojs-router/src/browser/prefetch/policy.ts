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

let cached: boolean | null = null;

function evaluate(): boolean {
  if (typeof window === "undefined") return false;

  const nav =
    typeof navigator !== "undefined"
      ? (navigator as NavigatorWithConnection)
      : undefined;

  // Save-Data indicates the user prefers reduced data usage.
  if (nav?.connection?.saveData) return false;

  // Prefer-reduced-data is a media query signal for reduced network usage.
  if (typeof window.matchMedia === "function") {
    try {
      if (window.matchMedia("(prefers-reduced-data: reduce)").matches) {
        return false;
      }
    } catch {
      // Ignore invalid/unsupported query errors and allow prefetch.
    }
  }

  return true;
}

export function shouldPrefetch(): boolean {
  return (cached ??= evaluate());
}

/** Reset cached result (for tests). */
export function resetPrefetchPolicy(): void {
  cached = null;
}
