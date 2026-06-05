/**
 * @rangojs/router/testing/flight
 *
 * Real React Server Component (Flight) rendering for unit tests. This entry is
 * SEPARATE from the main ./testing barrel because its serializer (the vendored
 * react-server-dom build) can only be imported under the `react-server` node
 * condition; importing it elsewhere throws. Use it only from a Vitest project
 * configured with that condition (see vitest.rsc.config.ts) — name those test
 * files `*.rsc-test.{ts,tsx}` and run `pnpm test:unit:rsc`.
 *
 * This entry deliberately does NOT pull in Vitest. The `toMatchFlight` /
 * `toMatchFlightSnapshot` matchers (which import `vitest`) live at the separate
 * `@rangojs/router/testing/flight-matchers` subpath, so a consumer can import
 * `renderToFlightString` without taking a hard dependency on Vitest.
 */

export {
  renderToFlightString,
  normalizeFlight,
  assertFlightRuntimeAvailable,
} from "./flight.js";
export type { RenderToFlightStringOptions } from "./flight.js";
