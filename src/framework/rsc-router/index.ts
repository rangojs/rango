/**
 * RSC Router - Type-safe router for React Server Components
 *
 * This package provides both imperative and declarative APIs for routing in RSC applications.
 *
 * @example Imperative API (Express-style):
 * ```typescript
 * import { RscRouter } from 'rsc-router';
 *
 * const router = new RscRouter();
 * router.layout("/", async (ctx, children) => <RootLayout>{children}</RootLayout>);
 * router.get("/", async (ctx) => <HomePage />);
 * router.get("/about", async (ctx) => <AboutPage />);
 * ```
 *
 * @example Declarative API (Type-safe):
 * ```typescript
 * import { createRouter, route, middleware, layout } from 'rsc-router';
 *
 * const routes = route({
 *   home: "/",
 *   about: "/about",
 *   blog: {
 *     index: "/",
 *     show: "/:slug"
 *   }
 * });
 *
 * const router = createRouter(routes);
 * router.map(routes, {
 *   home: async () => <HomePage />,
 *   about: async () => <AboutPage />,
 *   blog: {
 *     [layout]: () => import("./layouts/BlogLayout"),
 *     index: async () => <BlogListPage />,
 *     show: async (ctx) => <BlogPostPage slug={ctx.params.slug} />
 *   }
 * });
 * ```
 */

// Export imperative API (backward compatibility)
export { RscRouter } from "./imperative";
export type {
  RouteContext,
  RouteHandler,
  LayoutHandler,
  MiddlewareHandler,
  Route,
} from "./imperative";

// Export Outlet components
export { Outlet, OutletProvider, useOutlet } from "./Outlet";

// Export declarative API
export {
  route,
  createRouter,
  DeclarativeRouter,
  // Symbol exports
  middleware,
  layout,
  revalidate,
  loading,
  error,
} from "./declarative";

// Export types
export type {
  RevalidationContext,
  RevalidationHandler,
  LoadingHandler,
  ErrorHandler,
  HttpMethod,
  ExtractRouteParams,
  TypedRoute,
  RouteMap,
  RouteDefinition,
  HandlerMap,
} from "./types";

// Export symbols as a namespace for convenience
export { RouteSymbols } from "./types";