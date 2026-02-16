/**
 * Type definitions for route system items
 * These are extracted separately to avoid circular dependencies
 * and to prevent bundling server-only code in client bundles
 */

/**
 * Branded return types for route helpers
 */
export declare const LayoutBrand: unique symbol;
export declare const RouteBrand: unique symbol;
export declare const ParallelBrand: unique symbol;
export declare const InterceptBrand: unique symbol;
export declare const MiddlewareBrand: unique symbol;
export declare const RevalidateBrand: unique symbol;
export declare const LoaderBrand: unique symbol;
export declare const LoadingBrand: unique symbol;
export declare const ErrorBoundaryBrand: unique symbol;
export declare const NotFoundBoundaryBrand: unique symbol;
export declare const WhenBrand: unique symbol;
export declare const CacheBrand: unique symbol;
export declare const IncludeBrand: unique symbol;
export declare const UrlPatternsBrand: unique symbol;

export type LayoutItem = {
  name: string;
  type: "layout";
  uses?: AllUseItems[];
  [LayoutBrand]: void;
};

/**
 * Typed layout item that carries child routes as phantom type
 * Used for type inference in urls() API
 */
export type TypedLayoutItem<
  TChildRoutes extends Record<string, any> = Record<string, string>,
  TChildResponses extends Record<string, unknown> = Record<string, unknown>,
> = LayoutItem & {
  readonly __childRoutes?: TChildRoutes;
  readonly __childResponses?: TChildResponses;
};
export type RouteItem = {
  name: string;
  type: "route";
  uses?: AllUseItems[];
  [RouteBrand]: void;
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
  [ParallelBrand]: void;
};
export type InterceptItem = {
  name: string;
  type: "intercept";
  uses?: InterceptUseItem[];
  [InterceptBrand]: void;
};
export type LoaderItem = {
  name: string;
  type: "loader";
  uses?: LoaderUseItem[];
  [LoaderBrand]: void;
};
export type MiddlewareItem = {
  name: string;
  type: "middleware";
  uses?: AllUseItems[];
  [MiddlewareBrand]: void;
};
export type RevalidateItem = {
  name: string;
  type: "revalidate";
  uses?: AllUseItems[];
  [RevalidateBrand]: void;
};
export type LoadingItem = {
  name: string;
  type: "loading";
  [LoadingBrand]: void;
};
export type ErrorBoundaryItem = {
  name: string;
  type: "errorBoundary";
  uses?: AllUseItems[];
  [ErrorBoundaryBrand]: void;
};
export type NotFoundBoundaryItem = {
  name: string;
  type: "notFoundBoundary";
  uses?: AllUseItems[];
  [NotFoundBoundaryBrand]: void;
};
export type WhenItem = {
  name: string;
  type: "when";
  [WhenBrand]: void;
};
export type CacheItem = {
  name: string;
  type: "cache";
  uses?: AllUseItems[];
  [CacheBrand]: void;
};

/**
 * Typed cache item that carries child routes as phantom type
 * Used for type inference in urls() API
 */
export type TypedCacheItem<
  TChildRoutes extends Record<string, any> = Record<string, string>,
  TChildResponses extends Record<string, unknown> = Record<string, unknown>,
> = CacheItem & {
  readonly __childRoutes?: TChildRoutes;
  readonly __childResponses?: TChildResponses;
};

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
  };
  [IncludeBrand]: void;
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
  | CacheItem;
/** Items that can be used inside a response route (path.json(), etc.) */
export type ResponseRouteUseItem =
  | MiddlewareItem
  | CacheItem;
export type ParallelUseItem =
  | RevalidateItem
  | LoaderItem
  | LoadingItem
  | ErrorBoundaryItem
  | NotFoundBoundaryItem;
export type InterceptUseItem =
  | MiddlewareItem
  | RevalidateItem
  | LoaderItem
  | LoadingItem
  | ErrorBoundaryItem
  | NotFoundBoundaryItem
  | LayoutItem
  | RouteItem
  | WhenItem;
export type LoaderUseItem = RevalidateItem | CacheItem;
