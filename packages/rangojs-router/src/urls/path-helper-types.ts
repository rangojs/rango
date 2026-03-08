import type { ReactNode } from "react";
import type {
  ErrorBoundaryHandler,
  ExtractParams,
  Handler,
  HandlerContext,
  LoaderDefinition,
  MiddlewareFn,
  NotFoundBoundaryHandler,
  PartialCacheOptions,
  ShouldRevalidateFn,
  TransitionConfig,
} from "../types.js";
import type {
  AllUseItems,
  TypedLayoutItem,
  ParallelItem,
  InterceptItem,
  MiddlewareItem,
  RevalidateItem,
  LoaderItem,
  LoadingItem,
  ErrorBoundaryItem,
  NotFoundBoundaryItem,
  LayoutUseItem,
  RouteUseItem,
  ResponseRouteUseItem,
  ParallelUseItem,
  InterceptUseItem,
  LoaderUseItem,
  WhenItem,
  TypedCacheItem,
  TransitionItem,
  TypedTransitionItem,
  TypedRouteItem,
  TypedIncludeItem,
  UseItems,
} from "../route-types.js";
import type { SearchSchema } from "../search-params.js";
import type { PrerenderHandlerDefinition } from "../prerender.js";
import type { StaticHandlerDefinition } from "../static-handler.js";
import type { InterceptWhenFn } from "../server/context";
import type {
  ResponseHandler,
  ResponseHandlerContext,
  TextResponseHandler,
} from "./response-types.js";
import type {
  UnnamedRoute,
  PathOptions,
  UrlPatterns,
  IncludeOptions,
} from "./pattern-types.js";
import type { ExtractRoutes, ExtractResponses } from "./type-extraction.js";

/**
 * Base path function signature for defining routes with URL patterns.
 */
export type PathFn<TEnv> = <
  const TPattern extends string,
  const TName extends string = UnnamedRoute,
  const TSearch extends SearchSchema = {},
  TParams extends Record<string, any> = ExtractParams<TPattern>,
>(
  pattern: TPattern,
  handler:
    | ReactNode
    | ((
        ctx: HandlerContext<TParams, TEnv, TSearch>,
      ) => ReactNode | Promise<ReactNode> | Response | Promise<Response>)
    | PrerenderHandlerDefinition<TParams>
    | StaticHandlerDefinition<TParams>,
  optionsOrUse?: PathOptions<TName, TSearch> | (() => UseItems<RouteUseItem>),
  use?: () => UseItems<RouteUseItem>,
  // Generic handler bypass: when handler uses index-signature params
  // (e.g. Handler<Record<string, any>>), skip the biconditional.
  // `string extends keyof TParams` is true for index signatures,
  // false for concrete params ({id: string}) and empty ({}).
  //
  // Subset check: pattern params must be assignable to handler params,
  // but handler can have MORE params (e.g. from parent include() prefix).
  // This allows Prerender<"locale.detail"> with {locale, slug} to mount
  // on path("/blog/:slug") where the pattern only declares {slug}.
) => string extends keyof TParams
  ? TypedRouteItem<TName, TPattern, unknown, TSearch>
  : TParams extends ExtractParams<TPattern>
    ? TypedRouteItem<TName, TPattern, unknown, TSearch>
    : { __error: `Handler params do not match pattern "${TPattern}"` };

/**
 * Path function for response routes that must return Response (image, stream, any).
 * Handler must return Response, not ReactNode. Uses lighter ResponseHandlerContext.
 * Use items restricted to middleware() and cache() only.
 */
export type ResponsePathFn<TEnv> = <
  const TPattern extends string,
  const TName extends string = UnnamedRoute,
  const TSearch extends SearchSchema = {},
>(
  pattern: TPattern,
  handler: ResponseHandler<ExtractParams<TPattern>, TEnv>,
  optionsOrUse?:
    | PathOptions<TName, TSearch>
    | (() => UseItems<ResponseRouteUseItem>),
  use?: () => UseItems<ResponseRouteUseItem>,
) => TypedRouteItem<TName, TPattern, unknown, TSearch>;

/**
 * Path function for JSON response routes (path.json()).
 * Handler can return plain JSON-serializable values or Response.
 * TData is inferred from the handler's return type (excluding Response/Promise wrappers).
 */
export type JsonResponsePathFn<TEnv> = <
  const TPattern extends string,
  const TName extends string = UnnamedRoute,
  const TSearch extends SearchSchema = {},
  TData = unknown,
>(
  pattern: TPattern,
  handler: (
    ctx: ResponseHandlerContext<ExtractParams<TPattern>, TEnv>,
  ) => TData | Response | Promise<TData | Response>,
  optionsOrUse?:
    | PathOptions<TName, TSearch>
    | (() => UseItems<ResponseRouteUseItem>),
  use?: () => UseItems<ResponseRouteUseItem>,
) => TypedRouteItem<TName, TPattern, TData, TSearch>;

/**
 * Path function for text-based response routes (path.text(), path.html(), path.xml()).
 * Handler can return a string or Response. TData is always `string`.
 */
export type TextResponsePathFn<TEnv> = <
  const TPattern extends string,
  const TName extends string = UnnamedRoute,
  const TSearch extends SearchSchema = {},
>(
  pattern: TPattern,
  handler: TextResponseHandler<ExtractParams<TPattern>, TEnv>,
  optionsOrUse?:
    | PathOptions<TName, TSearch>
    | (() => UseItems<ResponseRouteUseItem>),
  use?: () => UseItems<ResponseRouteUseItem>,
) => TypedRouteItem<TName, TPattern, string, TSearch>;

/**
 * Base include function signature.
 */
export type IncludeFn<TEnv> = <
  TRoutes extends Record<string, any>,
  const TUrlPrefix extends string,
  const TNamePrefix extends string = never,
  TResponses extends Record<string, unknown> = Record<string, unknown>,
>(
  prefix: TUrlPrefix,
  patterns: UrlPatterns<TEnv, TRoutes, TResponses>,
  options?: IncludeOptions<TNamePrefix>,
) => TypedIncludeItem<TRoutes, TNamePrefix, TUrlPrefix, TResponses>;

export type PathHelpers<TEnv> = {
  /**
   * Define a route with URL pattern at definition site
   *
   * @example
   * ```typescript
   * // Pattern and component only
   * path("/about", AboutPage)
   *
   * // With options
   * path("/:slug", PostPage, { name: "post" })
   *
   * // With children (loaders, middleware, etc.)
   * path("/:slug", PostPage, { name: "post" }, () => [
   *   loader(PostLoader),
   * ])
   * ```
   */
  path: PathFn<TEnv> & {
    json: JsonResponsePathFn<TEnv>;
    text: TextResponsePathFn<TEnv>;
    html: TextResponsePathFn<TEnv>;
    xml: TextResponsePathFn<TEnv>;
    md: TextResponsePathFn<TEnv>;
    image: ResponsePathFn<TEnv>;
    stream: ResponsePathFn<TEnv>;
    any: ResponsePathFn<TEnv>;
  };

  /**
   * Define a layout that wraps child routes
   */
  layout: {
    (
      component: ReactNode | Handler<any, any, TEnv> | StaticHandlerDefinition,
    ): TypedLayoutItem<{}, {}>;
    <
      const TChildren extends readonly (
        | LayoutUseItem
        | readonly LayoutUseItem[]
      )[],
    >(
      component: ReactNode | Handler<any, any, TEnv> | StaticHandlerDefinition,
      use: () => TChildren,
    ): TypedLayoutItem<ExtractRoutes<TChildren>, ExtractResponses<TChildren>>;
  };

  /**
   * Include nested URL patterns with optional name prefix
   *
   * ```typescript
   * // Without name - routes keep local names
   * include("/blog", blogPatterns)
   *
   * // With name - routes are prefixed (e.g., "index" -> "blog.index")
   * include("/blog", blogPatterns, { name: "blog" })
   * ```
   */
  include: IncludeFn<TEnv>;

  /**
   * Define parallel routes that render simultaneously in named slots
   */
  parallel: <
    TSlots extends Record<
      `@${string}`,
      Handler<any, any, TEnv> | ReactNode | StaticHandlerDefinition
    >,
  >(
    slots: TSlots,
    use?: () => ParallelUseItem[],
  ) => ParallelItem;

  /**
   * Define an intercepting route for soft navigation
   * Note: routeName must match a named path() in this urlpatterns
   */
  intercept: keyof RSCRouter.GeneratedRouteMap extends never
    ? (
        slotName: `@${string}`,
        routeName: string,
        handler: ReactNode | Handler<any, any, TEnv>,
        use?: () => InterceptUseItem[],
      ) => InterceptItem
    : (
        slotName: `@${string}`,
        routeName: (keyof RSCRouter.GeneratedRouteMap & string) | `.${string}`,
        handler: ReactNode | Handler<any, any, TEnv>,
        use?: () => InterceptUseItem[],
      ) => InterceptItem;

  /**
   * Attach middleware to the current route/layout
   */
  middleware: (...fns: MiddlewareFn<TEnv>[]) => MiddlewareItem;

  /**
   * Control when a segment should revalidate during navigation
   */
  revalidate: (fn: ShouldRevalidateFn<any, TEnv>) => RevalidateItem;

  /**
   * Attach a data loader to the current route/layout
   */
  loader: <TData>(
    loaderDef: LoaderDefinition<TData>,
    use?: () => LoaderUseItem[],
  ) => LoaderItem;

  /**
   * Attach a loading component to the current route/layout
   */
  loading: (component: ReactNode, options?: { ssr?: boolean }) => LoadingItem;

  /**
   * Attach an error boundary to catch errors in this segment
   */
  errorBoundary: (
    fallback: ReactNode | ErrorBoundaryHandler,
  ) => ErrorBoundaryItem;

  /**
   * Attach a not-found boundary to handle notFound() calls
   */
  notFoundBoundary: (
    fallback: ReactNode | NotFoundBoundaryHandler,
  ) => NotFoundBoundaryItem;

  /**
   * Define a condition for when an intercept should activate
   */
  when: (fn: InterceptWhenFn) => WhenItem;

  /**
   * Define cache configuration for segments
   */
  cache: {
    (): TypedCacheItem<{}, {}>;
    <const TChildren extends readonly (AllUseItems | readonly AllUseItems[])[]>(
      children: () => TChildren,
    ): TypedCacheItem<ExtractRoutes<TChildren>, ExtractResponses<TChildren>>;
    (options: PartialCacheOptions | false): TypedCacheItem<{}, {}>;
    <const TChildren extends readonly (AllUseItems | readonly AllUseItems[])[]>(
      options: PartialCacheOptions | false,
      use: () => TChildren,
    ): TypedCacheItem<ExtractRoutes<TChildren>, ExtractResponses<TChildren>>;
  };

  /**
   * Attach a ViewTransition boundary to the current segment or a group of routes
   */
  transition: {
    (): TransitionItem;
    (config: TransitionConfig): TransitionItem;
    <const TChildren extends readonly (AllUseItems | readonly AllUseItems[])[]>(
      children: () => TChildren,
    ): TypedTransitionItem<
      ExtractRoutes<TChildren>,
      ExtractResponses<TChildren>
    >;
    <const TChildren extends readonly (AllUseItems | readonly AllUseItems[])[]>(
      config: TransitionConfig,
      children: () => TChildren,
    ): TypedTransitionItem<
      ExtractRoutes<TChildren>,
      ExtractResponses<TChildren>
    >;
  };
};
