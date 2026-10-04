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
 *
 * `renderToFlightString` returns the wire STRING (for `toMatchFlight`).
 * `renderServerTree` additionally deserializes it back to an inspectable React
 * element tree, so you can assert typed prop fidelity across the client boundary
 * (a `Date` comes back a `Date`) and detect inlined-vs-island. Serialize +
 * deserialize only — no hydration/interaction (that is the e2e tier).
 *
 * `serveShellRequest` serves one request through the router's production
 * handler, so a `ppr` route's MISS runs the real shell capture and a later
 * request is a real HIT; only the HTML step is stubbed. `resetShellTestState`
 * clears the per-isolate PPR state between tests.
 */

export {
  renderToFlightString,
  normalizeFlight,
  assertFlightRuntimeAvailable,
} from "./flight.js";
export type { RenderToFlightStringOptions } from "./flight.js";

export {
  renderServerTree,
  findClientBoundaries,
  findElements,
  textContent,
  assertFlightTreeRuntimeAvailable,
} from "./flight-tree.js";
export type {
  RenderServerTreeOptions,
  RenderServerTreeResult,
  ClientBoundary,
  BoundarySelector,
  FoundElement,
  ElementSelector,
} from "./flight-tree.js";

export { renderHandler } from "./render-handler.js";
export type {
  TestableHandler,
  RenderHandlerOptions,
  RenderHandlerResult,
  StateCookieSeed,
} from "./render-handler.js";

export {
  serveShellRequest,
  resetShellTestState,
} from "./serve-shell-request.js";
export type {
  ServeShellRequestOptions,
  ServeShellRequestResult,
  ShellRequestHandles,
} from "./serve-shell-request.js";
