/**
 * Example: Route Definitions
 *
 * Demonstrates all route definition patterns:
 * - Static routes
 * - Dynamic routes with params
 * - Optional params
 * - Nested route groups
 * - Wildcard routes
 */

import { route } from '../../src/route-definition';

// Main routes - Static and simple
export const mainRoutes = route({
  home: '/',
  about: '/about',
  contact: '/contact',
  features: '/features',
});

// Blog routes - Dynamic params and categories
export const blogRoutes = route({
  index: '/',
  show: '/:slug',
  category: '/:category/:slug',
  archive: '/archive/:year?/:month?', // Optional params
});

// Dashboard routes - Nested admin interface
export const dashboardRoutes = route({
  index: '/',
  analytics: '/analytics',
  settings: '/settings',
  users: {
    list: '/users',
    detail: '/users/:id',
    edit: '/users/:id/edit',
  },
});

// API routes - Wildcard for file handling
export const apiRoutes = route({
  health: '/health',
  files: '/files/*', // Wildcard route
});
