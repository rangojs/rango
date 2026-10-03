import {
  isLocationStateKey,
  LOCATION_STATE_KEY_PREFIX,
  LOCATION_STATE_KEY_SUFFIX_SEPARATOR,
  peekLocationStateKey,
  type LocationStateDefinition,
} from "../browser/react/location-state-shared.js";

let syntheticKeyCounter = 0;

/**
 * Assign a location-state key to a `createLocationState()` definition in a unit
 * test that runs without the rango Vite plugin (which injects the key in dev
 * and build). Outside production, a definition without a key throws on first
 * use (`MyState(value)`, `useLocationState(MyState)`, `.read()`).
 *
 * - `withLocationStateKey(GridState, "GridState")` sets `__rsc_ls_GridState`
 *   (a name that already starts with `__rsc_ls_` is used as-is). A definition
 *   with `version` / `clearOnReload` appends its suffix, so read the stored
 *   key back from `GridState.__rsc_ls_key` (`__rsc_ls_GridState~v2`).
 * - Without a name, a key already set (by the plugin or an earlier call) is
 *   kept; otherwise the definition gets a synthetic `__rsc_ls_test_<n>` key,
 *   which then stays on it.
 *
 * A name may not contain "~": that separator is reserved for those suffixes.
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
    if (name.includes(LOCATION_STATE_KEY_SUFFIX_SEPARATOR)) {
      throw new Error(
        `withLocationStateKey: "${name}" contains "${LOCATION_STATE_KEY_SUFFIX_SEPARATOR}", ` +
          "which is reserved for the key suffix of the `version` / `clearOnReload` options. " +
          "Pass the name without a suffix; the definition appends its own.",
      );
    }
    definition.__rsc_ls_key = isLocationStateKey(name)
      ? name
      : LOCATION_STATE_KEY_PREFIX + name;
  } else if (!peekLocationStateKey(definition)) {
    definition.__rsc_ls_key = `${LOCATION_STATE_KEY_PREFIX}test_${syntheticKeyCounter++}`;
  }
  return definition;
}
