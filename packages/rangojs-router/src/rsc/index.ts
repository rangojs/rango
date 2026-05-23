/**
 * Rango - RSC Entry Point
 *
 * This module provides RSC utilities for server-side rendering,
 * server actions, loader fetching, and progressive enhancement.
 *
 * @example Basic usage
 * ```tsx
 * import { router } from "./router.js";
 *
 * // Use router.fetch to handle requests
 * export default { fetch: router.fetch };
 * ```
 */

// Re-export createRSCHandler for custom handler setup
export { createRSCHandler } from "./handler.js";

// Re-export types
export type {
  RscPayload,
  ReactFormState,
  RSCDependencies,
  SSRRenderOptions,
  SSRModule,
  LoadSSRModule,
  CreateRSCHandlerOptions,
  HandlerCacheConfig,
  NonceProvider,
} from "./types.js";

// Re-export request context utilities for server-side access to env/request/params
export {
  getRequestContext,
  requireRequestContext,
} from "../server/request-context.js";
