// Route definition
export { route, type RouteDefinitionResult } from "./route-function.ts";

// Type definitions
export type { RouteHelpers } from "./helpers-types.ts";
export type {
  AllUseItems,
  LayoutItem,
  RouteItem,
  ParallelItem,
  InterceptItem,
  MiddlewareItem,
  RevalidateItem,
  LoaderItem,
  ErrorBoundaryItem,
  NotFoundBoundaryItem,
  LayoutUseItem,
  RouteUseItem,
  ParallelUseItem,
  InterceptUseItem,
  WhenItem,
  CacheItem,
  InterceptSelectorContext,
  InterceptSegmentsState,
  InterceptWhenFn,
} from "./helpers-types.ts";

// DSL helpers
export {
  layout,
  cache,
  middleware,
  revalidate,
  parallel,
  intercept,
  when,
  errorBoundary,
  notFoundBoundary,
  loader,
  loading,
  transition,
} from "./dsl-helpers.ts";

// Helper factories and map
export {
  map,
  createRouteHelpers,
  type RouteHandlers,
} from "./helper-factories.ts";

// Redirect
export { redirect } from "./redirect.ts";

// Re-export createLoader from loader.rsc.ts for RSC/server context
export { createLoader } from "../loader.rsc.js";
