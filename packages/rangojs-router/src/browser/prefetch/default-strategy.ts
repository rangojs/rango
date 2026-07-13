/**
 * Router-wide default prefetch strategy (client seat).
 *
 * The server resolves `createRouter({ defaultPrefetch })` once at router init
 * (router/prefetch-default.ts) and ships it in initial payload metadata; the
 * browser entry applies it here before hydration — same lifecycle as
 * `initPrefetchCache` / `setPrefetchConcurrency`. Every `<Link>` without an
 * explicit `prefetch` prop and every eligible intercepted plain anchor that has
 * not opted out with `data-prefetch="false"` or `data-prefetch="none"` uses it.
 *
 * The module initial value must equal the server resolver's environment default:
 * `"none"` in development and `"viewport"` in production. During SSR this
 * module is never initialized from metadata, so keeping both seats aligned also
 * gives metadata-less payloads the documented behavior.
 */

import type { PrefetchStrategy } from "../../router/prefetch-default.js";

let hoverNoneQuery: MediaQueryList | null = null;
let matchMediaSource: typeof window.matchMedia | null = null;

// Mirrors DEFAULT_PREFETCH_STRATEGY without pulling router-layer code into the
// client bundle. NODE_ENV is folded by the app build.
let defaultStrategy: PrefetchStrategy =
  process.env.NODE_ENV === "production" ? "viewport" : "none";

function getHoverNoneQuery(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  // The browser query stays live and is reused across Links. Test DOMs replace
  // matchMedia between cases, so key the cache by the current implementation.
  if (!hoverNoneQuery || matchMediaSource !== window.matchMedia) {
    matchMediaSource = window.matchMedia;
    hoverNoneQuery = window.matchMedia("(hover: none)");
  }
  return hoverNoneQuery;
}

/**
 * Apply the server-resolved default strategy. Called once at browser app init
 * from payload metadata; also used by tests to reset state.
 */
export function setDefaultPrefetchStrategy(strategy: PrefetchStrategy): void {
  defaultStrategy = strategy;
}

/** Current default strategy for Links and delegated plain anchors. */
export function getDefaultPrefetchStrategy(): PrefetchStrategy {
  return defaultStrategy;
}

/** Resolve adaptive to the strategy for the current input capability. */
export function resolveAdaptiveStrategy(
  strategy: PrefetchStrategy,
): PrefetchStrategy {
  if (strategy !== "adaptive") return strategy;
  return getHoverNoneQuery()?.matches ? "viewport" : "hover";
}

/** Subscribe to changes in the input capability used by adaptive prefetch. */
export function subscribeToAdaptiveStrategyChange(
  listener: () => void,
): () => void {
  const query = getHoverNoneQuery();
  if (!query) return () => {};
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }
  query.addListener(listener);
  return () => query.removeListener(listener);
}
