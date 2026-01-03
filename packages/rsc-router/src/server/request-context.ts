/**
 * Request Context - AsyncLocalStorage for passing request-scoped data to server actions
 *
 * Server actions are invoked by the React runtime but execute within the RSC handler.
 * This context allows actions to access request-scoped data like platform bindings (env),
 * the original request, and middleware variables.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped context available to server actions
 */
export interface RequestContext<TEnv = unknown> {
  /** Platform bindings (Cloudflare env, etc.) */
  env: TEnv;
  /** Original HTTP request */
  request: Request;
  /** Parsed URL */
  url: URL;
  /** Variables set by middleware */
  variables: Record<string, any>;
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
