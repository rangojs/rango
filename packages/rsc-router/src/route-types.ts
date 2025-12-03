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

export type LayoutItem = {
  name: string;
  type: "layout";
  uses?: AllUseItems[];
  [LayoutBrand]: void;
};
export type RouteItem = {
  name: string;
  type: "route";
  uses?: AllUseItems[];
  [RouteBrand]: void;
};
export type ParallelItem = {
  name: string;
  type: "parallel";
  uses?: AllUseItems[];
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
  uses?: AllUseItems[];
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
  | NotFoundBoundaryItem;
export type LayoutUseItem =
  | LayoutItem
  | RouteItem
  | MiddlewareItem
  | RevalidateItem
  | ParallelItem
  | InterceptItem
  | LoaderItem
  | LoadingItem
  | ErrorBoundaryItem
  | NotFoundBoundaryItem;
export type RouteUseItem =
  | LayoutItem
  | ParallelItem
  | InterceptItem
  | MiddlewareItem
  | RevalidateItem
  | LoaderItem
  | LoadingItem
  | ErrorBoundaryItem
  | NotFoundBoundaryItem;
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
  | RouteItem;
export type LoaderUseItem = RevalidateItem;
