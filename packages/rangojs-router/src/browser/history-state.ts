import {
  isLocationStateEntry,
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
 * Resolve navigation state - handles both LocationStateEntry[] and plain formats
 */
export function resolveNavigationState(state: unknown): unknown {
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
