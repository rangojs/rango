/**
 * Django-inspired URL patterns for @rangojs/router
 *
 * This module provides `urls()` and `path()` for defining routes with
 * URL patterns visible at the definition site.
 *
 * @example
 * ```typescript
 * // urls/blog.ts
 * export const blogPatterns = urls(({ path, layout, loader }) => [
 *   layout(BlogLayout, () => [
 *     path("/", BlogIndex, { name: "index" }),
 *     path("/:slug", BlogPost, { name: "post" }, () => [
 *       loader(PostLoader),
 *     ]),
 *   ]),
 * ]);
 *
 * // urls/index.ts
 * export const urlpatterns = urls(({ path, layout, include }) => [
 *   layout(RootLayout, () => [
 *     path("/", HomePage, { name: "home" }),
 *     include("/blog", blogPatterns, { name: "blog" }),
 *   ]),
 * ]);
 * ```
 */
import type { ReactNode } from "react";
import type {
  DefaultEnv,
  ErrorBoundaryHandler,
  ExtractParams,
  Handler,
  HandlerContext,
  LoaderDefinition,
  MiddlewareFn,
  NotFoundBoundaryHandler,
  PartialCacheOptions,
  RouterEnv,
  ShouldRevalidateFn,
  TrailingSlashMode,
} from "./types.js";
import type { CookieOptions } from "./router/middleware.js";
import type {
  AllUseItems,
  LayoutItem,
  TypedLayoutItem,
  RouteItem,
  TypedRouteItem,
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
  CacheItem,
  TypedCacheItem,
  IncludeItem,
  TypedIncludeItem,
  IncludeBrand,
  UrlPatternsBrand,
} from "./route-types.js";
import {
  getContext,
  runWithPrefixes,
  getUrlPrefix,
  getNamePrefix,
  type EntryData,
  type InterceptEntry,
  type InterceptWhenFn,
} from "./server/context";
import { invariant } from "./errors";
import {
  isPrerenderHandler,
  type PrerenderHandlerDefinition,
} from "./prerender.js";

// ============================================================================
// Response Route Symbol and Types
// ============================================================================

/**
 * Symbol marking a route as a response route (non-RSC).
 * Stored on PathOptions and UrlPatterns to signal the trie to short-circuit.
 */
export const RESPONSE_TYPE: unique symbol = Symbol.for(
  "rangojs.responseType",
) as any;

/**
 * Handler that must return Response (not ReactNode).
 * Used by path.image(), path.stream(), path.any() (binary/streaming data).
 */
export type ResponseHandler<TParams = Record<string, string>, TEnv = any> = (
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => Response | Promise<Response>;

/**
 * JSON-serializable value type for auto-wrap support.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Handler for JSON response routes.
 * Can return a plain JSON-serializable value (auto-wrapped) or Response (pass-through).
 */
export type JsonResponseHandler<
  TParams = Record<string, string>,
  TEnv = any,
> = (
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => JsonValue | Response | Promise<JsonValue | Response>;

/**
 * Handler for text-based response routes (text, html, xml).
 * Can return a string (auto-wrapped) or Response (pass-through).
 */
export type TextResponseHandler<
  TParams = Record<string, string>,
  TEnv = any,
> = (
  ctx: ResponseHandlerContext<TParams, TEnv>,
) => string | Response | Promise<string | Response>;

/**
 * Lighter handler context for response routes.
 * No ctx.use() (no loaders). Supports setting response headers and cookies
 * without constructing a full Response object.
 */
export interface ResponseHandlerContext<
  TParams = Record<string, string>,
  TEnv = any,
> {
  request: Request;
  params: TParams;
  /** @internal Phantom property for params type invariance. Prevents mounting handlers on wrong routes. */
  readonly _paramCheck?: (params: TParams) => TParams;
  /** Platform bindings (DB, KV, secrets, etc.) extracted from RouterEnv. */
  env: TEnv extends RouterEnv<infer B, any> ? B : {};
  /** Query parameters from the URL (system params like `_rsc*` are filtered). */
  searchParams: URLSearchParams;
  /** The full URL object (with system params filtered). */
  url: URL;
  /** The pathname portion of the request URL. */
  pathname: string;
  reverse: (name: string, params?: Record<string, string>) => string;
  /** Read a variable set by middleware via ctx.set(key, value). */
  get: (key: string) => unknown;
  /** Set a response header. Merged into the auto-wrapped or pass-through Response. */
  header: (name: string, value: string) => void;
  /** Set a cookie on the response. */
  setCookie: (name: string, value: string, options?: CookieOptions) => void;
}


// ============================================================================
// Types
// ============================================================================

/**
 * Sentinel type for unnamed routes.
 * Using a branded string instead of `never` prevents TypeScript from
 * widening array type inference when mixing named and unnamed routes.
 */
export type UnnamedRoute = "$unnamed";

/**
 * Options for path() function
 */
export interface PathOptions<TName extends string = string> {
  /** Route name for href() lookups */
  name?: TName;
  /** Trailing slash behavior: "never" (redirect /path/ to /path), "always" (redirect /path to /path/), "ignore" (match both) */
  trailingSlash?: TrailingSlashMode;
  /** Response type marker (set by path.json(), etc.) */
  [RESPONSE_TYPE]?: string;
}

/**
 * Internal representation of a URL pattern definition
 */
export interface PathDefinition {
  pattern: string;
  name?: string;
  handler: ReactNode | Handler<any, any, any>;
  use?: RouteUseItem[];
}

/**
 * Result of urls() - contains the route definitions
 */
export interface UrlPatterns<
  TEnv = any,
  TRoutes extends Record<string, string> = Record<string, string>,
  TResponses extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Internal: route definitions */
  readonly definitions: PathDefinition[];
  /** Internal: compiled handler function */
  readonly handler: () => AllUseItems[];
  /** Internal: trailing slash config per route name */
  readonly trailingSlash: Record<string, TrailingSlashMode>;
  /** Brand for type checking */
  readonly [UrlPatternsBrand]: void;
  /** Environment type brand (phantom) */
  readonly _env?: TEnv;
  /** Routes type brand (phantom) - carries route name -> pattern mapping */
  readonly _routes?: TRoutes;
  /** Responses type brand (phantom) - carries route name -> response data type mapping */
  readonly _responses?: TResponses;
}

/**
 * Options for include()
 */
export interface IncludeOptions<TNamePrefix extends string = string> {
  /** Name prefix for all routes in this pattern set */
  name?: TNamePrefix;
}

// ============================================================================
// Route Type Extraction Utilities
// ============================================================================

/**
 * Prefix route names with a given prefix (e.g., "blog" + "post" = "blog.post")
 *
 * Filters out plain `string` index signatures to prevent dynamically-generated
 * routes from poisoning the route map. When TypeScript encounters very large
 * route sets (5000+ routes via Array.from), it may give up computing specific
 * types and fall back to Record<string, string>. Without filtering, PrefixRoutes
 * would map `string` to `${prefix}.${string}`, creating an index signature that
 * accepts ANY prefixed name and defeats type-safe route checking.
 *
 * Uses `string extends K` (conservative filter):
 * - Drops `string` keys (TypeScript fallback) -> prevents `[x: `site.${string}`]`
 * - Keeps template literal patterns like `item${number}` from Array.from loops,
 *   which are imprecise but still allow writing paths like `/shop/product/1`
 *
 * A more aggressive alternative (`{} extends Record<K, 1>`) would also drop
 * template literal patterns. We chose conservative because loop-generated routes
 * with `${number}` patterns still provide some value: they don't appear in
 * named-routes.gen.ts or IDE autocomplete, but they do let you manually write
 * valid paths without type errors.
 */
type PrefixRoutes<
  TRoutes extends Record<string, string>,
  TPrefix extends string,
> = TPrefix extends ""
  ? TRoutes
  : {
      [K in keyof TRoutes as K extends string
        ? string extends K
          ? never
          : `${TPrefix}.${K}`
        : never]: TRoutes[K];
    };

/**
 * Prefix route patterns with a URL prefix (e.g., "/blog" + "/:slug" = "/blog/:slug")
 */
type PrefixPatterns<
  TRoutes extends Record<string, string>,
  TUrlPrefix extends string,
> = {
  [K in keyof TRoutes]: TRoutes[K] extends string
    ? `${TUrlPrefix}${TRoutes[K]}`
    : TRoutes[K];
};

/**
 * Depth counter for limiting recursion (max 40 levels)
 * Supports up to 40 sibling items at any level of a urls() call
 * Note: Higher values hit TypeScript's internal recursion limits
 */
type Depth = [
  never,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
];

/**
 * Force TypeScript to eagerly evaluate a type.
 * This helps with interface extension by creating a "concrete" object type.
 */
type Simplify<T> =
  T extends Record<string, string> ? { [K in keyof T]: T[K] } : T;

/**
 * Convert a union type to an intersection type.
 * Used to combine route maps from multiple siblings without recursive tuple processing.
 */
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/**
 * Extract routes from a single item (path, include, layout, cache with children)
 * D is the current depth level for nested layouts/caches
 */
type ExtractRoutesFromItem<T, D extends number = 40> = [D] extends [never]
  ? {} // Max depth reached, stop recursion
  : // TypedRouteItem: extract name -> pattern (exclude unnamed routes)
    T extends TypedRouteItem<infer TName, infer TPattern>
    ? TName extends string
      ? TName extends UnnamedRoute
        ? {} // Exclude unnamed routes from type map
        : { [K in TName]: TPattern }
      : {}
    : // TypedIncludeItem: extract prefixed routes (both name and URL prefix)
      T extends TypedIncludeItem<
          infer TRoutes,
          infer TNamePrefix,
          infer TUrlPrefix
        >
      ? TNamePrefix extends string
        ? TUrlPrefix extends string
          ? PrefixRoutes<PrefixPatterns<TRoutes, TUrlPrefix>, TNamePrefix>
          : PrefixRoutes<TRoutes, TNamePrefix>
        : TUrlPrefix extends string
          ? PrefixPatterns<TRoutes, TUrlPrefix>
          : TRoutes
      : // TypedLayoutItem: extract child routes from phantom type
        T extends TypedLayoutItem<infer TChildRoutes>
        ? TChildRoutes
        : // TypedCacheItem: extract child routes from phantom type
          T extends TypedCacheItem<infer TChildRoutes>
          ? TChildRoutes
          : // Fallback (won't extract routes)
            {};

/**
 * Extract routes from an array of items using mapped types.
 * Uses UnionToIntersection to combine routes without recursive tuple processing,
 * removing the sibling limit that was caused by TypeScript recursion limits.
 * D is passed to ExtractRoutesFromItem for nested depth tracking.
 */
type ExtractRoutesFromItems<
  T extends readonly any[],
  D extends number = 40,
> = T extends readonly any[]
  ? UnionToIntersection<
      { [K in keyof T]: ExtractRoutesFromItem<T[K], D> }[number]
    > extends infer R
    ? R extends Record<string, string>
      ? R
      : {}
    : {}
  : {};

/**
 * Main utility: extract route map from urls() callback return type
 * Uses mapped types for sibling processing (no sibling limit).
 * Uses Simplify to force eager evaluation for interface extension compatibility.
 */
export type ExtractRoutes<T extends readonly any[]> = ExtractRoutesFromItems<
  T,
  40
>;

// ============================================================================
// Response Type Extraction Utilities
// ============================================================================

/**
 * Prefix keys of a Record<string, unknown> with a dot-separated prefix.
 * Used for response type maps through include().
 * Same index signature filter as PrefixRoutes (see comment there).
 */
type PrefixKeys<
  T extends Record<string, unknown>,
  TPrefix extends string,
> = TPrefix extends ""
  ? T
  : {
      [K in keyof T as K extends string
        ? string extends K
          ? never
          : `${TPrefix}.${K}`
        : never]: T[K];
    };

/**
 * Extract response data types from a single item.
 * Parallel to ExtractRoutesFromItem but extracts name -> TData mapping.
 */
type ExtractResponsesFromItem<T, D extends number = 40> = [D] extends [never]
  ? {}
  : T extends TypedRouteItem<infer TName, any, infer TData>
    ? TName extends string
      ? TName extends UnnamedRoute
        ? {}
        : { [K in TName]: TData }
      : {}
    : T extends TypedIncludeItem<any, infer TNamePrefix, any, infer TResponses>
      ? TNamePrefix extends string
        ? TResponses extends Record<string, unknown>
          ? PrefixKeys<TResponses, TNamePrefix>
          : {}
        : TResponses extends Record<string, unknown>
          ? TResponses
          : {}
      : T extends TypedLayoutItem<any, infer TChildResponses>
        ? TChildResponses extends Record<string, unknown>
          ? TChildResponses
          : {}
        : T extends TypedCacheItem<any, infer TChildResponses>
          ? TChildResponses extends Record<string, unknown>
            ? TChildResponses
            : {}
          : {};

/**
 * Extract responses from an array of items using mapped types.
 * Parallel to ExtractRoutesFromItems.
 */
type ExtractResponsesFromItems<
  T extends readonly any[],
  D extends number = 40,
> = T extends readonly any[]
  ? UnionToIntersection<
      { [K in keyof T]: ExtractResponsesFromItem<T[K], D> }[number]
    > extends infer R
    ? R extends Record<string, unknown>
      ? R
      : {}
    : {}
  : {};

/**
 * Main utility: extract response data type map from urls() callback return type.
 * Parallel to ExtractRoutes.
 */
export type ExtractResponses<T extends readonly any[]> =
  ExtractResponsesFromItems<T, 40>;

// ============================================================================
// Path Helpers Type
// ============================================================================

/**
 * Helpers provided by urls()
 */
/**
 * Base path function signature for defining routes with URL patterns.
 */
export type PathFn<TEnv> = <
  const TPattern extends string,
  const TName extends string = UnnamedRoute,
  TParams = ExtractParams<TPattern>,
>(
  pattern: TPattern,
  handler:
    | ReactNode
    | ((ctx: HandlerContext<TParams, TEnv>) => ReactNode | Promise<ReactNode> | Response | Promise<Response>)
    | PrerenderHandlerDefinition<TParams>,
  optionsOrUse?: PathOptions<TName> | (() => RouteUseItem[]),
  use?: () => RouteUseItem[],
  // Generic handler bypass: when handler uses index-signature params
  // (e.g. Handler<Record<string, any>>), skip the biconditional.
  // `string extends keyof TParams` is true for index signatures,
  // false for concrete params ({id: string}) and empty ({}).
) => string extends keyof TParams
  ? TypedRouteItem<TName, TPattern>
  : ExtractParams<TPattern> extends TParams
    ? TParams extends ExtractParams<TPattern>
      ? TypedRouteItem<TName, TPattern>
      : { __error: `Handler params do not match pattern "${TPattern}"` }
    : { __error: `Handler params do not match pattern "${TPattern}"` };

/**
 * Path function for response routes that must return Response (image, stream, any).
 * Handler must return Response, not ReactNode. Uses lighter ResponseHandlerContext.
 * Use items restricted to middleware() and cache() only.
 */
export type ResponsePathFn<TEnv> = <
  const TPattern extends string,
  const TName extends string = UnnamedRoute,
>(
  pattern: TPattern,
  handler: ResponseHandler<ExtractParams<TPattern>, TEnv>,
  optionsOrUse?: PathOptions<TName> | (() => ResponseRouteUseItem[]),
  use?: () => ResponseRouteUseItem[],
) => TypedRouteItem<TName, TPattern>;

/**
 * Path function for JSON response routes (path.json()).
 * Handler can return plain JSON-serializable values or Response.
 * TData is inferred from the handler's return type (excluding Response/Promise wrappers).
 */
export type JsonResponsePathFn<TEnv> = <
  const TPattern extends string,
  const TName extends string = UnnamedRoute,
  TData = unknown,
>(
  pattern: TPattern,
  handler: (
    ctx: ResponseHandlerContext<ExtractParams<TPattern>, TEnv>,
  ) => TData | Response | Promise<TData | Response>,
  optionsOrUse?: PathOptions<TName> | (() => ResponseRouteUseItem[]),
  use?: () => ResponseRouteUseItem[],
) => TypedRouteItem<TName, TPattern, TData>;

/**
 * Path function for text-based response routes (path.text(), path.html(), path.xml()).
 * Handler can return a string or Response. TData is always `string`.
 */
export type TextResponsePathFn<TEnv> = <
  const TPattern extends string,
  const TName extends string = UnnamedRoute,
>(
  pattern: TPattern,
  handler: TextResponseHandler<ExtractParams<TPattern>, TEnv>,
  optionsOrUse?: PathOptions<TName> | (() => ResponseRouteUseItem[]),
  use?: () => ResponseRouteUseItem[],
) => TypedRouteItem<TName, TPattern, string>;

/**
 * Base include function signature.
 */
export type IncludeFn<TEnv> = <
  TRoutes extends Record<string, string>,
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
    (component: ReactNode | Handler<any, any, TEnv>): TypedLayoutItem<{}, {}>;
    <const TChildren extends readonly LayoutUseItem[]>(
      component: ReactNode | Handler<any, any, TEnv>,
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
   * // With name - routes are prefixed (e.g., "index" → "blog.index")
   * include("/blog", blogPatterns, { name: "blog" })
   * ```
   */
  include: IncludeFn<TEnv>;

  /**
   * Define parallel routes that render simultaneously in named slots
   */
  parallel: <
    TSlots extends Record<`@${string}`, Handler<any, any, TEnv> | ReactNode>,
  >(
    slots: TSlots,
    use?: () => ParallelUseItem[],
  ) => ParallelItem;

  /**
   * Define an intercepting route for soft navigation
   * Note: routeName must match a named path() in this urlpatterns
   */
  intercept: (
    slotName: `@${string}`,
    routeName: string,
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
    <const TChildren extends readonly AllUseItems[]>(
      children: () => TChildren,
    ): TypedCacheItem<ExtractRoutes<TChildren>, ExtractResponses<TChildren>>;
    (options: PartialCacheOptions | false): TypedCacheItem<{}, {}>;
    <const TChildren extends readonly AllUseItems[]>(
      options: PartialCacheOptions | false,
      use: () => TChildren,
    ): TypedCacheItem<ExtractRoutes<TChildren>, ExtractResponses<TChildren>>;
  };
};

// ============================================================================
// Helper Implementations
// ============================================================================

/**
 * Check if a value is a valid use item
 */
const isValidUseItem = (item: any): item is AllUseItems | undefined | null => {
  return (
    typeof item === "undefined" ||
    item === null ||
    (item &&
      typeof item === "object" &&
      "type" in item &&
      [
        "layout",
        "route",
        "middleware",
        "revalidate",
        "parallel",
        "intercept",
        "loader",
        "loading",
        "errorBoundary",
        "notFoundBoundary",
        "when",
        "cache",
        "include",
      ].includes(item.type))
  );
};

/**
 * Apply URL prefix to a pattern
 * Handles edge cases like "/" patterns and double slashes
 */
function applyUrlPrefix(prefix: string, pattern: string): string {
  if (!prefix) return pattern;
  if (pattern === "/") return prefix;
  if (prefix.endsWith("/") && pattern.startsWith("/")) {
    return prefix + pattern.slice(1);
  }
  return prefix + pattern;
}

/**
 * Apply name prefix to a route name
 */
function applyNamePrefix(prefix: string | undefined, name: string): string {
  if (!prefix) return name;
  return `${prefix}.${name}`;
}

/**
 * Create path() helper
 *
 * The path() function is the key new feature - it combines URL pattern
 * with handler at the definition site.
 */
/**
 * Resolve response type from path options (set by path.json(), path.text(), etc.)
 */
function resolveResponseType(
  options: PathOptions | undefined,
): string | undefined {
  return options?.[RESPONSE_TYPE];
}

function createPathHelper<TEnv>(): PathFn<TEnv> {
  return ((
    pattern: string,
    handler: ReactNode | Handler<any, any, TEnv>,
    optionsOrUse?: PathOptions | (() => RouteUseItem[]),
    maybeUse?: () => RouteUseItem[],
  ): RouteItem => {
    const store = getContext();
    const ctx = store.getStore();
    if (!ctx) throw new Error("path() must be called inside urls()");

    // Determine options and use based on argument types
    let options: PathOptions | undefined;
    let use: (() => RouteUseItem[]) | undefined;

    if (typeof optionsOrUse === "function") {
      // path(pattern, handler, use)
      use = optionsOrUse as () => RouteUseItem[];
    } else if (typeof optionsOrUse === "object") {
      // path(pattern, handler, options) or path(pattern, handler, options, use)
      options = optionsOrUse as PathOptions;
      use = maybeUse;
    }

    // Get prefixes from context (set by include())
    const urlPrefix = getUrlPrefix();
    const namePrefix = getNamePrefix();

    // Apply URL prefix to pattern
    const prefixedPattern = applyUrlPrefix(urlPrefix, pattern);

    // Generate route name - use provided name or generate from pattern
    const localName =
      options?.name || `$path_${pattern.replace(/[/:*?]/g, "_")}`;
    // Apply name prefix if set (from include())
    const routeName = applyNamePrefix(namePrefix, localName);

    const namespace = `${ctx.namespace}.${store.getNextIndex("route")}.${routeName}`;

    // Per-request pruning: skip registration for routes that won't be rendered.
    // forRoute is set by loadManifest() to the matched route name. During
    // evaluateLazyEntry() (route matching), forRoute is unset so all routes
    // register normally. We still increment counters to keep shortCodes stable
    // across different routes (needed for segment reconciliation on navigation).
    //
    // include() does not need its own forRoute pruning. include() creates lazy
    // entries that defer handler execution until route matching. When the lazy
    // handler eventually runs inside loadManifest(), this path() check already
    // covers all routes defined inside the include.
    if (ctx.forRoute && routeName !== ctx.forRoute) {
      store.getShortCode("route");
      return { type: "route" } as RouteItem;
    }

    // Ensure handler is always a function (wrap ReactNode or extract from prerender def)
    const wrappedHandler: Handler<any, any, TEnv> =
      typeof handler === "function"
        ? (handler as Handler<any, any, TEnv>)
        : isPrerenderHandler(handler)
          ? (handler.handler as Handler<any, any, TEnv>)
          : () => handler;

    const entry = {
      id: namespace,
      shortCode: store.getShortCode("route"),
      type: "route" as const,
      parent: ctx.parent,
      handler: wrappedHandler,
      // Store the PREFIXED pattern for route matching
      pattern: prefixedPattern,
      loading: undefined,
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
      layout: [],
      parallel: [],
      intercept: [],
      loader: [],
      ...(urlPrefix ? { mountPath: urlPrefix } : {}),
      ...(isPrerenderHandler(handler)
        ? {
            isPrerender: true as const,
            prerenderDef: handler as PrerenderHandlerDefinition,
          }
        : {}),
      ...(resolveResponseType(options)
        ? { responseType: resolveResponseType(options) }
        : {}),
    };

    // Check for duplicate route names (TypeScript should catch this, but runtime check too)
    invariant(
      ctx.manifest.get(routeName) === undefined,
      `Duplicate route name: ${routeName} at ${namespace}`,
    );

    // Register route entry with prefixed name
    ctx.manifest.set(routeName, entry);

    // Also store pattern in a separate map for URL generation
    if (ctx.patterns) {
      ctx.patterns.set(routeName, prefixedPattern);
    }

    // Store pattern grouped by URL prefix for separate entry creation
    if (ctx.patternsByPrefix) {
      const urlPrefix = getUrlPrefix() || "";
      if (!ctx.patternsByPrefix.has(urlPrefix)) {
        ctx.patternsByPrefix.set(urlPrefix, new Map());
      }
      ctx.patternsByPrefix.get(urlPrefix)!.set(routeName, prefixedPattern);
    }

    // Store trailing slash config if specified
    if (options?.trailingSlash && ctx.trailingSlash) {
      ctx.trailingSlash.set(routeName, options.trailingSlash);
    }

    // Run use callback if provided
    if (use && typeof use === "function") {
      const result = store.run(namespace, entry, use);
      invariant(
        Array.isArray(result) && result.every((item) => isValidUseItem(item)),
        `path() use() callback must return an array of use items [${namespace}]`,
      );
      return { name: namespace, type: "route", uses: result } as RouteItem;
    }

    return { name: namespace, type: "route" } as RouteItem;
  }) as PathFn<TEnv>;
}

/**
 * Attach response type tag methods (.json, .text, .html, .xml, .md, .image, .stream, .any) to a path helper.
 * Each tag wraps the original path() call with the RESPONSE_TYPE option set.
 */
function attachPathResponseTags<TEnv>(pathFn: PathFn<TEnv>): PathFn<TEnv> & {
  json: JsonResponsePathFn<TEnv>;
  text: TextResponsePathFn<TEnv>;
  html: TextResponsePathFn<TEnv>;
  xml: TextResponsePathFn<TEnv>;
  md: TextResponsePathFn<TEnv>;
  image: ResponsePathFn<TEnv>;
  stream: ResponsePathFn<TEnv>;
  any: ResponsePathFn<TEnv>;
} {
  function createTagged(responseType: string): ResponsePathFn<TEnv> {
    return ((
      pattern: string,
      handler: any,
      optionsOrUse?: any,
      maybeUse?: any,
    ) => {
      let options: PathOptions;
      let use: (() => any[]) | undefined;

      if (typeof optionsOrUse === "function") {
        options = { [RESPONSE_TYPE]: responseType };
        use = optionsOrUse;
      } else {
        options = { ...optionsOrUse, [RESPONSE_TYPE]: responseType };
        use = maybeUse;
      }

      return pathFn(pattern, handler, options, use);
    }) as ResponsePathFn<TEnv>;
  }

  const extended = pathFn as any;
  extended.json = createTagged("json");
  extended.text = createTagged("text");
  extended.html = createTagged("html");
  extended.xml = createTagged("xml");
  extended.md = createTagged("md");
  extended.image = createTagged("image");
  extended.stream = createTagged("stream");
  extended.any = createTagged("any");
  return extended;
}

/**
 * Process an IncludeItem by executing its nested patterns with prefixes
 * This expands the include into actual route registrations
 */
function processIncludeItem(item: IncludeItem): AllUseItems[] {
  const { prefix, patterns, options } = item;
  const namePrefix = options?.name;

  // Execute the nested patterns' handler with URL and name prefixes
  // The urlPrefix being set tells nested urls() to skip RootLayout wrapping
  return runWithPrefixes(prefix, namePrefix, () => {
    // Call the nested patterns' handler - this registers routes with prefixed patterns/names
    return (patterns as UrlPatterns).handler();
  });
}

/**
 * Recursively process items, expanding any IncludeItems
 * Returns items with IncludeItems expanded into actual route items
 *
 * Lazy includes are kept as-is (not expanded) for the router to handle later.
 */
function processItems(items: readonly AllUseItems[]): AllUseItems[] {
  const result: AllUseItems[] = [];

  for (const item of items) {
    if (!item) continue;

    if (item.type === "include") {
      const includeItem = item as IncludeItem & {
        _expanded?: AllUseItems[];
        lazy?: boolean;
      };

      // Lazy includes are NOT expanded here - kept for router to handle
      if (includeItem.lazy) {
        result.push(item);
        continue;
      }

      // Eager includes are already expanded during include() call
      if (includeItem._expanded) {
        // Items were expanded immediately - just process them recursively
        result.push(...processItems(includeItem._expanded));
      } else {
        // Fallback for legacy include items without _expanded
        const expanded = processIncludeItem(item as IncludeItem);
        result.push(...processItems(expanded));
      }
    } else if (item.type === "layout" && (item as any).uses) {
      // Process nested items in layout
      const layoutItem = item as any;
      layoutItem.uses = processItems(layoutItem.uses);
      result.push(layoutItem);
    } else {
      result.push(item);
    }
  }

  return result;
}

/**
 * Create include() helper for composing URL patterns
 *
 * By default, include() IMMEDIATELY expands the nested patterns. This ensures
 * that routes from included patterns inherit the correct parent context
 * (the layout they're included in).
 *
 * With `lazy: true`, patterns are NOT expanded at definition time. Instead,
 * they're evaluated on first request that matches the prefix. This improves
 * cold start time for apps with many routes.
 */
function createIncludeHelper<TEnv>(): IncludeFn<TEnv> {
  return (
    prefix: string,
    patterns: UrlPatterns<TEnv>,
    options?: IncludeOptions,
  ): IncludeItem => {
    const store = getContext();
    const ctx = store.getStore();
    if (!ctx) throw new Error("include() must be called inside urls()");

    const namePrefix = options?.name;
    const name = `$include_${prefix.replace(/[/:*?]/g, "_")}`;

    // Capture context for deferred evaluation
    const capturedUrlPrefix = getUrlPrefix();
    const capturedNamePrefix = getNamePrefix();
    const capturedParent = ctx.parent;
    const fullPrefix = capturedUrlPrefix ? capturedUrlPrefix + prefix : prefix;
    const fullNamePrefix = namePrefix
      ? capturedNamePrefix
        ? `${capturedNamePrefix}.${namePrefix}`
        : namePrefix
      : capturedNamePrefix;

    // Track this include for build-time manifest generation
    if (ctx.trackedIncludes) {
      ctx.trackedIncludes.push({
        prefix,
        fullPrefix,
        namePrefix: fullNamePrefix,
        patterns,
        lazy: true,
      });
    }

    // All includes are lazy - patterns are evaluated on first matching request
    // This improves cold start time significantly for large route sets
    return {
      type: "include",
      name,
      prefix,
      patterns,
      options,
      lazy: true,
      _lazyContext: {
        urlPrefix: capturedUrlPrefix,
        namePrefix: fullNamePrefix,
        parent: capturedParent,
      },
    } as IncludeItem;
  };
}

// ============================================================================
// Re-use existing helpers from route-definition.ts
// ============================================================================

// Import the helper creation functions from route-definition
import { createRouteHelpers } from "./route-definition.js";

// ============================================================================
// urls() Main Entry Point
// ============================================================================

/**
 * Define URL patterns with Django-inspired syntax
 *
 * Replaces map() as the entry point for route definitions.
 * URL patterns are now visible at the definition site via path().
 *
 * @example
 * ```typescript
 * export const blogPatterns = urls(({ path, layout, loader }) => [
 *   layout(BlogLayout, () => [
 *     path("/", BlogIndex, { name: "index" }),
 *     path("/:slug", BlogPost, { name: "post" }, () => [
 *       loader(PostLoader),
 *     ]),
 *   ]),
 * ]);
 * ```
 */
export function urls<
  TEnv = DefaultEnv,
  const TItems extends readonly AllUseItems[] = readonly AllUseItems[],
>(
  builder: (helpers: PathHelpers<TEnv>) => TItems,
): UrlPatterns<TEnv, ExtractRoutes<TItems>, ExtractResponses<TItems>> {
  // Collect path definitions during build
  const definitions: PathDefinition[] = [];

  // Create the handler function that will be called by the router
  const handler = () => {
    invariant(
      typeof builder === "function",
      "urls() expects a builder function as its argument",
    );

    // Get base helpers from the existing route-definition module
    const baseHelpers = createRouteHelpers<any, TEnv>();

    // Create the path helper (with .json, .text, .html, .xml, .image, .stream, .any tags)
    const pathHelper = attachPathResponseTags(createPathHelper<TEnv>());

    // Create the include helper
    const includeHelper = createIncludeHelper<TEnv>();

    // Combine all helpers
    // Note: layout and cache are cast to their typed versions - phantom types don't affect runtime
    const helpers: PathHelpers<TEnv> = {
      path: pathHelper as any,
      include: includeHelper as any,
      layout: baseHelpers.layout as PathHelpers<TEnv>["layout"],
      parallel: baseHelpers.parallel,
      intercept: baseHelpers.intercept as PathHelpers<TEnv>["intercept"],
      middleware: baseHelpers.middleware,
      revalidate: baseHelpers.revalidate,
      loader: baseHelpers.loader,
      loading: baseHelpers.loading,
      errorBoundary: baseHelpers.errorBoundary,
      notFoundBoundary: baseHelpers.notFoundBoundary,
      when: baseHelpers.when,
      cache: baseHelpers.cache as PathHelpers<TEnv>["cache"],
    };

    // Execute builder directly - manifest.ts handles RootLayout wrapping
    // for inline handlers (non-Promise results).
    // For nested include() calls, routes inherit the outer RootLayout.
    const builderResult = builder(helpers);
    return processItems(builderResult);
  };

  // trailingSlash config is populated when handler() runs
  // We expose it via a getter that reads from the context after handler execution
  return {
    definitions,
    handler,
    get trailingSlash() {
      // Get the trailingSlash map from the current context
      // This will be populated after handler() is called
      const store = getContext();
      const ctx = store.context.getStore();
      if (!ctx?.trailingSlash) {
        return {};
      }
      return Object.fromEntries(ctx.trailingSlash);
    },
  } as UrlPatterns<TEnv, ExtractRoutes<TItems>, ExtractResponses<TItems>>;
}


// ============================================================================
// Type Utilities for path()
// ============================================================================

/**
 * Extract route names from a UrlPatterns result
 * Used for type-safe href() generation
 */
export type ExtractRouteNames<T extends UrlPatterns<any>> =
  T extends UrlPatterns<infer _TEnv>
    ? string // For now, will be refined with full implementation
    : never;

/**
 * Extract params for a specific route name
 */
export type ExtractPathParams<
  T extends UrlPatterns<any>,
  K extends string,
> = ExtractParams<string>; // Will be refined with pattern tracking

// ============================================================================
// Response Envelope Types
// ============================================================================

/**
 * Error shape returned in the `{ error }` side of a JSON response envelope.
 */
export interface ResponseError {
  message: string;
  code?: string;
  type?: string;
  stack?: string;
}

/**
 * Discriminated union envelope for JSON response routes.
 * Consumers check `result.error` to discriminate between success and failure.
 *
 * @example
 * ```typescript
 * const result: ResponseEnvelope<Product> = await fetch(url).then(r => r.json());
 * if (result.error) {
 *   console.log(result.error.message, result.error.code);
 *   return;
 * }
 * result.data.name // fully typed
 * ```
 */
export type ResponseEnvelope<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: ResponseError };

// ============================================================================
// Response Type Consumer Utilities
// ============================================================================

/**
 * Extract the response data type for a named route from a UrlPatterns instance.
 * Wraps in ResponseEnvelope since JSON response routes return enveloped data.
 *
 * @example
 * ```typescript
 * const apiPatterns = urls(({ path }) => [
 *   path.json("/health", (ctx) => ({ status: "ok", timestamp: Date.now() }), { name: "health" }),
 * ]);
 *
 * type HealthData = RouteResponse<typeof apiPatterns, "health">;
 * // ResponseEnvelope<{ status: string; timestamp: number }>
 * ```
 */
export type RouteResponse<TPatterns, TName extends string> = TPatterns extends {
  readonly _responses?: infer R;
}
  ? TName extends keyof R
    ? ResponseEnvelope<Exclude<R[TName], Response>>
    : never
  : never;

// ============================================================================
// Exports
// ============================================================================

export type {
  AllUseItems,
  IncludeItem,
  TypedRouteItem,
  TypedIncludeItem,
  TypedLayoutItem,
  TypedCacheItem,
} from "./route-types.js";
