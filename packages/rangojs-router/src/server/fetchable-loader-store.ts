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

const fetchableLoaderRegistry = new Map<
  string,
  { fn: LoaderFn<any, any, any>; middleware: MiddlewareFn[] }
>();

export function registerFetchableLoader(
  id: string,
  fn: LoaderFn<any, any, any>,
  middleware: MiddlewareFn[],
): void {
  fetchableLoaderRegistry.set(id, { fn, middleware });
}

export function getFetchableLoader(
  id: string,
): { fn: LoaderFn<any, any, any>; middleware: MiddlewareFn[] } | undefined {
  return fetchableLoaderRegistry.get(id);
}
