/**
 * Example: Route Definitions
 *
 * Define all routes for the application using the route() function.
 * Routes are type-safe and can be nested for organization.
 */

import { route } from '../../src/route-definition';

// Main routes
export const mainRoutes = route({
  home: '/',
  about: '/about',
  contact: '/contact',
});

// Blog routes
export const blogRoutes = route({
  index: '/',
  show: '/:slug',
  category: '/:category/:slug',
});

// Dashboard routes
export const dashboardRoutes = route({
  index: '/',
  analytics: '/analytics',
  settings: '/settings',
  profile: '/profile',
});
