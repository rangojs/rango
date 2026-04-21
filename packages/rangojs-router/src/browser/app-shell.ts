import type { ComponentType, ReactNode } from "react";

/**
 * App-shell metadata: the set of per-router fields that describe the
 * "envelope" around the current app's segment tree. These fields are set
 * from the initial RSC payload and must be replaced atomically when the
 * client navigates into a different router (app switch).
 *
 * Intentionally NOT part of the shell (all document-lifetime):
 * - themeConfig / initialTheme: ThemeProvider is mounted above the segment
 *   tree and must not remount on smooth transitions.
 * - warmupEnabled: attached to the NavigationProvider's lifetime effect;
 *   toggling it mid-session would tear down and restart idle listeners.
 *   Also not serialized on every full-render path (e.g. the not-found
 *   fallback), so carrying it here would be unreliable.
 * - prefetchCacheTTL: the not-found full-render payload does not serialize
 *   it, so a cross-app nav into a 404 would silently erase the setting.
 *   Mutable shell fields must be serialized on EVERY full-render path,
 *   otherwise absent fields are indistinguishable from "new app has no
 *   value" and the old app's value is dropped.
 *
 * A new document navigation (hard reload) applies these fields from the
 * target app's initial payload.
 */
export interface AppShell {
  /** Router identity. Used to namespace per-app client state (e.g. the
   *  rango-state localStorage key) so sibling apps on the same origin
   *  cannot observe each other's cache invalidations. */
  routerId?: string;
  rootLayout?: ComponentType<{ children: ReactNode }>;
  basename?: string;
  version?: string;
}

/**
 * Mutable container for the active app shell. Read-through via `get()` so
 * closures capture the ref, not the shell, and pick up updates at call time.
 */
export interface AppShellRef {
  get(): AppShell;
  update(next: AppShell): void;
}

export function createAppShellRef(initial: AppShell): AppShellRef {
  let current = initial;
  return {
    get: () => current,
    update: (next) => {
      current = next;
    },
  };
}
