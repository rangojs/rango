/**
 * @rangojs/router/testing
 *
 * Consumer-facing testing primitives for apps built on @rangojs/router.
 *
 * This is the entry for UNIT and INTEGRATION tests, meant to run under a
 * Vite-driven Vitest project (the rango Vite plugin must be active so the
 * `@rangojs/router:version` and related virtual modules the router internals
 * import can resolve; alternatively alias `@rangojs/router:version`). Importing
 * this module references neither React, @testing-library/react, @playwright/test,
 * nor the RSC runtime — a unit suite testing only loaders/middleware/dispatch
 * pulls in none of them.
 *
 * The other surfaces are SEPARATE entries because each pulls a dependency or
 * runtime this barrel deliberately keeps out:
 * - `@rangojs/router/testing/dom` — `renderRoute` (the RTL component stub). Kept
 *   separate so this barrel never references React, the browser runtime, or
 *   `@testing-library/react` types — a unit suite testing only loaders/middleware
 *   needs none of them.
 * - `@rangojs/router/testing/e2e` — the Playwright harness (createRangoE2E,
 *   useFixture, parityDescribe, expectParity, matchers). Kept separate so it is
 *   loadable in a plain (non-Vite) Playwright runner, which cannot resolve the
 *   router-manifest virtual modules this barrel pulls in.
 * - `@rangojs/router/testing/flight` — real Flight rendering. Its serializer
 *   (vendored react-server-dom) loads only under the `react-server` node
 *   condition and would throw if pulled into this barrel.
 *
 * Layers:
 * - Unit:        runMiddleware, runLoader
 * - Integration: dispatch (request -> Response)
 * - Cross-cut:   assertCacheStatus, assertGeneratedRoutesMatch
 * - Component:   see @rangojs/router/testing/dom (renderRoute)
 * - E2E:         see @rangojs/router/testing/e2e
 * - RSC:         see @rangojs/router/testing/flight
 */

export { runMiddleware } from "./run-middleware.js";
export type {
  RunMiddlewareOptions,
  RunMiddlewareResult,
} from "./run-middleware.js";
export { runLoader, runLoaderResult } from "./run-loader.js";
export type {
  RunLoaderOptions,
  RunLoaderResult,
  UseResolver,
  TestLoaderContext,
} from "./run-loader.js";

export { dispatch } from "./dispatch.js";
export type { DispatchOptions } from "./dispatch.js";

export {
  assertCacheStatus,
  parseCacheHeader,
  createCacheSink,
  filterCacheDecisions,
} from "./cache-status.js";
export type {
  ExpectedCacheStatus,
  CacheStatusTarget,
  CacheSink,
} from "./cache-status.js";
export type {
  TelemetryEvent,
  TelemetrySink,
  CacheDecisionEvent,
  CacheSegmentSignal,
  CacheSegmentStatus,
} from "../router/telemetry.js";

export { collectHandle } from "./collect-handle.js";

export {
  diffGeneratedRoutes,
  assertGeneratedRoutesMatch,
} from "./generated-routes.js";
export type {
  GeneratedRoutesDiff,
  GeneratedRouteMismatch,
} from "./generated-routes.js";

export {
  createTestRequestContext,
  runInRequestContext,
  toRequest,
  seedVariables,
} from "./internal/context.js";
export type {
  CreateTestContextOptions,
  TestRequestContext,
  TestRequestContextObject,
  RunInRequestContextResult,
  VarsInit,
  StateCookieSeed,
} from "./internal/context.js";

export { runWithRequestContext } from "../server/request-context.js";
