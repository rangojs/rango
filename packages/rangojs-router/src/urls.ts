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
  LoaderDefinition,
  MiddlewareFn,
  NotFoundBoundaryHandler,
  PartialCacheOptions,
  ShouldRevalidateFn,
  TrailingSlashMode,
} from "./types.js";
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
}

/**
 * Internal representation of a URL pattern definition
 */
export interface PathDefinition {
  pattern: string;
  name?: string;
  handler: ReactNode | Handler<any, any>;
  use?: RouteUseItem[];
}

/**
 * Result of urls() - contains the route definitions
 */
export interface UrlPatterns<
  TEnv = any,
  TRoutes extends Record<string, string> = Record<string, string>
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
 */
type PrefixRoutes<
  TRoutes extends Record<string, string>,
  TPrefix extends string
> = TPrefix extends ""
  ? TRoutes
  : {
      [K in keyof TRoutes as K extends string ? `${TPrefix}.${K}` : never]: TRoutes[K];
    };

/**
 * Prefix route patterns with a URL prefix (e.g., "/blog" + "/:slug" = "/blog/:slug")
 */
type PrefixPatterns<
  TRoutes extends Record<string, string>,
  TUrlPrefix extends string
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
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39
];

/**
 * Force TypeScript to eagerly evaluate a type.
 * This helps with interface extension by creating a "concrete" object type.
 */
type Simplify<T> = T extends Record<string, string>
  ? { [K in keyof T]: T[K] }
  : T;

/**
 * Convert a union type to an intersection type.
 * Used to combine route maps from multiple siblings without recursive tuple processing.
 */
type UnionToIntersection<U> =
  (U extends any ? (k: U) => void : never) extends ((k: infer I) => void) ? I : never;

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
    // TypedIncludeItem: extract prefixed routes (both name and URL prefix)
    : T extends TypedIncludeItem<infer TRoutes, infer TNamePrefix, infer TUrlPrefix>
      ? TNamePrefix extends string
        ? TUrlPrefix extends string
          ? PrefixRoutes<PrefixPatterns<TRoutes, TUrlPrefix>, TNamePrefix>
          : PrefixRoutes<TRoutes, TNamePrefix>
        : TUrlPrefix extends string
          ? PrefixPatterns<TRoutes, TUrlPrefix>
          : TRoutes
      // TypedLayoutItem: extract child routes from phantom type
      : T extends TypedLayoutItem<infer TChildRoutes>
        ? TChildRoutes
        // TypedCacheItem: extract child routes from phantom type
        : T extends TypedCacheItem<infer TChildRoutes>
          ? TChildRoutes
          // Fallback (won't extract routes)
          : {};

/**
 * Extract routes from an array of items using mapped types.
 * Uses UnionToIntersection to combine routes without recursive tuple processing,
 * removing the sibling limit that was caused by TypeScript recursion limits.
 * D is passed to ExtractRoutesFromItem for nested depth tracking.
 */
type ExtractRoutesFromItems<
  T extends readonly any[],
  D extends number = 40
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
export type ExtractRoutes<T extends readonly any[]> = Simplify<ExtractRoutesFromItems<T, 40>>;

// ============================================================================
// Path Helpers Type
// ============================================================================

/**
 * Helpers provided by urls()
 */
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
  path: <const TPattern extends string, const TName extends string = UnnamedRoute>(
    pattern: TPattern,
    handler: ReactNode | Handler<ExtractParams<TPattern>, TEnv>,
    optionsOrUse?: PathOptions<TName> | (() => RouteUseItem[]),
    use?: () => RouteUseItem[]
  ) => TypedRouteItem<TName, TPattern>;

  /**
   * Define a layout that wraps child routes
   */
  layout: <const TChildren extends readonly LayoutUseItem[] = readonly LayoutUseItem[]>(
    component: ReactNode | Handler<any, TEnv>,
    use?: () => TChildren
  ) => TypedLayoutItem<ExtractRoutes<TChildren>>;

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
  include: <
    TRoutes extends Record<string, string>,
    const TUrlPrefix extends string,
    const TNamePrefix extends string = never
  >(
    prefix: TUrlPrefix,
    patterns: UrlPatterns<TEnv, TRoutes>,
    options?: IncludeOptions<TNamePrefix>
  ) => TypedIncludeItem<TRoutes, TNamePrefix, TUrlPrefix>;

  /**
   * Define parallel routes that render simultaneously in named slots
   */
  parallel: <TSlots extends Record<`@${string}`, Handler<any, TEnv> | ReactNode>>(
    slots: TSlots,
    use?: () => ParallelUseItem[]
  ) => ParallelItem;

  /**
   * Define an intercepting route for soft navigation
   * Note: routeName must match a named path() in this urlpatterns
   */
  intercept: (
    slotName: `@${string}`,
    routeName: string,
    handler: ReactNode | Handler<any, TEnv>,
    use?: () => InterceptUseItem[]
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
    use?: () => LoaderUseItem[]
  ) => LoaderItem;

  /**
   * Attach a loading component to the current route/layout
   */
  loading: (component: ReactNode, options?: { ssr?: boolean }) => LoadingItem;

  /**
   * Attach an error boundary to catch errors in this segment
   */
  errorBoundary: (
    fallback: ReactNode | ErrorBoundaryHandler
  ) => ErrorBoundaryItem;

  /**
   * Attach a not-found boundary to handle notFound() calls
   */
  notFoundBoundary: (
    fallback: ReactNode | NotFoundBoundaryHandler
  ) => NotFoundBoundaryItem;

  /**
   * Define a condition for when an intercept should activate
   */
  when: (fn: InterceptWhenFn) => WhenItem;

  /**
   * Define cache configuration for segments
   */
  cache: {
    (): CacheItem;
    <const TChildren extends readonly AllUseItems[] = readonly AllUseItems[]>(
      children: () => TChildren
    ): TypedCacheItem<ExtractRoutes<TChildren>>;
    <const TChildren extends readonly AllUseItems[] = readonly AllUseItems[]>(
      options: PartialCacheOptions | false,
      use?: () => TChildren
    ): TypedCacheItem<ExtractRoutes<TChildren>>;
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
function createPathHelper<TEnv>(): PathHelpers<TEnv>["path"] {
  return ((
    pattern: string,
    handler: ReactNode | Handler<any, TEnv>,
    optionsOrUse?: PathOptions | (() => RouteUseItem[]),
    maybeUse?: () => RouteUseItem[]
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
    const localName = options?.name || `$path_${pattern.replace(/[/:*?]/g, "_")}`;
    // Apply name prefix if set (from include())
    const routeName = applyNamePrefix(namePrefix, localName);

    const namespace = `${ctx.namespace}.${store.getNextIndex("route")}.${routeName}`;

    // Ensure handler is always a function (wrap ReactNode if needed)
    const wrappedHandler: Handler<any, TEnv> =
      typeof handler === "function"
        ? (handler as Handler<any, TEnv>)
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
    };

    // Check for duplicate route names (TypeScript should catch this, but runtime check too)
    invariant(
      ctx.manifest.get(routeName) === undefined,
      `Duplicate route name: ${routeName} at ${namespace}`
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
        `path() use() callback must return an array of use items [${namespace}]`
      );
      return { name: namespace, type: "route", uses: result } as RouteItem;
    }

    return { name: namespace, type: "route" } as RouteItem;
  }) as PathHelpers<TEnv>["path"];
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
 */
function processItems(items: readonly AllUseItems[]): AllUseItems[] {
  const result: AllUseItems[] = [];

  for (const item of items) {
    if (!item) continue;

    if (item.type === "include") {
      // Include items are already expanded during include() call
      // Just extract the expanded items
      const includeItem = item as IncludeItem & { _expanded?: AllUseItems[] };
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
 * Unlike other helpers that return items for later processing,
 * include() IMMEDIATELY expands the nested patterns. This ensures
 * that routes from included patterns inherit the correct parent context
 * (the layout they're included in).
 */
function createIncludeHelper<TEnv>(): PathHelpers<TEnv>["include"] {
  return (
    prefix: string,
    patterns: UrlPatterns<TEnv>,
    options?: IncludeOptions
  ): IncludeItem => {
    const store = getContext();
    const ctx = store.getStore();
    if (!ctx) throw new Error("include() must be called inside urls()");

    const namePrefix = options?.name;

    // IMMEDIATELY expand the nested patterns with the current context
    // This ensures routes inherit the correct parent (e.g., UserRootLayout)
    const expandedItems = runWithPrefixes(prefix, namePrefix, () => {
      return (patterns as UrlPatterns).handler();
    });

    // Return a marker item that contains the expanded items
    // processItems will extract these expanded items
    const name = `$include_${prefix.replace(/[/:*?]/g, "_")}`;
    return {
      type: "include",
      name,
      prefix,
      patterns,
      options,
      // Store expanded items for processItems to extract
      _expanded: expandedItems,
    } as IncludeItem & { _expanded: AllUseItems[] };
  };
}

// ============================================================================
// Re-use existing helpers from route-definition.ts
// ============================================================================

// Import the helper creation functions from route-definition
import {
  createRouteHelpers,
} from "./route-definition.js";

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
  const TItems extends readonly AllUseItems[] = readonly AllUseItems[]
>(
  builder: (helpers: PathHelpers<TEnv>) => TItems
): UrlPatterns<TEnv, ExtractRoutes<TItems>> {
  // Collect path definitions during build
  const definitions: PathDefinition[] = [];

  // Create the handler function that will be called by the router
  const handler = () => {
    invariant(
      typeof builder === "function",
      "urls() expects a builder function as its argument"
    );

    // Get base helpers from the existing route-definition module
    const baseHelpers = createRouteHelpers<any, TEnv>();

    // Create the path helper
    const pathHelper = createPathHelper<TEnv>();

    // Create the include helper
    const includeHelper = createIncludeHelper<TEnv>();

    // Combine all helpers
    // Note: layout and cache are cast to their typed versions - phantom types don't affect runtime
    const helpers: PathHelpers<TEnv> = {
      path: pathHelper,
      include: includeHelper,
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
  } as UrlPatterns<TEnv, ExtractRoutes<TItems>>;
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
  K extends string
> = ExtractParams<string>; // Will be refined with pattern tracking

// ============================================================================
// Exports
// ============================================================================

export type { AllUseItems, IncludeItem, TypedRouteItem, TypedIncludeItem, TypedLayoutItem, TypedCacheItem } from "./route-types.js";
