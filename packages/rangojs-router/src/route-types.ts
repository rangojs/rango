/**
 * Type definitions for route system items
 * These are extracted separately to avoid circular dependencies
 * and to prevent bundling server-only code in client bundles
 */

/**
 * Brand for UrlPatterns nominal typing (see pattern-types.ts). The route-item
 * types below are discriminated by their `type` literal, so they carry no brand.
 */
export declare const UrlPatternsBrand: unique symbol;

export type LayoutItem = {
  name: string;
  type: "layout";
  uses?: AllUseItems[];
};

/**
 * Phantom inference fields attached to wrapper items (layout/cache/transition)
 * so the urls() type extractor can read their child routes/responses. The fields
 * never exist at runtime.
 */
type WithChildren<
  TBase,
  TChildRoutes extends Record<string, any> = Record<string, string>,
  TChildResponses extends Record<string, unknown> = Record<string, unknown>,
> = TBase & {
  readonly __childRoutes?: TChildRoutes;
  readonly __childResponses?: TChildResponses;
};

/**
 * Typed layout item that carries child routes as phantom type
 * Used for type inference in urls() API
 */
export type TypedLayoutItem<
  TChildRoutes extends Record<string, any> = Record<string, string>,
  TChildResponses extends Record<string, unknown> = Record<string, unknown>,
> = WithChildren<LayoutItem, TChildRoutes, TChildResponses>;
export type RouteItem = {
  name: string;
  type: "route";
  uses?: AllUseItems[];
};

/**
 * Typed route item that carries route name and pattern as phantom types
 * Used for type inference in urls() API
 */
export type TypedRouteItem<
  TName extends string = string,
  TPattern extends string = string,
  TData = unknown,
  TSearch = {},
> = RouteItem & {
  readonly __name?: TName;
  readonly __pattern?: TPattern;
  readonly __data?: TData;
  readonly __search?: TSearch;
};
export type ParallelItem = {
  name: string;
  type: "parallel";
  uses?: ParallelUseItem[];
};
export type InterceptItem = {
  name: string;
  type: "intercept";
  uses?: InterceptUseItem[];
};
export type LoaderItem = {
  name: string;
  type: "loader";
  uses?: LoaderUseItem[];
};
export type MiddlewareItem = {
  name: string;
  type: "middleware";
  uses?: AllUseItems[];
};
export type RevalidateItem = {
  name: string;
  type: "revalidate";
  uses?: AllUseItems[];
};
export type LoadingItem = {
  name: string;
  type: "loading";
};
export type ErrorBoundaryItem = {
  name: string;
  type: "errorBoundary";
  uses?: AllUseItems[];
};
export type NotFoundBoundaryItem = {
  name: string;
  type: "notFoundBoundary";
  uses?: AllUseItems[];
};
export type CacheItem = {
  name: string;
  type: "cache";
  uses?: AllUseItems[];
};
export type TransitionItem = {
  name: string;
  type: "transition";
};

/**
 * Typed transition item that carries child routes as phantom type
 * Used for type inference when transition() wraps child routes
 */
export type TypedTransitionItem<
  TChildRoutes extends Record<string, any> = Record<string, string>,
  TChildResponses extends Record<string, unknown> = Record<string, unknown>,
> = WithChildren<TransitionItem, TChildRoutes, TChildResponses>;

/**
 * Typed cache item that carries child routes as phantom type
 * Used for type inference in urls() API
 */
export type TypedCacheItem<
  TChildRoutes extends Record<string, any> = Record<string, string>,
  TChildResponses extends Record<string, unknown> = Record<string, unknown>,
> = WithChildren<CacheItem, TChildRoutes, TChildResponses>;

/**
 * Include item for URL pattern composition (used by urls() API)
 */
export type IncludeItem = {
  type: "include";
  name: string;
  prefix: string;
  patterns: unknown; // UrlPatterns - avoid circular ref
  options?: { name?: string; lazy?: boolean };
  /** Whether this include should be lazily evaluated on first request */
  lazy?: boolean;
  /** Captured context for deferred lazy evaluation */
  _lazyContext?: {
    urlPrefix: string;
    namePrefix: string | undefined;
    parent: unknown; // EntryData - avoid circular import
    /** Counter snapshot from pattern extraction for consistent shortCode indices */
    counters?: Record<string, number>;
    /** Cache profiles for DSL-time cache("profileName") resolution */
    cacheProfiles?: Record<
      string,
      import("./cache/profile-registry.js").CacheProfile
    >;
    /** Root scope flag for dot-local reverse resolution */
    rootScoped?: boolean;
    /**
     * Positional include scope token composed from the parent scope plus this
     * include's sibling index (`${parentScope}I${idx}`). Applied to direct-
     * descendant shortCodes during lazy evaluation so routes inside the
     * include cannot collide with siblings declared outside it.
     */
    includeScope?: string;
  };
};

/**
 * Typed include item that carries nested routes as phantom type
 * Used for type inference in urls() API
 */
export type TypedIncludeItem<
  TRoutes extends Record<string, any> = Record<string, string>,
  TNamePrefix extends string = string,
  TUrlPrefix extends string = string,
  TResponses extends Record<string, unknown> = Record<string, unknown>,
> = IncludeItem & {
  readonly __routes?: TRoutes;
  readonly __namePrefix?: TNamePrefix;
  readonly __urlPrefix?: TUrlPrefix;
  readonly __responses?: TResponses;
};

/**
 * Union types for use() callbacks
 */
export type AllUseItems =
  | LayoutItem
  | RouteItem
  | MiddlewareItem
  | RevalidateItem
  | ParallelItem
  | InterceptItem
  | LoaderItem
  | LoadingItem
  | ErrorBoundaryItem
  | NotFoundBoundaryItem
  | CacheItem
  | TransitionItem
  | IncludeItem;

/** Items that can be used inside a layout callback */
export type LayoutUseItem = AllUseItems;
export type RouteUseItem =
  | LayoutItem
  | ParallelItem
  | InterceptItem
  | MiddlewareItem
  | RevalidateItem
  | LoaderItem
  | LoadingItem
  | ErrorBoundaryItem
  | NotFoundBoundaryItem
  | CacheItem
  | TransitionItem;
/** Items that can be used inside a response route (path.json(), etc.) */
export type ResponseRouteUseItem = MiddlewareItem | CacheItem;
export type ParallelUseItem =
  | RevalidateItem
  | LoaderItem
  | LoadingItem
  | ErrorBoundaryItem
  | NotFoundBoundaryItem
  | TransitionItem;
export type InterceptUseItem =
  | MiddlewareItem
  | RevalidateItem
  | LoaderItem
  | LoadingItem
  | ErrorBoundaryItem
  | NotFoundBoundaryItem
  | LayoutItem
  | RouteItem
  | TransitionItem;
export type LoaderUseItem = RevalidateItem | CacheItem;

/**
 * Allow composition factories in use() callbacks.
 * Factories return T[], which placed inside a use() callback array
 * creates nested arrays like (T | T[])[]. These are flattened at
 * runtime via .flat(3).
 */
export type UseItems<T> = (T | readonly T[])[];

/**
 * Union of all items that handler.use() may return.
 * A handler doesn't know its mount site at definition time, so the type
 * is intentionally broad — validation happens per-mount-site at runtime.
 */
export type HandlerUseItem =
  | RouteUseItem
  | LayoutUseItem
  | ParallelUseItem
  | InterceptUseItem;
