import type { ReactNode } from "react";

/**
 * Extract param names from a route pattern
 * Example: "/blog/:slug/:id" => { slug: string, id: string }
 */
export type ExtractParams<T extends string> =
  T extends `${infer _Start}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof ExtractParams<`/${Rest}`>]: string }
    : T extends `${infer _Start}:${infer Param}`
      ? { [K in Param]: string }
      : {};

/**
 * Route definition - maps route names to patterns
 */
export type RouteDefinition = {
  [key: string]: string | RouteDefinition;
};

/**
 * Resolved route map - flattened route definitions with full paths
 */
export type ResolvedRouteMap<T extends RouteDefinition> = {
  [K in keyof T]: T[K] extends string ? T[K] : never;
};

/**
 * Handler function that receives context and returns React content
 */
export type Handler<TParams = {}, TContext = any> = (
  ctx: HandlerContext<TParams, TContext>
) => ReactNode | Promise<ReactNode>;

/**
 * Context passed to handlers
 */
export type HandlerContext<TParams = {}, TContext = any> = {
  params: TParams;
  request: Request;
  searchParams: URLSearchParams;
  pathname: string;
  url: URL;
} & TContext;

/**
 * Should revalidate function signature (inspired by React Router)
 *
 * Determines whether a route segment should re-render during partial navigation.
 * Multiple revalidation functions can be defined per route - they execute in order
 * and short-circuit on first `true` (OR logic).
 *
 * @param args.currentParams - Previous route params
 * @param args.currentUrl - Previous URL
 * @param args.nextParams - Next route params
 * @param args.nextUrl - Next URL
 * @param args.defaultShouldRevalidate - True if params changed (built-in behavior)
 * @param args.context - App context (db, user, etc.)
 * @param args.actionResult - Result from action (future support)
 * @param args.formData - Form data from action (future support)
 * @param args.formMethod - HTTP method from action (future support)
 *
 * @returns true to re-render segment, false to skip
 *
 * @example
 * ```typescript
 * // Only revalidate if slug actually changed
 * [revalidate('post')]: ({ currentParams, nextParams, defaultShouldRevalidate }) => {
 *   return defaultShouldRevalidate; // Defer to default param check
 * }
 *
 * // Always revalidate (force refresh)
 * [revalidate('dashboard', 'refresh')]: () => true;
 *
 * // Never revalidate (static content)
 * [revalidate('about', 'static')]: () => false;
 * ```
 */
export type ShouldRevalidateFn<TParams = {}, TContext = any> = (args: {
  currentParams: TParams;
  currentUrl: URL;
  nextParams: TParams;
  nextUrl: URL;
  defaultShouldRevalidate: boolean;
  context: TContext;
  // Future action support:
  actionResult?: any;
  formData?: FormData;
  formMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}) => boolean;

/**
 * Middleware function signature
 */
export type MiddlewareFn<TParams = any, TContext = any> = (
  ctx: HandlerContext<TParams, TContext>,
  next: () => void | Promise<void>
) => void | Promise<void>;

/**
 * Extract all route keys from a route definition (flattened)
 */
export type RouteKeys<T extends RouteDefinition> = {
  [K in keyof T]: T[K] extends string ? K : never;
}[keyof T] & string;

/**
 * Valid layout value - component or handler function
 * Note: Arrays are not supported. Use separate layout() declarations with unique names instead.
 */
type LayoutValue<TContext = any> =
  | ReactNode
  | Handler<any, TContext>;

/**
 * Handlers object that maps route names to handler functions with type-safe string patterns
 */
export type HandlersForRouteMap<T extends RouteDefinition, TContext = any> = {
  // Route handlers
  [K in RouteKeys<T>]?: T[K] extends string
    ? Handler<ExtractParams<T[K]>, TContext>
    : never;
} & {
  // Layout patterns: $layout.{routeName}.{layoutName}
  // Supports '*' wildcard for global layouts that apply to all routes
  [K in `$layout.${RouteKeys<T> | '*'}.${string}`]?: LayoutValue<TContext>;
} & {
  // Parallel route patterns: $parallel.{routeName}.{parallelName}
  // Supports '*' wildcard for global parallel routes that apply to all routes
  [K in `$parallel.${RouteKeys<T> | '*'}.${string}`]?: Record<
    `@${string}`,
    Handler<any, TContext>
  >;
} & {
  // Middleware patterns: $middleware.{routeName}.{middlewareName}
  // Supports '*' wildcard for global middleware that applies to all routes
  [K in `$middleware.${RouteKeys<T> | '*'}.${string}`]?: MiddlewareFn<any, TContext>[];
} & {
  // Revalidate patterns: $revalidate.{routeName}.{revalidateName}
  // Supports '*' wildcard for global revalidations that apply to all routes
  // Multiple revalidations execute in order with short-circuit on first `true` (OR logic)
  [K in `$revalidate.${RouteKeys<T> | '*'}.${string}`]?: ShouldRevalidateFn<any, TContext>;
};

/**
 * Resolved segment with component
 */
export interface ResolvedSegment {
  id: string;
  type: "layout" | "route" | "parallel";
  index: number;
  component: ReactNode;
  params?: Record<string, string>;
  slot?: string; // For parallel routes: '@sidebar', '@modal', etc.
}

/**
 * Segment metadata (without component)
 */
export interface SegmentMetadata {
  id: string;
  type: "layout" | "route" | "parallel";
  index: number;
  params?: Record<string, string>;
  slot?: string;
}

// Note: route symbols are now defined in route-definition.ts
// as properties on the route() function

/**
 * Router match result
 */
export interface MatchResult {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
}

/**
 * Internal route entry stored in router
 */
export interface RouteEntry<TContext = any> {
  prefix: string;
  routes: ResolvedRouteMap<any>;
  handlers: any;
  registrationId: number;
}
