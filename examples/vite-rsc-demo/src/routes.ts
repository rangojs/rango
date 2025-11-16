import { route } from 'rsc-router';

/**
 * Home route
 */
export const homeRoutes = route({
  index: '/',
});

/**
 * Blog routes with params (relative paths - will be mounted at /blog)
 */
export const blogRoutes = route({
  index: '/',
  post: '/:slug',
});

/**
 * About route
 */
export const aboutRoutes = route({
  index: '/about',
});

/**
 * Dashboard routes (for testing parallel routes)
 */
export const dashboardRoutes = route({
  index: '/',
  settings: '/settings',
});

/**
 * Shop routes - comprehensive ecommerce example
 * Tests nested routes, dynamic segments, layout composition, and parallel routes
 */
export const shopRoutes = route({
  index: '/',
  products: {
    category: '/products/:category',
    detail: {
      index: '/product/:slug',
      reviews: {
        index: '/product/:slug/reviews',
        detail: '/product/:slug/reviews/:reviewId',
        edit: {
          index: '/product/:slug/reviews/:reviewId/edit',
        },
      },
    },
  },
  cart: '/cart',
  checkout: {
    index: '/checkout',
    payment: '/checkout/payment',
    confirm: '/checkout/confirm',
  },
  account: {
    index: '/account',
    orders: '/account/orders',
    orderDetail: '/account/orders/:id',
  },
});

/**
 * Admin routes - demonstrates soft/hard revalidation pattern
 * Tests global soft decisions with route-specific overrides
 */
export const adminRoutes = route({
  index: '/',
  users: '/users',
  user: '/users/:id',
  settings: '/settings',
});

/**
 * Protected routes - demonstrates middleware short-circuit & system param filtering
 * Tests soft/hard redirects, error handling, transparent URLs
 */
export const protectedRoutes = route({
  index: '/',
  dashboard: '/dashboard',
  profile: '/profile/:username',
});
