/**
 * Server-side loader registry for GET-based fetching
 *
 * Loaders register themselves when created with `fetchable: true`.
 * The RSC handler looks up loaders by name to execute them.
 */

import type { LoaderFn, MiddlewareFn } from "../types.js";

interface RegisteredLoader {
  fn: LoaderFn<any, any, any>;
  middleware: MiddlewareFn<any>[];
}

// Server-side registry - maps loader name to function and middleware
const loaderRegistry = new Map<string, RegisteredLoader>();

/**
 * Register a fetchable loader
 * Called by createLoader when fetchable option is provided
 */
export function registerLoader(
  name: string,
  fn: LoaderFn<any, any, any>,
  middleware: MiddlewareFn<any>[] = []
): void {
  if (loaderRegistry.has(name)) {
    console.warn(
      `[LoaderRegistry] Loader "${name}" is already registered. ` +
      `This may cause issues if different loaders share the same name.`
    );
  }
  loaderRegistry.set(name, { fn, middleware });
}

/**
 * Get a registered loader by name
 * Returns undefined if loader is not registered
 */
export function getLoader(name: string): RegisteredLoader | undefined {
  return loaderRegistry.get(name);
}

/**
 * Check if a loader is registered
 */
export function hasLoader(name: string): boolean {
  return loaderRegistry.has(name);
}

/**
 * Get all registered loader names (for debugging)
 */
export function getRegisteredLoaderNames(): string[] {
  return Array.from(loaderRegistry.keys());
}
