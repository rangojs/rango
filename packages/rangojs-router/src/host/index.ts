/**
 * Host Router
 *
 * A routing system for managing multi-application hosting based on
 * domain/subdomain patterns with support for cookie-based host override
 * for development environments.
 *
 * @example
 * ```ts
 * import { createHostRouter } from '@rangojs/router/host';
 *
 * const router = createHostRouter();
 *
 * router.host(['.']).lazy(() => import('./apps/main'));
 * router.host(['admin.*']).lazy(() => import('./apps/admin'));
 *
 * export default {
 *   fetch(request) {
 *     return router.match(request);
 *   }
 * };
 * ```
 *
 * The host surface (`Handler`, `Middleware`, `match`, `HostOverrideConfig.validate`)
 * types `input` as `RouterRequestInput<any>` by design: a host router fans out to
 * heterogeneous sub-apps with differing env/vars shapes, so there is no single
 * `TEnv`/`TVars` to thread through. `input.env`/`input.vars` are therefore `any`
 * here; the typed env shape lives on each sub-app's `createRouter<TEnv>()`.
 */

// Core router
export { createHostRouter } from "./router.js";

// Utilities
export { defineHosts } from "./utils.js";

// Errors
export {
  HostRouterError,
  InvalidPatternError,
  HostOverrideNotAllowedError,
  InvalidHostnameError,
  HostValidationError,
  NoRouteMatchError,
  isNoRouteMatchError,
  InvalidHandlerError,
} from "./errors.js";

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
} from "./types.js";
