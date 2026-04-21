import type { ContextVar } from "../context-var.js";
import type { Handle } from "../handle.js";
import type { MiddlewareFn } from "../router/middleware.js";
import type { ScopedReverseFunction } from "../reverse.js";
import type { SearchSchema, ResolveSearchSchema } from "../search-params.js";
import type {
  DefaultEnv,
  DefaultReverseRouteMap,
  DefaultVars,
} from "./global-namespace.js";
import type { RequestScope } from "./request-scope.js";

/**
 * Context passed to loader functions during execution
 *
 * Loaders run after middleware but before handlers, so they have access
 * to middleware-set variables via get().
 *
 * @template TParams - Route params type (e.g., { slug: string })
 * @template TEnv - Environment type for bindings/variables
 *
 * @example
 * ```typescript
 * const CartLoader = createLoader(async (ctx) => {
 *   "use server";
 *   const user = ctx.get("user");  // From auth middleware
 *   return await db.cart.get(user.id);
 * });
 *
 * // With typed params:
 * const ProductLoader = createLoader<Product, { slug: string }>(async (ctx) => {
 *   "use server";
 *   const { slug } = ctx.params;  // slug is typed as string
 *   return await db.products.findBySlug(slug);
 * });
 * ```
 */
export type LoaderContext<
  TParams = Record<string, string | undefined>,
  TEnv = DefaultEnv,
  TBody = unknown,
  TSearch extends SearchSchema = {},
> = RequestScope<TEnv> & {
  params: TParams;
  /**
   * Route params extracted from the URL pattern match (server-side only).
   * Unlike `params`, these cannot be overridden by client-provided loader params.
   * Use this when you need trusted, server-matched route params for auth or
   * resource scoping.
   */
  routeParams: Record<string, string>;
  search: {} extends TSearch ? {} : ResolveSearchSchema<TSearch>;
  get: {
    <T>(contextVar: ContextVar<T>): T | undefined;
  } & (<K extends keyof DefaultVars>(key: K) => DefaultVars[K]);
  /**
   * Access another loader's data, or read handle data after rendered().
   *
   * For loaders: returns a promise (loaders run in parallel).
   * For handles: returns collected data (only after `await ctx.rendered()`).
   */
  use: {
    <T, TLoaderParams = any>(
      loader: LoaderDefinition<T, TLoaderParams>,
    ): Promise<T>;
    <TData, TAccumulated = TData[]>(
      handle: Handle<TData, TAccumulated>,
    ): TAccumulated;
  };
  /**
   * **Experimental.** Wait for all non-loader segments to settle.
   *
   * After the returned promise resolves, handle data is available via
   * `ctx.use(handle)`. Only supported in DSL loaders on non-streaming
   * trees (no `loading()`). Throws if called from a handler-invoked
   * loader or when the tree uses streaming.
   *
   * @example
   * ```typescript
   * const PricesLoader = createLoader(async (ctx) => {
   *   "use server";
   *   await ctx.rendered();
   *   const products = ctx.use(Products); // reads handle data
   *   return pricing.getLive(products.map(p => p.id));
   * });
   * ```
   */
  rendered: () => Promise<void>;
  /**
   * HTTP method (GET, POST, PUT, PATCH, DELETE)
   * Available when loader is called via load({ method: "POST", ... })
   */
  method: string;
  /**
   * Request body for POST/PUT/PATCH/DELETE requests
   * Available when loader is called via load({ method: "POST", body: {...} })
   */
  body: TBody | undefined;
  /**
   * Form data when loader is invoked via action (fetchable loaders)
   * Available when loader is called via form submission
   */
  formData?: FormData;
  /**
   * Generate URLs from route names.
   * Same scoped reverse as route handlers — `.name` resolves within the
   * current include() scope, `name` resolves globally.
   */
  reverse: ScopedReverseFunction<
    Record<string, string>,
    DefaultReverseRouteMap
  >;
};

/**
 * Loader function signature
 *
 * @template T - The return type of the loader
 * @template TParams - Route params type (defaults to generic Record)
 * @template TEnv - Environment type for bindings/variables
 *
 * @example
 * ```typescript
 * const myLoader: LoaderFn<{ items: Item[] }> = async (ctx) => {
 *   "use server";
 *   return { items: await db.items.list() };
 * };
 *
 * // With typed params:
 * const productLoader: LoaderFn<Product, { slug: string }> = async (ctx) => {
 *   "use server";
 *   const { slug } = ctx.params;  // typed as string
 *   return await db.products.findBySlug(slug);
 * };
 * ```
 */
export type LoaderFn<
  T,
  TParams = Record<string, string | undefined>,
  TEnv = DefaultEnv,
> = (ctx: LoaderContext<TParams, TEnv>) => Promise<T> | T;

/**
 * Options for fetchable loaders
 *
 * Middleware uses the same MiddlewareFn signature as route/app middleware,
 * enabling reuse of the same middleware functions everywhere.
 */
export type FetchableLoaderOptions = {
  fetchable?: true;
  middleware?: MiddlewareFn[];
};

/**
 * Options for load() calls - type-safe union based on method
 */
export type LoadOptions =
  | {
      method?: "GET";
      params?: Record<string, string>;
    }
  | {
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      params?: Record<string, string>;
      body?: FormData | Record<string, any>;
    };

/**
 * Loader definition object
 *
 * Created via createLoader(). Contains the loader name and function.
 * On client builds, the fn is stripped by the bundler (via "use server" directive).
 *
 * @template T - The return type of the loader
 * @template TParams - Route params type (for type-safe params access)
 *
 * @example
 * ```typescript
 * // Definition (same file works on server and client)
 * export const CartLoader = createLoader(async (ctx) => {
 *   "use server";
 *   return await db.cart.get(ctx.get("user").id);
 * });
 *
 * // With typed params:
 * export const ProductLoader = createLoader<Product, { slug: string }>(async (ctx) => {
 *   "use server";
 *   const { slug } = ctx.params;  // slug is typed as string
 *   return await db.products.findBySlug(slug);
 * });
 *
 * // Client usage (preferred — cache-safe, always fresh)
 * const { data } = useLoader(CartLoader);
 *
 * // Server escape hatch (handler needs data directly)
 * const cart = await ctx.use(CartLoader);
 * ```
 */
export type LoaderDefinition<
  T = any,
  TParams = Record<string, string | undefined>,
> = {
  __brand: "loader";
  $$id: string; // Injected by Vite plugin (exposeInternalIds) - unique identifier
  fn?: LoaderFn<T, TParams, any>; // Optional - server-side only, stored in registry for RSC
};
