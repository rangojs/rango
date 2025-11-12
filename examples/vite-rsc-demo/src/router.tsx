import { createRSCRouter } from 'rsc-router';
import { homeRoutes, blogRoutes, aboutRoutes, dashboardRoutes } from './routes.js';

/**
 * App context (empty for now, but typed for future use)
 */
export interface AppContext {
  // Add app-specific context here (db, user, etc.)
}

/**
 * Create and configure the router
 */
export const router = createRSCRouter<AppContext>();

// Register routes with lazy-loaded handlers
router
  .route('', homeRoutes)
  .map(() => import('./handlers/home.js'))

  .route('/blog', blogRoutes)  // Mount blog routes at /blog prefix
  .map(() => import('./handlers/blog.js'))

  .route('', aboutRoutes)
  .map(() => import('./handlers/about.js'))

  .route('/dashboard', dashboardRoutes)  // Dashboard with parallel routes
  .map(() => import('./handlers/dashboard.js'));

console.log('[Router] Configured with 4 route groups (lazy-loaded handlers)');
