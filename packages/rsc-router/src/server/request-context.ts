/**
 * Request Context - AsyncLocalStorage for passing request-scoped data throughout rendering
 *
 * This context is available throughout the entire request lifecycle:
 * - Middleware execution
 * - Route handlers and loaders
 * - Server components during rendering
 * - Error boundaries and streaming
 *
 * The shape matches HandlerContext as closely as possible, except:
 * - No `params` (route-specific, determined after route matching)
 * - No `use` (requires loader resolution system)
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped context available via getRequestContext()
 *
 * Similar to HandlerContext but available globally during request processing.
 * Use this when you need access to env/request outside of route handlers.
 */
export interface RequestContext<TEnv = unknown, TParams = Record<string, string>> {
  /** Platform bindings (Cloudflare env, etc.) */
  env: TEnv;
  /** Original HTTP request */
  request: Request;
  /** Parsed URL (system params like _rsc* are NOT filtered here) */
  url: URL;
  /** URL pathname */
  pathname: string;
  /** URL search params (system params like _rsc* are NOT filtered here) */
  searchParams: URLSearchParams;
  /** Variables set by middleware (same as ctx.var) */
  var: Record<string, any>;
  /** Get a variable set by middleware */
  get: <K extends string>(key: K) => any;
  /** Set a variable (shared with middleware and handlers) */
  set: <K extends string>(key: K, value: any) => void;
  /**
   * Route params (populated after route matching)
   * Initially empty, then set to matched params
   */
  params: TParams;
}

// AsyncLocalStorage instance for request context
const requestContextStorage = new AsyncLocalStorage<RequestContext<any>>();

/**
 * Run a function within a request context
 * Used by the RSC handler to provide context to server actions
 */
export function runWithRequestContext<TEnv, T>(
  context: RequestContext<TEnv>,
  fn: () => T
): T {
  return requestContextStorage.run(context, fn);
}

/**
 * Get the current request context
 * Returns undefined if not running within a request context
 */
export function getRequestContext<TEnv = unknown>(): RequestContext<TEnv> | undefined {
  return requestContextStorage.getStore() as RequestContext<TEnv> | undefined;
}

/**
 * Update params on the current request context
 * Called after route matching to populate route params
 */
export function setRequestContextParams(params: Record<string, string>): void {
  const ctx = requestContextStorage.getStore();
  if (ctx) {
    ctx.params = params;
  }
}

/**
 * Get the current request context, throwing if not available
 * Use this when context is required (e.g., in loader actions)
 */
export function requireRequestContext<TEnv = unknown>(): RequestContext<TEnv> {
  const ctx = getRequestContext<TEnv>();
  if (!ctx) {
    throw new Error(
      "Request context not available. This function must be called from within a server action " +
      "executed through the RSC handler."
    );
  }
  return ctx;
}
