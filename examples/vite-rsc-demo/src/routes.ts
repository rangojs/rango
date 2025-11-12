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
