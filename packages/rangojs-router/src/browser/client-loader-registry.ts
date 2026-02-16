/**
 * Client-side loader function registry.
 *
 * Stores client loader functions (from createClientLoader and
 * createIsomorphicLoader) so they can be looked up and executed
 * during SPA navigation in the browser.
 *
 * Populated at module load time when loader modules are imported.
 */

import type { ClientLoaderFn } from "../types.js";

const clientLoaderRegistry = new Map<string, ClientLoaderFn<any>>();

export function registerClientLoader(
  id: string,
  fn: ClientLoaderFn<any>,
): void {
  clientLoaderRegistry.set(id, fn);
}

export function getClientLoader(
  id: string,
): ClientLoaderFn<any> | undefined {
  return clientLoaderRegistry.get(id);
}
