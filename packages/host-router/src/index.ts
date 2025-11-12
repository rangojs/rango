/**
 * Host Router
 *
 * A routing system for managing multi-application hosting based on
 * domain/subdomain patterns with support for cookie-based host override
 * for development environments.
 *
 * @example
 * ```ts
 * import { createHostRouter } from 'host-router';
 *
 * const router = createHostRouter();
 *
 * router.host(['.']).map(() => import('./apps/main'));
 * router.host(['admin.*']).map(() => import('./apps/admin'));
 *
 * export default {
 *   fetch(request) {
 *     return router.match(request);
 *   }
 * };
 * ```
 */

// Core router
export { createHostRouter } from './router.js';

// Utilities
export { defineHosts } from './utils.js';

// Errors
export {
  HostRouterError,
  InvalidPatternError,
  HostOverrideNotAllowedError,
  InvalidHostnameError,
  HostValidationError,
  NoRouteMatchError,
  InvalidHandlerError,
} from './errors.js';

// Types
export type {
  HostRouter,
  HostRouteBuilder,
  HostRouterOptions,
  Handler,
  LazyHandler,
  Middleware,
  HostPattern,
  HostMatchResult,
  HostOverrideConfig,
} from './types.js';
