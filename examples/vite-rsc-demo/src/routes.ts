import { route } from "@ivogt/rsc-router";

/**
 * Home route
 */
export const homeRoutes = route({
  "home.index": "/",
});

/**
 * Blog routes with params (relative paths - will be mounted at /blog)
 */
export const blogRoutes = route({
  "blog.index": "/",
  "blog.post": "/:slug",
});

/**
 * About route
 */
export const aboutRoutes = route({
  "about.index": "/about",
});

/**
 * Dashboard routes (for testing parallel routes)
 */
export const dashboardRoutes = route({
  "dashboard.index": "/",
  "dashboard.settings": "/settings",
});

/**
 * Shop routes - comprehensive ecommerce example
 * Tests nested routes, dynamic segments, layout composition, and parallel routes
 */
export const shopRoutes = route({
  "shop.index": "/",
  "shop.products.category": "/products/:category",
  "shop.products.detail.view": "/product/:slug",
  "shop.products.detail.reviews.index": "/product/:slug/reviews",
  "shop.products.detail.reviews.detail": "/product/:slug/reviews/:reviewId",
  "shop.products.detail.reviews.edit.index": "/product/:slug/reviews/:reviewId/edit",
  "shop.cart": "/cart",
  "shop.checkout.index": "/checkout",
  "shop.checkout.payment": "/checkout/payment",
  "shop.checkout.confirm": "/checkout/confirm",
  "shop.account.index": "/account",
  "shop.account.orders": "/account/orders",
  "shop.account.orderDetail": "/account/orders/:id",
});

/**
 * Admin routes - demonstrates soft/hard revalidation pattern
 * Tests global soft decisions with route-specific overrides
 */
export const adminRoutes = route({
  "admin.index": "/",
  "admin.users": "/users",
  "admin.user": "/users/:id",
  "admin.settings": "/settings",
});

/**
 * Protected routes - demonstrates middleware short-circuit & system param filtering
 * Tests soft/hard redirects, error handling, transparent URLs
 */
export const protectedRoutes = route({
  "protected.index": "/",
  "protected.dashboard": "/dashboard",
  "protected.profile": "/profile/:username",
});

/**
 * Todos routes - demonstrates loaders, actions, and streaming
 * Tests CRUD operations with server actions and optimistic updates
 */
export const todosRoutes = route({
  "todos.index": "/",
  "todos.detail": "/:id",
});

/**
 * Error routes - demonstrates error boundary and notFound boundary handling
 * Tests server-side error capture and fallback UI rendering
 */
export const errorRoutes = route({
  "errors.index": "/",
  "errors.throwError": "/throw",
  "errors.loaderError": "/loader-error",
  "errors.notFound": "/not-found",
  "errors.notFoundLoader": "/not-found-loader",
  "errors.unhandled": "/unhandled",
  "errors.clientError": "/client-error",
});

/**
 * Kanban routes - Trello-like board with columns and cards
 * Tests optimistic updates with drag-and-drop card management
 */
export const kanbanRoutes = route({
  "kanban.index": "/",
  "kanban.card": "/card/:cardId",
});

/**
 * Loaders demo routes - demonstrates useLoader and useFetchLoader APIs
 * Shows SSR loader data access vs on-demand client-side fetching
 */
export const loadersRoutes = route({
  "loaders.index": "/",
  "loaders.stats": "/stats",
});

/**
 * Middleware demo routes - comprehensive middleware examples
 * Demonstrates global, pattern-based, route-level, and loader middleware
 */
export const middlewareRoutes = route({
  "middleware.index": "/",
  "middleware.dashboard": "/dashboard",
  "middleware.timed": "/timed",
  "middleware.user": "/user/:userId",
  "middleware.api": "/api/data",
});
