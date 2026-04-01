// Type definitions
export type { RouteHelpers } from "./helpers-types.js";
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
} from "./helpers-types.js";

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
} from "./dsl-helpers.js";

// Helper factories and map
export {
  map,
  createRouteHelpers,
  type RouteHandlers,
} from "./helper-factories.js";

// Handler use resolver
export { resolveHandlerUse } from "./resolve-handler-use.js";

// Redirect
export { redirect } from "./redirect.js";

// Re-export createLoader from loader.rsc.ts for RSC/server context
export { createLoader } from "../loader.rsc.js";
