import type { ReactNode } from "react";
import type {
  ErrorBoundaryHandler,
  ExtractParams,
  Handler,
  HandlerContext,
  LoaderDefinition,
  LoaderOptions,
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
  TypedCacheItem,
  TransitionItem,
  TypedTransitionItem,
  TypedRouteItem,
  TypedIncludeItem,
  UseItems,
} from "../route-types.js";
import type { SearchSchema } from "../search-params.js";
import type {
  PrerenderHandlerDefinition,
  PassthroughHandlerDefinition,
} from "../prerender.js";
import type {
  StaticHandlerDefinition,
  StaticHandlerRef,
} from "../static-handler.js";
import type {
  ResponseHandler,
  ResponseHandlerContext,
  TextResponseHandler,
} from "./response-types.js";
import type {
  UnnamedRoute,
  LocalOnlyInclude,
  PathOptions,
  UrlPatterns,
  IncludeOptions,
} from "./pattern-types.js";
import type { ExtractRoutes, ExtractResponses } from "./type-extraction.js";
import type { ClientUrlPatterns } from "../client-urls/types.js";

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
      ) => ReactNode | Response | Promise<ReactNode | Response>)
    | PrerenderHandlerDefinition<TParams>
    | PassthroughHandlerDefinition<TParams, TEnv>
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
 *
 * Note: a nested Promise in the return (a forgotten await) is caught at runtime
 * by response-route-handler.ts (it throws instead of silently emitting `{}`). A
 * compile-time JsonValue constraint was evaluated and rejected — it breaks
 * interface-typed returns (interfaces lack the index signature JsonValue
 * requires) and preserves literal types in the inferred response shape.
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
 * What an async include() provider resolves to. Route types (`TRoutes`) are
 * inferred from the resolved `urls()` value so `href()` and named routes stay
 * type-safe through a code-split module (`() => import("./routes")`).
 */
type IncludeResolved<
  TEnv,
  TRoutes extends Record<string, any>,
  TResponses extends Record<string, unknown>,
> =
  | UrlPatterns<TEnv, TRoutes, TResponses>
  | { default: UrlPatterns<TEnv, TRoutes, TResponses> };

/** include() argument: an eager `urls()` value or an async provider thunk. */
export type IncludeArg<
  TEnv,
  TRoutes extends Record<string, any>,
  TResponses extends Record<string, unknown>,
> =
  | UrlPatterns<TEnv, TRoutes, TResponses>
  // clientUrls() definitions mount through include() like any urls() module;
  // on the server the runtime value is the module's client reference, but the
  // TypeScript type of that default export IS ClientUrlPatterns, so route
  // names flow into NamedRoutes through the same TRoutes inference.
  | ClientUrlPatterns<TRoutes>
  | (() =>
      | IncludeResolved<TEnv, TRoutes, TResponses>
      | Promise<IncludeResolved<TEnv, TRoutes, TResponses>>);

/**
 * Base include function signature.
 */
export type IncludeFn<TEnv> = <
  TRoutes extends Record<string, any>,
  const TUrlPrefix extends string,
  const TNamePrefix extends string = LocalOnlyInclude,
  TResponses extends Record<string, unknown> = Record<string, unknown>,
>(
  prefix: TUrlPrefix,
  patterns: IncludeArg<TEnv, TRoutes, TResponses>,
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
   * Include nested URL patterns under a URL prefix.
   *
   * The `name` option controls how child route names appear in the
   * global route map and generated types:
   *
   * ```typescript
   * // Named — children become "blog.index", "blog.post", etc.
   * // Visible in generated types and globally reversible.
   * include("/blog", blogPatterns, { name: "blog" })
   *
   * // Flattened — children merge into the parent namespace as-is.
   * // Equivalent to defining those routes inline at the include site.
   * include("/blog", blogPatterns, { name: "" })
   *
   * // Local-only (default) — children are scoped privately.
   * // Hidden from generated types and global reverse resolution.
   * // Only dot-local reverse (reverse(".child")) works inside.
   * include("/blog", blogPatterns)
   * ```
   */
  include: IncludeFn<TEnv>;

  /**
   * Define parallel routes that render simultaneously in named slots.
   *
   * A slot value can be a Handler / ReactNode / StaticHandlerDefinition
   * (legacy form, broadcast use applies to every slot) or a slot descriptor
   * `{ handler, use? }` whose `use` is scoped to that slot only. Per-slot
   * merge order is `handler.use` → shared `use` → slot-local `use`, with
   * narrowest scope winning for last-write-wins items like `loading()`.
   *
   * Not generic over the slots record: an inferred type parameter makes the
   * object literal an inference site, which suppresses contextual typing of
   * arrow slot handlers (`(ctx) => ...` was implicit any). Static() values use
   * an opaque handler-less reference here so their own `.handler` cannot
   * contribute a second call signature or expose internal fields in completion.
   */
  parallel: (
    slots: Record<
      `@${string}`,
      | Handler<any, any, TEnv>
      | ReactNode
      | StaticHandlerRef
      | {
          handler: Handler<any, any, TEnv> | ReactNode | StaticHandlerRef;
          use?: () => ParallelUseItem[];
        }
    >,
    use?: () => ParallelUseItem[],
  ) => ParallelItem;

  /**
   * Define an intercepting route for soft navigation
   * Note: routeName must match a named path() in this urlpatterns
   */
  intercept: keyof Rango.GeneratedRouteMap extends never
    ? (
        slotName: `@${string}`,
        routeName: string,
        handler: ReactNode | Handler<any, any, TEnv>,
        config?:
          | import("../server/context.js").InterceptConfig<TEnv>
          | (() => InterceptUseItem[]),
        use?: () => InterceptUseItem[],
      ) => InterceptItem
    : (
        slotName: `@${string}`,
        routeName: (keyof Rango.GeneratedRouteMap & string) | `.${string}`,
        handler: ReactNode | Handler<any, any, TEnv>,
        config?:
          | import("../server/context.js").InterceptConfig<TEnv>
          | (() => InterceptUseItem[]),
        use?: () => InterceptUseItem[],
      ) => InterceptItem;

  /**
   * Attach middleware to the current route/layout, or wrap child segments
   */
  middleware: {
    (fn: MiddlewareFn<TEnv>): MiddlewareItem;
    (
      fn: MiddlewareFn<TEnv>,
      children: () => UseItems<LayoutUseItem>,
    ): MiddlewareItem;
    (fns: MiddlewareFn<TEnv>[]): MiddlewareItem;
    (
      fns: MiddlewareFn<TEnv>[],
      children: () => UseItems<LayoutUseItem>,
    ): MiddlewareItem;
  };

  /**
   * Control when a segment should revalidate during navigation
   */
  revalidate: (fn: ShouldRevalidateFn<any, TEnv>) => RevalidateItem;

  /**
   * Attach a data loader to the current route/layout.
   *
   * Pass `{ stream: "navigation" }` to await this loader before first flush
   * on DOCUMENT requests (see {@link LoaderOptions}) — the opt-in for loaders
   * whose data, handle pushes, or thrown notFound()/redirect() must be in the
   * SSR'd HTML. Per-loader: a dynamic sibling keeps streaming.
   */
  loader: <TData>(
    loaderDef: LoaderDefinition<TData>,
    optionsOrUse?: LoaderOptions | (() => LoaderUseItem[]),
    use?: () => LoaderUseItem[],
  ) => LoaderItem;

  /**
   * Attach a loading component to the current route/layout
   */
  loading: (
    component: ReactNode | (() => ReactNode),
    options?: { ssr?: boolean },
  ) => LoadingItem;

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
   * Define cache configuration for segments
   */
  cache: {
    (): TypedCacheItem<{}, {}>;
    <const TChildren extends readonly (AllUseItems | readonly AllUseItems[])[]>(
      children: () => TChildren,
    ): TypedCacheItem<ExtractRoutes<TChildren>, ExtractResponses<TChildren>>;
    (options: PartialCacheOptions<TEnv> | false): TypedCacheItem<{}, {}>;
    <const TChildren extends readonly (AllUseItems | readonly AllUseItems[])[]>(
      options: PartialCacheOptions<TEnv> | false,
      use: () => TChildren,
    ): TypedCacheItem<ExtractRoutes<TChildren>, ExtractResponses<TChildren>>;
  };

  /**
   * Opt a route (or group of routes) into transition-driven navigation.
   *
   * Two independent layers: (1) startTransition, on all React versions, holds
   * the previous content across a same-route nav (no skeleton flash) and is the
   * precondition for any view transition; (2) on experimental React, an
   * additional `<ViewTransition>` boundary cross-fades/morphs the swap. Pass
   * `{ viewTransition: false }` to keep #1 without the router boundary. A view
   * transition cannot fire without a startTransition. See
   * skills/view-transitions for the startTransition x ViewTransition matrix.
   *
   * Pass `when: (ctx) => boolean` to gate the transition per request. It normally
   * runs after the route handler; `ppr` routes automatically run it before route
   * handlers and on every replay, where `ctx.get(...)` sees middleware state but
   * not handler-set values.
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
