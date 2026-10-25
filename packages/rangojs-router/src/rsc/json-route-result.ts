/**
 * Serialization for `json()` response-route results (depends only on
 * `errors.js`).
 */

import { RouterError } from "../errors.js";

/**
 * Serialize a `json()` response-route result, rejecting a nested unresolved
 * Promise (the forgotten-await footgun: `() => ({ data: fetchSomething() })`).
 * `JSON.stringify` would silently emit `{}` for a Promise, shipping empty data;
 * the RSC pipeline awaits nested promises but this path does not. Throwing
 * `RESPONSE_NOT_SERIALIZABLE` makes the failure loud.
 *
 * The `dispatch()` testing primitive runs the same response-route handler, so
 * a `dispatch` json test of a forgotten await fails exactly where production
 * 500s, instead of going green.
 */
export function stringifyJsonRouteResult(result: unknown): string {
  return JSON.stringify(result, (_key, value) => {
    if (
      value != null &&
      typeof (value as { then?: unknown }).then === "function"
    ) {
      throw new RouterError(
        "RESPONSE_NOT_SERIALIZABLE",
        "A json() response route returned a Promise (likely a forgotten " +
          "await). Await async values before returning so they serialize, " +
          "instead of emitting an empty {}.",
      );
    }
    return value;
  });
}
