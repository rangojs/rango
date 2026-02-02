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
} from "./types.js";
import type {
  AllUseItems,
  LayoutItem,
  RouteItem,
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
  IncludeItem,
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
import RootLayout from "./server/root-layout";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for path() function
 */
export interface PathOptions {
  /** Route name for href() lookups */
  name?: string;
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
export interface UrlPatterns<TEnv = any> {
  /** Internal: route definitions */
  readonly definitions: PathDefinition[];
  /** Internal: compiled handler function */
  readonly handler: () => AllUseItems[];
  /** Brand for type checking */
  readonly [UrlPatternsBrand]: void;
  /** Environment type brand (phantom) */
  readonly _env?: TEnv;
}

/**
 * Options for include()
 */
export interface IncludeOptions {
  /** Name prefix for all routes in this pattern set */
  name?: string;
}

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
  path: <TPattern extends string>(
    pattern: TPattern,
    handler: ReactNode | Handler<ExtractParams<TPattern>, TEnv>,
    optionsOrUse?: PathOptions | (() => RouteUseItem[]),
    use?: () => RouteUseItem[]
  ) => RouteItem;

  /**
   * Define a layout that wraps child routes
   */
  layout: (
    component: ReactNode | Handler<any, TEnv>,
    use?: () => LayoutUseItem[]
  ) => LayoutItem;

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
  include: (
    prefix: string,
    patterns: UrlPatterns<TEnv>,
    options?: IncludeOptions
  ) => IncludeItem;

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
    (children: () => AllUseItems[]): CacheItem;
    (options: PartialCacheOptions | false, use?: () => AllUseItems[]): CacheItem;
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
  return runWithPrefixes(prefix, namePrefix, () => {
    // Call the nested patterns' handler - this registers routes with prefixed patterns/names
    return (patterns as UrlPatterns).handler();
  });
}

/**
 * Recursively process items, expanding any IncludeItems
 * Returns items with IncludeItems expanded into actual route items
 */
function processItems(items: AllUseItems[]): AllUseItems[] {
  const result: AllUseItems[] = [];

  for (const item of items) {
    if (!item) continue;

    if (item.type === "include") {
      // Expand include into actual route items
      const expanded = processIncludeItem(item as IncludeItem);
      result.push(...processItems(expanded));
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

    const name = `$include_${prefix.replace(/[/:*?]/g, "_")}`;

    // Return include item - will be processed during handler execution
    return {
      type: "include",
      name,
      prefix,
      patterns,
      options,
    } as IncludeItem;
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
export function urls<TEnv = DefaultEnv>(
  builder: (helpers: PathHelpers<TEnv>) => AllUseItems[]
): UrlPatterns<TEnv> {
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
    const helpers: PathHelpers<TEnv> = {
      path: pathHelper,
      include: includeHelper,
      layout: baseHelpers.layout,
      parallel: baseHelpers.parallel,
      intercept: baseHelpers.intercept as PathHelpers<TEnv>["intercept"],
      middleware: baseHelpers.middleware,
      revalidate: baseHelpers.revalidate,
      loader: baseHelpers.loader,
      loading: baseHelpers.loading,
      errorBoundary: baseHelpers.errorBoundary,
      notFoundBoundary: baseHelpers.notFoundBoundary,
      when: baseHelpers.when,
      cache: baseHelpers.cache,
    };

    // Build the route items
    const builderResult = builder(helpers);

    // Process any include() items to expand them
    const processedResult = processItems(builderResult);

    // Wrap with RootLayout like map() does
    const layout = baseHelpers.layout;
    return [layout(RootLayout, () => processedResult)].flat(3);
  };

  return {
    definitions,
    handler,
  } as UrlPatterns<TEnv>;
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

export type { AllUseItems } from "./route-types.js";
