/**
 * Router-wide default prefetch strategy (client seat).
 *
 * The server resolves `createRouter({ defaultPrefetch })` once at router init
 * (router/prefetch-default.ts) and ships it in initial payload metadata. The
 * router store carries it to its readers: `<Link>` reads
 * `NavigationStoreContext.defaultPrefetch`, and delegated plain anchors get it
 * from the navigation bridge. Every `<Link>` without an explicit `prefetch`
 * prop and every eligible intercepted plain anchor that has not opted out with
 * `data-prefetch="false"` or `data-prefetch="none"` uses it. Containers use the
 * same `false`/`none` vocabulary via `data-prefetch-scope`.
 */

import type { PrefetchStrategy } from "../../router/prefetch-default.js";

/**
 * The default for a payload without `defaultPrefetch`: the server resolver's
 * environment default (`"none"` in development, `"viewport"` in production),
 * mirrored without pulling router-layer code into the client bundle. NODE_ENV
 * is folded by the app build.
 */
export const ENVIRONMENT_DEFAULT_PREFETCH: PrefetchStrategy =
  process.env.NODE_ENV === "production" ? "viewport" : "none";

function hoverNoneQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return null;
  return window.matchMedia("(hover: none)");
}

/**
 * Resolve adaptive to the strategy for the current input capability. Called
 * when a prefetch is armed or triggered, never during render.
 */
export function resolveAdaptiveStrategy(
  strategy: PrefetchStrategy,
): PrefetchStrategy {
  if (strategy !== "adaptive") return strategy;
  return hoverNoneQuery()?.matches ? "viewport" : "hover";
}

/** Subscribe to changes in the input capability used by adaptive prefetch. */
export function subscribeToAdaptiveStrategyChange(
  listener: () => void,
): () => void {
  const query = hoverNoneQuery();
  if (!query) return () => {};
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }
  query.addListener(listener);
  return () => query.removeListener(listener);
}
