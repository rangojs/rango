import type { ReactNode } from 'react';

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

/**
 * Handlers object that maps route names to handler functions
 */
export type HandlersForRouteMap<
  T extends RouteDefinition,
  TContext = any
> = {
  [K in keyof T]?: T[K] extends string
    ? Handler<ExtractParams<T[K]>, TContext>
    : never;
} & {
  [route.layout]?: ReactNode | ReactNode[];
  [route.revalidate]?: {
    [K in keyof T]?: T[K] extends string
      ? RevalidateFn<ExtractParams<T[K]>, TContext>
      : never;
  };
};

/**
 * Resolved segment with component
 */
export interface ResolvedSegment {
  id: string;
  type: 'layout' | 'route';
  index: number;
  component: ReactNode;
  params?: Record<string, string>;
}

/**
 * Segment metadata (without component)
 */
export interface SegmentMetadata {
  id: string;
  type: 'layout' | 'route';
  index: number;
  params?: Record<string, string>;
}

/**
 * Route symbols for special properties
 */
export const route = {
  layout: Symbol('route.layout') as symbol,
  revalidate: Symbol('route.revalidate') as symbol,
} as const;

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
