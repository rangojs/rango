/**
 * Vitest custom matchers for asserting on REAL Flight wire strings produced by
 * {@link renderToFlightString}. Register with:
 *
 *   import { expect } from "vitest";
 *   import { flightMatchers } from "@rangojs/router/testing/flight-matchers"; // or local path
 *   expect.extend(flightMatchers);
 *
 * Ergonomic shape (vitest `expect` is single-arg, so the matcher receives the
 * ALREADY-RENDERED Flight string as `received`):
 *
 *   const flight = await renderToFlightString(<Greeting name="Ada" />);
 *   expect(flight).toMatchFlight("Ada");          // substring containment
 *   expect(flight).toMatchFlightSnapshot();        // normalized snapshot
 *
 * `toMatchFlight(expected)` asserts the NORMALIZED Flight string CONTAINS
 * `expected`. Containment (not equality) is the v1 contract because the Flight
 * row prefixes/quoting are an internal serializer detail — tests should pin the
 * rendered text/shape, not the exact framing. For an exact, drift-detecting
 * assertion of the whole payload, use `toMatchFlightSnapshot()`.
 *
 * Both operate on normalized output (see normalizeFlight): the dev-only
 * `:N<timestamp>` reference row and absolute `file://` paths are scrubbed so
 * assertions are stable across runs/machines. Run snapshots under
 * NODE_ENV=production for the cleanest, most stable payloads.
 *
 * Scope: server-only / leaf trees (a client component emits an unresolved
 * `I[...]` import row against the empty client manifest — see flight.ts).
 */

import { expect } from "vitest";
import { normalizeFlight } from "./flight.js";

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

/**
 * Matcher object for `expect.extend(flightMatchers)`.
 *
 * - `toMatchFlight(received, expected)` — `received` is a rendered Flight
 *   string; passes if its normalized form contains `expected`.
 * - `toMatchFlightSnapshot(received)` — delegates to vitest's snapshot on the
 *   normalized Flight string.
 */
export const flightMatchers: {
  toMatchFlight(received: string, expected: string): MatcherResult;
  toMatchFlightSnapshot(received: string): MatcherResult;
} = {
  toMatchFlight(received: string, expected: string): MatcherResult {
    if (typeof received !== "string") {
      return {
        pass: false,
        message: () =>
          "toMatchFlight expected a rendered Flight string (the result of " +
          "`await renderToFlightString(...)`), but received " +
          `${typeof received}. Render the element first: ` +
          "`expect(await renderToFlightString(<C/>)).toMatchFlight(...)`.",
      };
    }
    const normalized = normalizeFlight(received);
    const pass = normalized.includes(expected);
    return {
      pass,
      message: () =>
        pass
          ? `Expected Flight string not to contain ${JSON.stringify(expected)}.`
          : `Expected Flight string to contain ${JSON.stringify(expected)}.\n` +
            `Received (normalized):\n${normalized}`,
    };
  },

  toMatchFlightSnapshot(received: string): MatcherResult {
    // Delegate to vitest's snapshot engine on the normalized string. The
    // snapshot is keyed by the current test file/title (vitest tracks this via
    // the active test context), not by this call site, so delegating through a
    // freshly imported `expect` is reliable.
    expect(normalizeFlight(received)).toMatchSnapshot();
    // toMatchSnapshot throws on mismatch; reaching here means it passed.
    return {
      pass: true,
      message: () => "Flight snapshot matched.",
    };
  },
};

/**
 * Vitest Assertion augmentation so `toMatchFlight` / `toMatchFlightSnapshot`
 * are typed on `expect(...)`. Imported for its side-effecting type
 * augmentation; importing flight-matchers (which imports this) is enough.
 */
declare module "vitest" {
  interface Assertion<T = any> {
    /** Assert the normalized Flight string contains `expected`. */
    toMatchFlight(expected: string): T;
    /** Snapshot the normalized Flight string. */
    toMatchFlightSnapshot(): T;
  }
  interface AsymmetricMatchersContaining {
    toMatchFlight(expected: string): void;
    toMatchFlightSnapshot(): void;
  }
}
