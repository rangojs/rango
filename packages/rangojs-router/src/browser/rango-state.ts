/**
 * Rango State
 *
 * Manages a localStorage-based state key for HTTP cache invalidation.
 * The key is sent as the `X-Rango-State` header on both prefetch and
 * navigation requests. The server responds with `Vary: X-Rango-State`,
 * so the browser HTTP cache keys responses by (URL, X-Rango-State value).
 *
 * Value format: `{buildVersion}:{invalidationTimestamp}`
 * - Build version changes on deploy, busting all cached prefetches.
 * - Timestamp changes on server action invalidation.
 *
 * Storage key is namespaced per routerId (`rango-state:{routerId}`) so
 * tabs in different apps on the same origin do not collide. Two tabs in
 * the same app share a key → one tab's invalidation is picked up by the
 * other via the `storage` event. The key is bound once at document init; a
 * cross-app navigation is a full document load (X-RSC-Reload), so the target
 * app's document binds its own key on load (tabs in the old app keep theirs).
 *
 * If no routerId is supplied, falls back to a single legacy key for
 * backward compatibility (single-app deployments unaffected).
 */

const LEGACY_STORAGE_KEY = "rango-state";

function buildStorageKey(routerId: string | undefined): string {
  return routerId ? `${LEGACY_STORAGE_KEY}:${routerId}` : LEGACY_STORAGE_KEY;
}

// Module-level cache avoids hitting localStorage on every getRangoState() call.
// Initialized from localStorage on first access or by initRangoState().
let cachedState: string | null = null;

// The localStorage key this tab is currently bound to. Bound on
// initRangoState (document boot). The storage listener filters cross-tab
// events by this key so events from tabs in a different app are ignored.
let currentStorageKey: string = LEGACY_STORAGE_KEY;

// Cross-tab sync: the `storage` event fires in OTHER tabs when one tab writes
// to localStorage, keeping cachedState fresh without polling.
let storageListenerAttached = false;

function attachStorageListener(): void {
  if (storageListenerAttached || typeof window === "undefined") return;
  window.addEventListener("storage", (e) => {
    // Only react to events for this tab's current app namespace. Events
    // under other routerId-scoped keys belong to other apps and must not
    // clobber this tab's state.
    if (e.key !== currentStorageKey) return;
    cachedState = e.newValue;
  });
  storageListenerAttached = true;
}

/**
 * Initialize the Rango state key in localStorage.
 * Called once at app startup with the build version from the server.
 * The routerId scopes the storage key to this app; in multi-app setups
 * each app owns its own `rango-state:{routerId}` key and cannot observe
 * invalidations from sibling apps on the same origin.
 *
 * If localStorage already has a matching-version entry under the key,
 * keeps it (preserves invalidation state across refresh). Otherwise
 * writes a new value.
 */
export function initRangoState(version: string, routerId?: string): void {
  currentStorageKey = buildStorageKey(routerId);
  if (typeof window === "undefined") return;

  attachStorageListener();

  try {
    const existing = localStorage.getItem(currentStorageKey);
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
    localStorage.setItem(currentStorageKey, newState);
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
    const stored = localStorage.getItem(currentStorageKey);
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
    localStorage.setItem(currentStorageKey, newState);
  } catch {
    // Silently handle localStorage errors
  }
}
