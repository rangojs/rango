import type { ReactNode } from "react";
import type { Route } from "./declarative";

/**
 * Context object passed to route handlers
 */
export interface RouteContext<TParams = Record<string, string>> {
  params: TParams;
  searchParams: URLSearchParams;
  pathname: string;
  url: URL;
  request: Request;
  meta: Record<string, any>;
}

/**
 * Revalidation context for fine-grained control
 */
export interface RevalidationContext<TParams = Record<string, string>> {
  currentPath: string;
  nextPath: string;
  currentRouteName?: string;
  nextRouteName?: string;
  params: TParams;
  actionData?: any;
  request: Request;
  actionParams?: Record<string, any>;
}

/**
 * Route handler that returns a React component
 */
export type RouteHandler<TParams = Record<string, string>> = (
  context: RouteContext<TParams>
) => ReactNode | Promise<ReactNode>;

/**
 * Layout handler that wraps child routes
 */
export type LayoutHandler<TParams = Record<string, string>> = (
  context: RouteContext<TParams>
) => ReactNode | Promise<ReactNode>;

/**
 * Middleware handler that can intercept requests
 */
export type MiddlewareHandler<TParams = Record<string, string>> = (
  context: RouteContext<TParams>,
  next: () => Promise<void>
) => void | Promise<void>;

/**
 * Revalidation function to determine if a route should revalidate
 */
export type RevalidationHandler<TParams = Record<string, string>> = (
  context: RevalidationContext<TParams>
) => boolean | Promise<boolean>;

/**
 * Loading component handler
 */
export type LoadingHandler = () => ReactNode | Promise<ReactNode>;

/**
 * Error boundary handler
 */
export type ErrorHandler = (
  error: Error,
  reset: () => void
) => ReactNode | Promise<ReactNode>;

/**
 * HTTP methods supported by the router
 */
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  | "ALL";

/**
 * Extract route parameters from a path pattern
 * Converts "/posts/:id" to { id: string }
 */
export type ExtractRouteParams<T extends string> =
  T extends `${infer Start}:${infer Param}/${infer Rest}`
    ? { [K in Param]: string } & ExtractRouteParams<Rest>
    : T extends `${infer Start}:${infer Param}`
    ? { [K in Param]: string }
    : {};

/**
 * Route definition with type-safe params
 */
export interface TypedRoute<
  TPattern extends string = string,
  TMethod extends HttpMethod = "ALL"
> {
  pattern: TPattern;
  method: TMethod;
  params: ExtractRouteParams<TPattern>;
}

/**
 * Route map structure for declarative API
 */
export type RouteMap<T extends RouteMap = {}> = {
  [key: string]: string | RouteDefinition | RouteMap | Route<T>;
};

/**
 * Individual route definition
 */
export interface RouteDefinition {
  pattern: string;
  method?: HttpMethod;
  id: string;
}

/**
 * Symbol keys for route metadata
 */
export const RouteSymbols = {
  middleware: Symbol.for("route.middleware"),
  layout: Symbol.for("route.layout"),
  revalidate: Symbol.for("route.revalidate"),
  loading: Symbol.for("route.loading"),
  error: Symbol.for("route.error"),
} as const;

/**
 * Handler map structure that mirrors route map
 */
export type HandlerMap<TRoutes extends RouteMap> = {
  [K in keyof TRoutes]?: TRoutes[K] extends RouteMap
    ? HandlerMap<TRoutes[K]>
    : TRoutes[K] extends RouteDefinition
    ? RouteHandler<ExtractRouteParams<TRoutes[K]["pattern"]>>
    : TRoutes[K] extends string
    ? RouteHandler<ExtractRouteParams<TRoutes[K]>>
    : never;
} & {
  [RouteSymbols.middleware]?: MiddlewareHandler[];
  [RouteSymbols.layout]?:
    | LayoutHandler
    | (() => Promise<{ default: LayoutHandler }>);
  [RouteSymbols.revalidate]?:
    | Record<string, RevalidationHandler>
    | RevalidationHandler;
  [RouteSymbols.loading]?: Record<string, LoadingHandler> | LoadingHandler;
  [RouteSymbols.error]?: ErrorHandler;
};
