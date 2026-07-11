/**
 * Router-wide default Link prefetch strategy (client seat).
 *
 * The server resolves `createRouter({ defaultPrefetch })` once at router init
 * (router/prefetch-default.ts) and ships it in initial payload metadata; the
 * browser entry applies it here before hydration — same lifecycle as
 * `initPrefetchCache` / `setPrefetchConcurrency`. Every `<Link>` without an
 * explicit `prefetch` prop reads the value at render time.
 *
 * The module initial value must equal the server resolver's environment default:
 * `"none"` in development and `"viewport"` in production. During SSR this
 * module is never initialized from metadata, so keeping both seats aligned also
 * gives metadata-less payloads the documented behavior.
 */

import type { PrefetchStrategy } from "../../router/prefetch-default.js";

// Mirrors DEFAULT_PREFETCH_STRATEGY without pulling router-layer code into the
// client bundle. NODE_ENV is folded by the app build.
let defaultStrategy: PrefetchStrategy =
  process.env.NODE_ENV === "production" ? "viewport" : "none";

/**
 * Apply the server-resolved default strategy. Called once at browser app init
 * from payload metadata; also used by tests to reset state.
 */
export function setDefaultPrefetchStrategy(strategy: PrefetchStrategy): void {
  defaultStrategy = strategy;
}

/** Current default strategy for Links without an explicit `prefetch` prop. */
export function getDefaultPrefetchStrategy(): PrefetchStrategy {
  return defaultStrategy;
}
