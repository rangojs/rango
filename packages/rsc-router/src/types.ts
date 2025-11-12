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
 * Revalidation function signature
 */
export type RevalidateFn<TParams = {}, TContext = any> = (ctx: {
  prevParams: TParams;
  nextParams: TParams;
  prevUrl: string;
  nextUrl: string;
  context: TContext;
}) => boolean;

// Import static symbols for type constraints
import type {
  LayoutSymbol,
  ParallelSymbol,
  MiddlewareSymbol,
  RevalidateSymbol,
  AllLayoutSymbol,
  AllParallelSymbol,
  AllMiddlewareSymbol,
  AllRevalidateSymbol,
} from "./route-definition.js";

/**
 * Valid layout value - component or handler function
 */
type LayoutValue<TContext = any> =
  | ReactNode
  | Handler<any, TContext>
  | Array<
      | Exclude<ReactNode, string | number | boolean | null | undefined>
      | Handler<any, TContext>
    >;

/**
 * Handlers object that maps route names to handler functions with type-safe symbol properties
 */
export type HandlersForRouteMap<T extends RouteDefinition, TContext = any> = {
  [K in keyof T]?: T[K] extends string
    ? Handler<ExtractParams<T[K]>, TContext>
    : never;
} & Partial<{
  // Per-route symbols with type constraints
  [K in LayoutSymbol]: LayoutValue<TContext>;
  [K in ParallelSymbol]: Record<`@${string}`, Handler<any, TContext>>;
  [K in MiddlewareSymbol]: Array<
    (ctx: HandlerContext<any, TContext>, next: () => Promise<void>) => void | Promise<void>
  >;
  [K in RevalidateSymbol]: RevalidateFn<any, TContext>;

  // Global symbols with type constraints
  [K in AllLayoutSymbol]: LayoutValue<TContext>;
  [K in AllParallelSymbol]: Record<`@${string}`, Handler<any, TContext>>;
  [K in AllMiddlewareSymbol]: Array<
    (ctx: HandlerContext<any, TContext>, next: () => Promise<void>) => void | Promise<void>
  >;
  [K in AllRevalidateSymbol]: RevalidateFn<any, TContext>;
}>;

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
