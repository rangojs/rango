import type { ComponentType, ReactNode } from "react";

/**
 * App-shell metadata: the per-router fields describing the "envelope" around
 * the current app's segment tree — the rootLayout (Document), basename,
 * version, and router identity. Set once from the initial RSC payload and read
 * through the AppShellRef when rendering segments.
 *
 * This is a per-document value. A navigation that crosses a host-router app
 * boundary is a full document load (the server returns X-RSC-Reload for it;
 * see request-classification.ts, mode "app-switch"), so the target app's shell
 * — along with everything else document-level (theme, warmup, prefetch-TTL) —
 * is established fresh by the target app's own load. The shell is never swapped
 * in place within a session.
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
 * Container for the active app shell. Read-through via `get()` so closures
 * (e.g. the segment renderer) capture the ref and read the shell at call time
 * rather than closing over a stale snapshot.
 */
export interface AppShellRef {
  get(): AppShell;
}

export function createAppShellRef(initial: AppShell): AppShellRef {
  return {
    get: () => initial,
  };
}
