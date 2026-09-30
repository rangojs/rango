import {
  isLocationStateDefinition,
  isLocationStateEntry,
  peekLocationStateKey,
  resolveLocationStateEntries,
} from "./react/location-state-shared.js";

/**
 * Check if state is from typed LocationStateEntry[] (has __rsc_ls_ keys)
 */
function isTypedLocationState(
  state: unknown,
): state is Record<string, unknown> {
  if (state === null || typeof state !== "object") return false;
  return Object.keys(state).some((key) => key.startsWith("__rsc_ls_"));
}

/**
 * Dev-only guard for the state mistakes `HistoryState` rejects at compile
 * time, for untyped callers: a typed entry without its array (its `__rsc_ls_*`
 * fields would be spread onto history.state, so useLocationState reads
 * undefined), an uncalled definition (pushState throws DataCloneError), and an
 * array mixing entries with plain values (only `state[0]` picks the format, so
 * the rest land under history.state["undefined"] or are never read).
 */
function assertNavigationState(state: unknown): void {
  if (isLocationStateEntry(state)) {
    throw new Error(
      `[rango] navigation state is a single location-state entry (key "${state.__rsc_ls_key}"). ` +
        "Wrap it in an array: { state: [MyState(value)] }. " +
        "Without the array, useLocationState(MyState) reads undefined.",
    );
  }
  const definition = (Array.isArray(state) ? state : [state]).find(
    isLocationStateDefinition,
  );
  if (definition) {
    throw new Error(
      `[rango] navigation state contains a location-state definition (key "${peekLocationStateKey(definition) ?? "unset"}") instead of an entry. ` +
        "Call it with the value: { state: [MyState(value)] }, not [MyState].",
    );
  }
  if (Array.isArray(state) && state.some(isLocationStateEntry)) {
    const index = state.findIndex((item) => !isLocationStateEntry(item));
    if (index !== -1) {
      throw new Error(
        `[rango] navigation state mixes location-state entries with other values (index ${index}). ` +
          "Pass only entries ({ state: [MyState(value), Other(value)] }); plain state cannot sit next to typed entries.",
      );
    }
  }
}

/**
 * Resolve navigation state - handles both LocationStateEntry[] and plain formats
 */
export function resolveNavigationState(state: unknown): unknown {
  if (process.env.NODE_ENV !== "production") {
    assertNavigationState(state);
  }
  if (
    Array.isArray(state) &&
    state.length > 0 &&
    isLocationStateEntry(state[0])
  ) {
    return resolveLocationStateEntries(state);
  }
  return state;
}

/**
 * Build history state object from user state
 * - Typed state: spread directly into history.state
 * - Plain state: store in history.state.state
 */
export function buildHistoryState(
  userState: unknown,
  routerState?: { intercept?: boolean; sourceUrl?: string },
  serverState?: Record<string, unknown>,
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};

  if (routerState?.intercept) {
    result.intercept = true;
    if (routerState.sourceUrl) {
      result.sourceUrl = routerState.sourceUrl;
    }
  }

  if (userState !== undefined) {
    if (isTypedLocationState(userState)) {
      Object.assign(result, userState);
    } else {
      result.state = userState;
    }
  }

  if (serverState) {
    Object.assign(result, serverState);
  }

  return Object.keys(result).length > 0 ? result : null;
}

/** Check if a history state object contains location state keys. */
export function hasLocationState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  return (
    "state" in state ||
    Object.keys(state).some((k) => k.startsWith("__rsc_ls_"))
  );
}

/**
 * Stamp an `idx` on the next history entry's state and call push/replaceState.
 * Push increments the current idx; replace keeps it. Initial entry idx is 0.
 * Used by useRouter().back() to detect "first entry in this session" without
 * relying on the Navigation API.
 */
export function pushHistoryWithIdx(
  state: Record<string, unknown> | null,
  url: string,
  replace: boolean,
): void {
  const oldIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  const newIdx = replace ? oldIdx : oldIdx + 1;
  const finalState = { ...(state ?? {}), idx: newIdx };
  if (replace) {
    window.history.replaceState(finalState, "", url);
  } else {
    window.history.pushState(finalState, "", url);
  }
}

/**
 * The forced-MISS reload marker (`SHELL_MISS_PARAM` in rsc/shell-serve.ts,
 * which the browser bundle must not import): a degraded PPR shell HIT
 * reloads the page with it, and the server renders a marked request like a
 * cache miss.
 */
export const SHELL_MISS_MARKER: string = "_rsc_shell";

/**
 * Drop the forced-MISS marker from the address bar at boot, keeping the
 * history entry's state (initBrowserApp calls it before any location read).
 * Left in place, a refresh or a shared link would stay off the shell and the
 * app's search params would carry it. The server strips the same marker from
 * the request before rendering (shell-serve.ts withoutShellMissMarker), so
 * the page was rendered for the clean URL and the hydrating client agrees.
 */
export function stripShellMissMarker(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(SHELL_MISS_MARKER)) return;
  url.searchParams.delete(SHELL_MISS_MARKER);
  window.history.replaceState(window.history.state, "", url.href);
}

/**
 * Merge server-set location state into the current history entry.
 * Replaces the current history state and dispatches notification event
 * so useLocationState hooks re-read from history.state.
 */
export function mergeLocationState(
  locationState: Record<string, unknown>,
): void {
  const merged = {
    ...window.history.state,
    ...locationState,
  };
  window.history.replaceState(merged, "", window.location.href);
  if (Object.keys(locationState).some((k) => k.startsWith("__rsc_ls_"))) {
    window.dispatchEvent(new Event("__rsc_locationstate"));
  }
}
