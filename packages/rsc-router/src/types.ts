import type { ReactNode } from "react";

/**
 * Global namespace for module augmentation
 *
 * Users can augment this to provide type-safe context globally:
 *
 * @example
 * ```typescript
 * // In router.tsx or env.d.ts
 * declare global {
 *   namespace RSCRouter {
 *     interface Env extends RouterEnv<AppBindings, AppVariables> {}
 *   }
 * }
 *
 * // Now all handlers have type-safe context without imports!
 * export default map<typeof shopRoutes>({
 *   [middleware('*', 'auth')]: [
 *     (ctx, next) => {
 *       ctx.set('user', ...) // Type-safe!
 *     }
 *   ]
 * })
 * ```
 */
declare global {
  namespace RSCRouter {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface Env {
      // Empty by default - users augment with their RouterEnv
    }
  }
}

/**
 * Default environment type - uses global augmentation if available, any otherwise
 */
export type DefaultEnv = keyof RSCRouter.Env extends never ? any : RSCRouter.Env;

/**
 * Router environment (Hono-inspired type-safe context)
 *
 * @template TBindings - Platform bindings (DB, KV, secrets, etc.)
 * @template TVariables - Middleware-injected variables (user, permissions, etc.)
 *
 * @example
 * ```typescript
 * interface AppBindings {
 *   DB: D1Database;
 *   KV: KVNamespace;
 *   STRIPE_KEY: string;
 * }
 *
 * interface AppVariables {
 *   user?: { id: string; name: string };
 *   permissions?: string[];
 * }
 *
 * type AppEnv = RouterEnv<AppBindings, AppVariables>;
 * const router = createRSCRouter<AppEnv>();
 * ```
 */
export interface RouterEnv<TBindings = {}, TVariables = {}> {
  Bindings: TBindings;
  Variables: TVariables;
}

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
 * Recursively flatten nested routes with depth limit to prevent infinite recursion
 * Transforms: { products: { detail: "/product/:slug" } } => { "products.detail": "/product/:slug" }
 */
type FlattenRoutes<
  T extends RouteDefinition,
  Prefix extends string = "",
  Depth extends readonly unknown[] = []
> = Depth['length'] extends 5
  ? never
  : {
      [K in keyof T]: T[K] extends string
        ? Record<`${Prefix}${K & string}`, T[K]>
        : T[K] extends RouteDefinition
          ? FlattenRoutes<T[K], `${Prefix}${K & string}.`, readonly [...Depth, unknown]>
          : never;
    }[keyof T];

/**
 * Union to intersection helper
 */
type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

/**
 * Resolved route map - flattened route definitions with full paths
 */
export type ResolvedRouteMap<T extends RouteDefinition> = UnionToIntersection<FlattenRoutes<T>>;

/**
 * Handler function that receives context and returns React content
 */
export type Handler<TParams = {}, TEnv = any> = (
  ctx: HandlerContext<TParams, TEnv>
) => ReactNode | Promise<ReactNode>;

/**
 * Context passed to handlers (Hono-inspired type-safe context)
 *
 * Provides type-safe access to:
 * - Route params (from URL pattern)
 * - Request data (request, searchParams, pathname, url)
 * - Platform bindings (env.DB, env.KV, env.SECRETS)
 * - Middleware variables (var.user, var.permissions)
 * - Getter/setter for variables (get('user'), set('user', ...))
 *
 * @example
 * ```typescript
 * const handler = (ctx: HandlerContext<{ slug: string }, AppEnv>) => {
 *   ctx.params.slug        // Route param (string)
 *   ctx.env.DB             // Binding (D1Database)
 *   ctx.var.user           // Variable (User | undefined)
 *   ctx.get('user')        // Alternative getter
 *   ctx.set('user', {...}) // Setter
 * }
 * ```
 */
export type HandlerContext<TParams = {}, TEnv = any> = {
  params: TParams;
  request: Request;
  searchParams: URLSearchParams;
  pathname: string;
  url: URL;
  env: TEnv extends RouterEnv<infer B, any> ? B : {};
  var: TEnv extends RouterEnv<any, infer V> ? V : {};
  get: TEnv extends RouterEnv<any, infer V>
    ? <K extends keyof V>(key: K) => V[K]
    : (key: string) => any;
  set: TEnv extends RouterEnv<any, infer V>
    ? <K extends keyof V>(key: K, value: V[K]) => void
    : (key: string, value: any) => void;
};

/**
 * Generic params type - flexible object with string keys
 * Users can narrow this by explicitly typing their params:
 *
 * @example
 * ```typescript
 * [revalidate('post')]: (({ currentParams, nextParams }: RevalidateParams<{ slug: string }>) => {
 *   currentParams.slug // typed as string
 *   return currentParams.slug !== nextParams.slug;
 * })
 * ```
 */
export type GenericParams = { [key: string]: string | undefined };

/**
 * Helper type for revalidation handler params
 * Allows inline type annotation for stricter param typing
 *
 * @example
 * ```typescript
 * [revalidate('post')]: (params: RevalidateParams<{ slug: string }>) => {
 *   params.currentParams.slug // typed as string
 *   return params.defaultShouldRevalidate;
 * }
 * ```
 */
export type RevalidateParams<TParams = GenericParams, TEnv = any> = Parameters<ShouldRevalidateFn<TParams, TEnv>>[0];

/**
 * Should revalidate function signature (inspired by React Router)
 *
 * Determines whether a route segment should re-render during partial navigation.
 * Multiple revalidation functions can be defined per route - they execute in order
 * and short-circuit on first `true` (OR logic).
 *
 * @param args.currentParams - Previous route params (generic by default, can be narrowed)
 * @param args.currentUrl - Previous URL
 * @param args.nextParams - Next route params (generic by default, can be narrowed)
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
 * // Generic params (default)
 * [revalidate('post')]: ({ currentParams, nextParams, defaultShouldRevalidate }) => {
 *   return defaultShouldRevalidate; // currentParams is GenericParams
 * }
 *
 * // Explicit typing for stricter params
 * [revalidate('post')]: (({ currentParams, nextParams }) => {
 *   return currentParams.slug !== nextParams.slug; // slug is string | undefined
 * }) satisfies ShouldRevalidateFn<{ slug: string }>
 * ```
 */
export type ShouldRevalidateFn<TParams = GenericParams, TEnv = any> = (args: {
  currentParams: TParams;
  currentUrl: URL;
  nextParams: TParams;
  nextUrl: URL;
  defaultShouldRevalidate: boolean;
  context: HandlerContext<TParams, TEnv>;
  // Future action support:
  actionResult?: any;
  formData?: FormData;
  formMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}) => boolean;

/**
 * Middleware function signature
 * @param TParams - Route params (defaults to GenericParams, can be narrowed with satisfies)
 * @param TEnv - Environment type
 */
export type MiddlewareFn<TParams = GenericParams, TEnv = any> = (
  ctx: HandlerContext<TParams, TEnv>,
  next: () => void | Promise<void>
) => void | Promise<void>;

/**
 * Extract all route keys from a route definition (includes flattened nested routes)
 */
export type RouteKeys<T extends RouteDefinition> = keyof ResolvedRouteMap<T> & string;

/**
 * Valid layout value - component or handler function
 * Note: Arrays are not supported. Use separate layout() declarations with unique names instead.
 */
type LayoutValue<TEnv = any> =
  | ReactNode
  | Handler<any, TEnv>;

/**
 * Helper to extract params from a route key using the resolved (flattened) route map
 */
type ExtractRouteParams<T extends RouteDefinition, K extends string> =
  K extends keyof ResolvedRouteMap<T>
    ? ResolvedRouteMap<T>[K] extends string
      ? ExtractParams<ResolvedRouteMap<T>[K]>
      : GenericParams
    : GenericParams;

/**
 * Handlers object that maps route names to handler functions with type-safe string patterns
 */
export type HandlersForRouteMap<T extends RouteDefinition, TEnv = any> = {
  // Route handlers - type-safe params extracted from route patterns
  [K in RouteKeys<T>]?: Handler<ExtractRouteParams<T, K & string>, TEnv>;
} & {
  // Layout patterns: $layout.{routeName}.{layoutName}
  // Supports '*' wildcard for global layouts that apply to all routes
  [K in `$layout.${RouteKeys<T> | '*'}.${string}`]?: LayoutValue<TEnv>;
} & {
  // Parallel route patterns: $parallel.{routeName}.{parallelName}
  // Supports '*' wildcard for global parallel routes that apply to all routes
  // Params use GenericParams by default (can be narrowed with satisfies)
  [K in `$parallel.${RouteKeys<T> | '*'}.${string}`]?: Record<
    `@${string}`,
    Handler<GenericParams, TEnv>
  >;
} & {
  // Middleware patterns: $middleware.{routeName}.{middlewareName}
  // Supports '*' wildcard for global middleware that applies to all routes
  // Params use GenericParams by default (can be narrowed with satisfies)
  [K in `$middleware.${RouteKeys<T> | '*'}.${string}`]?: MiddlewareFn<GenericParams, TEnv>[];
} & {
  // Revalidate patterns: $revalidate.{routeName}.{revalidateName}
  // Supports '*' wildcard for global revalidations that apply to all routes
  // Multiple revalidations execute in order with short-circuit on first `true` (OR logic)
  // Params use GenericParams by default (can be narrowed with satisfies)
  [K in `$revalidate.${RouteKeys<T> | '*'}.${string}`]?: ShouldRevalidateFn<GenericParams, TEnv>;
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
export interface RouteEntry<TEnv = any> {
  prefix: string;
  routes: ResolvedRouteMap<any>;
  handlers: any;
  registrationId: number;
}
