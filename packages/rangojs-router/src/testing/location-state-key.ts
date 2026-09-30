import {
  peekLocationStateKey,
  type LocationStateDefinition,
} from "../browser/react/location-state-shared.js";

// Typed history.state slots must carry this prefix: buildHistoryState spreads
// only `__rsc_ls_*` keys onto history.state (history-state.ts).
const KEY_PREFIX = "__rsc_ls_";

let syntheticKeyCounter = 0;

/**
 * Assign a location-state key to a `createLocationState()` definition in a unit
 * test that runs without the rango Vite plugin (which injects the key in dev
 * and build). Outside production, a definition without a key throws on first
 * use (`MyState(value)`, `useLocationState(MyState)`, `.read()`).
 *
 * - `withLocationStateKey(GridState, "GridState")` sets `__rsc_ls_GridState`
 *   (a name that already starts with `__rsc_ls_` is used as-is).
 * - Without a name, a key already set (by the plugin or an earlier call) is
 *   kept; otherwise the definition gets a synthetic `__rsc_ls_test_<n>` key,
 *   which then stays on it.
 *
 * Returns the definition.
 *
 * @example
 * ```ts
 * import { withLocationStateKey } from "@rangojs/router/testing";
 * import { GridState } from "../src/location-states";
 *
 * withLocationStateKey(GridState);
 * ```
 */
export function withLocationStateKey<
  TDefinition extends LocationStateDefinition<any, any>,
>(definition: TDefinition, name?: string): TDefinition {
  if (name !== undefined) {
    definition.__rsc_ls_key = name.startsWith(KEY_PREFIX)
      ? name
      : KEY_PREFIX + name;
  } else if (!peekLocationStateKey(definition)) {
    definition.__rsc_ls_key = `${KEY_PREFIX}test_${syntheticKeyCounter++}`;
  }
  return definition;
}
