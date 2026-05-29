import type { RouteDefinition, DefaultEnv } from "../types.js";
import type { AllUseItems } from "../route-types.js";
import type { RouteHelpers } from "./helpers-types.js";
import {
  layout,
  cache,
  middleware,
  revalidate,
  parallel,
  intercept,
  when,
  errorBoundary,
  notFoundBoundary,
  route,
  loader,
  loading,
  transition,
} from "./dsl-helpers.js";
import RootLayout from "../server/root-layout";
import { invariant } from "../errors";

/**
 * Assemble the RouteHelpers object. The helpers are the DSL functions
 * themselves; the single cast erases the phantom generics (and the extra
 * `route` key) that the per-router RouteHelpers<T, TEnv> type carries but the
 * runtime functions do not.
 */
function buildRouteHelpers<T extends RouteDefinition, TEnv>(): RouteHelpers<
  T,
  TEnv
> {
  return {
    route,
    layout,
    parallel,
    intercept,
    middleware,
    revalidate,
    loader,
    loading,
    errorBoundary,
    notFoundBoundary,
    when,
    cache,
    transition,
  } as unknown as RouteHelpers<T, TEnv>;
}

/**
 * Branded type for route handlers that carries the route type info.
 * This enables type-safe verification that imported handlers match route definitions.
 */
export interface RouteHandlers<T extends RouteDefinition> {
  (): Array<AllUseItems>;
  /** Brand to carry route type info for type checking */
  readonly __routes: T;
}

/**
 * Type-safe handler definition helper
 *
 */
export function map<const T extends RouteDefinition, TEnv = DefaultEnv>(
  builder: (helpers: RouteHelpers<T, TEnv>) => Array<AllUseItems>,
): RouteHandlers<T> {
  const handler = () => {
    // Check if it's a builder function (array-based API)
    invariant(
      typeof builder === "function",
      "map() expects a builder function as its argument",
    );
    // Create helpers
    const helpers = buildRouteHelpers<T, TEnv>();

    return [layout(RootLayout, () => builder(helpers))].flat(3);
  };
  // Cast to RouteHandlers to carry the route type brand
  return handler as RouteHandlers<T>;
}

/**
 * Create RouteHelpers for inline route definitions
 * Used internally by router.map() for inline handler syntax
 */
export function createRouteHelpers<
  T extends RouteDefinition,
  TEnv,
>(): RouteHelpers<T, TEnv> {
  return buildRouteHelpers<T, TEnv>();
}
