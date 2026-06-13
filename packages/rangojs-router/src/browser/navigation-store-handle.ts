/**
 * A module-level handle to the active navigation store.
 *
 * The boot path (`rsc-router.tsx`) calls `createNavigationStore()` directly;
 * there is no global store singleton. This handle is the live reference for
 * code that needs the store but does not
 * receive it by argument: the jar-divergence observer (below) and the client
 * seat of `invalidateClientCache()` (added later).
 *
 * Dependency-light on purpose: it imports only `setRangoStateObserver` and the
 * store type, so pulling it into the default root entry does not drag the
 * navigation store into bundles that previously lacked it.
 */

import { setRangoStateObserver } from "./rango-state.js";
import type { NavigationStore } from "./types.js";

let registeredStore: NavigationStore | null = null;

/**
 * Register the active navigation store at boot, and wire the jar-divergence
 * observer: when a per-request cookie read detects an EXTERNAL rotation (a
 * sibling tab, a server `Set-Cookie`, or a cookie clear), mark this tab's
 * history cache stale. The history cache is not state-keyed, so the value
 * rotation alone does not reach it. No broadcast, no prefetch clear, no
 * re-rotation — the value already changed externally.
 */
export function registerNavigationStore(store: NavigationStore): void {
  registeredStore = store;
  setRangoStateObserver(() => {
    registeredStore?.markHistoryCacheStale();
  });
}

/** The active navigation store, or null before boot has registered it. */
export function getRegisteredStore(): NavigationStore | null {
  return registeredStore;
}
