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
  loaderFn,
  loadingFn,
  transitionFn,
  routeFn,
} from "./dsl-helpers.js";
import RootLayout from "../server/root-layout";
import { invariant } from "../errors";

/*
 * Create revalidate helper
 */
const createRevalidateHelper = <TEnv>(): RouteHelpers<
  any,
  TEnv
>["revalidate"] => {
  return revalidate as RouteHelpers<any, TEnv>["revalidate"];
};

/**
 * Create errorBoundary helper
 */
const createErrorBoundaryHelper = <TEnv>(): RouteHelpers<
  any,
  TEnv
>["errorBoundary"] => {
  return errorBoundary as RouteHelpers<any, TEnv>["errorBoundary"];
};

/**
 * Create notFoundBoundary helper
 */
const createNotFoundBoundaryHelper = <TEnv>(): RouteHelpers<
  any,
  TEnv
>["notFoundBoundary"] => {
  return notFoundBoundary as RouteHelpers<any, TEnv>["notFoundBoundary"];
};

/**
 * Create middleware helper
 */
const createMiddlewareHelper = <TEnv>(): RouteHelpers<
  any,
  TEnv
>["middleware"] => {
  return middleware as RouteHelpers<any, TEnv>["middleware"];
};

/**
 * Create parallel helper
 */
const createParallelHelper = <TEnv>(): RouteHelpers<any, TEnv>["parallel"] => {
  return parallel as RouteHelpers<any, TEnv>["parallel"];
};

/**
 * Create intercept helper
 */
const createInterceptHelper = <
  const T extends RouteDefinition,
  TEnv,
>(): RouteHelpers<T, TEnv>["intercept"] => {
  return intercept as RouteHelpers<T, TEnv>["intercept"];
};

/**
 * Create loader helper
 */
const createLoaderHelper = <TEnv>(): RouteHelpers<any, TEnv>["loader"] => {
  return loaderFn as RouteHelpers<any, TEnv>["loader"];
};

/**
 * Create loading helper
 */
const createLoadingHelper = (): RouteHelpers<any, any>["loading"] => {
  return loadingFn;
};

/**
 * Create route helper
 */
const createRouteHelper = <
  const T extends RouteDefinition,
  TEnv,
>(): RouteHelpers<T, TEnv>["route"] => {
  return routeFn as unknown as RouteHelpers<T, TEnv>["route"];
};

/**
 * Create layout helper
 */
const createLayoutHelper = <TEnv>(): RouteHelpers<any, TEnv>["layout"] => {
  return layout as RouteHelpers<any, TEnv>["layout"];
};

/**
 * Create when helper for intercept conditions
 */
const createWhenHelper = (): RouteHelpers<any, any>["when"] => {
  return when;
};

/**
 * Create cache helper for cache configuration
 */
const createCacheHelper = (): RouteHelpers<any, any>["cache"] => {
  return cache;
};

/**
 * Create transition helper
 */
const createTransitionHelper = (): RouteHelpers<any, any>["transition"] => {
  return transitionFn as RouteHelpers<any, any>["transition"];
};

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
    const helpers: RouteHelpers<T, TEnv> = {
      route: createRouteHelper<T, TEnv>(),
      layout: createLayoutHelper<TEnv>(),
      parallel: createParallelHelper<TEnv>(),
      intercept: createInterceptHelper<T, TEnv>(),
      middleware: createMiddlewareHelper<TEnv>(),
      revalidate: createRevalidateHelper<TEnv>(),
      loader: createLoaderHelper<TEnv>(),
      loading: createLoadingHelper(),
      errorBoundary: createErrorBoundaryHelper<TEnv>(),
      notFoundBoundary: createNotFoundBoundaryHelper<TEnv>(),
      when: createWhenHelper(),
      cache: createCacheHelper(),
      transition: createTransitionHelper(),
    };

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
  return {
    route: createRouteHelper<T, TEnv>(),
    layout: createLayoutHelper<TEnv>(),
    parallel: createParallelHelper<TEnv>(),
    intercept: createInterceptHelper<T, TEnv>(),
    middleware: createMiddlewareHelper<TEnv>(),
    revalidate: createRevalidateHelper<TEnv>(),
    loader: createLoaderHelper<TEnv>(),
    loading: createLoadingHelper(),
    errorBoundary: createErrorBoundaryHelper<TEnv>(),
    notFoundBoundary: createNotFoundBoundaryHelper<TEnv>(),
    when: createWhenHelper(),
    cache: createCacheHelper(),
    transition: createTransitionHelper(),
  };
}
