/**
 * Router-wide default Link prefetch strategy (client seat).
 *
 * The server resolves `createRouter({ defaultPrefetch })` once at router init
 * (router/prefetch-default.ts) and ships it in initial payload metadata; the
 * browser entry applies it here before hydration — same lifecycle as
 * `initPrefetchCache` / `setPrefetchConcurrency`. Every `<Link>` without an
 * explicit `prefetch` prop reads the value at render time.
 *
 * The module initial value must equal the server resolver's default
 * ("viewport"): during SSR this module is never initialized from metadata, so
 * a Link render on the server sees the built-in default regardless of router
 * config. That is safe — the strategy only drives client-side effects and
 * event handlers, never rendered markup — but keeping the two defaults equal
 * means a metadata-less payload (older server) still behaves as documented.
 */

import type { PrefetchStrategy } from "../../router/prefetch-default.js";

// Mirrors DEFAULT_PREFETCH_STRATEGY in router/prefetch-default.ts. Kept as a
// local literal so the client bundle doesn't pull in router-layer code (same
// convention as the defaults in queue.ts/cache.ts); the cross-seat equality
// is pinned by src/__tests__/prefetch-default-strategy.test.ts.
let defaultStrategy: PrefetchStrategy = "viewport";

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
