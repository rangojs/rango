/**
 * Fetchable loader store - internal registry for fetchable loader functions.
 *
 * Extracted into its own module to avoid circular dependencies between
 * loader.rsc.ts and request-context.ts. This module has no imports from
 * either, so both can safely import from here.
 *
 * Populated by createLoader() in loader.rsc.ts.
 * Read by request-context.ts (for ctx.use()) and loader-registry.ts (for GET-based fetching).
 */

import type { LoaderFn } from "../types.js";
import type { MiddlewareFn } from "../router/middleware.js";

export interface LoaderRegistryEntry {
  fn: LoaderFn<any, any, any>;
  middleware: MiddlewareFn[];
  /** Whether this loader is fetchable via the _rsc_loader endpoint. */
  fetchable: boolean;
}

const fetchableLoaderRegistry = new Map<string, LoaderRegistryEntry>();

export function registerFetchableLoader(
  id: string,
  fn: LoaderFn<any, any, any>,
  middleware: MiddlewareFn[],
  fetchable: boolean,
): void {
  fetchableLoaderRegistry.set(id, { fn, middleware, fetchable });
}

export function getFetchableLoader(
  id: string,
): LoaderRegistryEntry | undefined {
  return fetchableLoaderRegistry.get(id);
}
