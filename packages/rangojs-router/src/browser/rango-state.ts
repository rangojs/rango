/**
 * Rango State
 *
 * Manages a localStorage-based state key for HTTP cache invalidation.
 * The key is sent as the `X-Rango-State` header on both prefetch and
 * navigation requests. The server responds with `Vary: X-Rango-State`,
 * so the browser HTTP cache keys responses by (URL, X-Rango-State value).
 *
 * Format: `{buildVersion}:{invalidationTimestamp}`
 * - Build version changes on deploy, busting all cached prefetches.
 * - Timestamp changes on server action invalidation.
 *
 * localStorage is cross-tab and survives page refresh, so:
 * - One tab's prefetch warms the cache for all tabs.
 * - Invalidation in one tab is picked up by other tabs on next fetch.
 */

const STORAGE_KEY = "rango-state";

// Module-level cache avoids hitting localStorage on every getRangoState() call.
// Initialized from localStorage on first access or by initRangoState().
let cachedState: string | null = null;

/**
 * Initialize the Rango state key in localStorage.
 * Called once at app startup with the build version from the server.
 * If localStorage already has a key with matching version prefix, keeps it
 * (preserves invalidation state across refresh). Otherwise writes a new key.
 */
export function initRangoState(version: string): void {
  if (typeof window === "undefined") return;

  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) {
      const colonIdx = existing.indexOf(":");
      if (colonIdx > 0) {
        const existingVersion = existing.slice(0, colonIdx);
        if (existingVersion === version) {
          cachedState = existing;
          return;
        }
      }
    }
    // New version or first load
    const newState = `${version}:${Date.now()}`;
    localStorage.setItem(STORAGE_KEY, newState);
    cachedState = newState;
  } catch {
    // localStorage may be unavailable (private browsing in some browsers)
    cachedState = `${version}:${Date.now()}`;
  }
}

/**
 * Get the current Rango state key value.
 * Used as the `X-Rango-State` header value for prefetch and navigation requests.
 */
export function getRangoState(): string {
  if (cachedState) return cachedState;

  if (typeof window === "undefined") return "0:0";

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      cachedState = stored;
      return stored;
    }
  } catch {
    // Fallback for unavailable localStorage
  }

  return "0:0";
}

/**
 * Invalidate the Rango state key. Called when server actions mutate data.
 * Updates the timestamp portion while keeping the version prefix.
 * The new value takes effect immediately for all subsequent fetches,
 * causing Vary mismatches with previously cached responses.
 */
export function invalidateRangoState(): void {
  const current = getRangoState();
  const colonIdx = current.indexOf(":");
  const version = colonIdx > 0 ? current.slice(0, colonIdx) : "0";
  const newState = `${version}:${Date.now()}`;
  cachedState = newState;

  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(STORAGE_KEY, newState);
  } catch {
    // Silently handle localStorage errors
  }
}
