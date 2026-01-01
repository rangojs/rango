/**
 * Server-side loader registry for GET-based fetching
 *
 * Loaders are loaded lazily via dynamic imports when first requested.
 * The RSC handler looks up loaders by $$id to execute them.
 */

import type { LoaderFn, MiddlewareFn } from "../types.js";
import { getFetchableLoader } from "../loader.js";

interface RegisteredLoader {
  fn: LoaderFn<any, any, any>;
  middleware: MiddlewareFn<any>[];
}

// Server-side registry - maps loader $$id to function and middleware
const loaderRegistry = new Map<string, RegisteredLoader>();

// Lazy import map - set by the loader manifest
// Maps loader $$id to a function that imports the loader module
type LazyLoaderImport = () => Promise<{ $$id?: string; name: string }>;
let lazyLoaderImports: Map<string, LazyLoaderImport> | null = null;

/**
 * Set the lazy loader imports map (called by the loader manifest)
 */
export function setLoaderImports(
  imports: Record<string, LazyLoaderImport>
): void {
  lazyLoaderImports = new Map(Object.entries(imports));
}

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
 * Get a registered loader by name (synchronous)
 * Returns undefined if loader is not registered
 */
export function getLoader(name: string): RegisteredLoader | undefined {
  return loaderRegistry.get(name);
}

/**
 * Get a loader by $$id, loading it lazily if needed
 * This is the primary method for the RSC handler to get loaders
 *
 * In production: IDs are hashed, looked up via the lazy import map
 * In dev: IDs are "filePath#exportName", resolved via dynamic import
 */
export async function getLoaderLazy(
  id: string
): Promise<RegisteredLoader | undefined> {
  // Check if already cached
  const existing = loaderRegistry.get(id);
  if (existing) {
    return existing;
  }

  // Try to lazy load from the import map (production mode)
  if (lazyLoaderImports && lazyLoaderImports.size > 0) {
    const lazyImport = lazyLoaderImports.get(id);
    if (lazyImport) {
      try {
        // Import the loader - this triggers createLoader which registers fn in fetchableLoaderRegistry
        const loader = await lazyImport();

        // Get fn directly from the internal registry (keyed by loader.name)
        const internalLoader = getFetchableLoader(loader.name);
        if (internalLoader) {
          // Cache for future requests
          const registered: RegisteredLoader = {
            fn: internalLoader.fn,
            middleware: internalLoader.middleware,
          };
          loaderRegistry.set(id, registered);
          return registered;
        }
      } catch (error) {
        console.error(`[LoaderRegistry] Failed to load loader "${id}":`, error);
      }
    }
  }

  // Dev mode fallback: parse the ID and use Vite's dynamic import
  // ID format in dev: "src/path/to/file.ts#ExportName"
  const hashIndex = id.indexOf("#");
  if (hashIndex !== -1) {
    const filePath = id.slice(0, hashIndex);
    const exportName = id.slice(hashIndex + 1);

    try {
      // In dev mode, Vite handles dynamic imports
      const module = await import(/* @vite-ignore */ `/${filePath}`);
      const loader = module[exportName];

      if (loader) {
        // Get fn from the internal registry (set when createLoader runs)
        const internalLoader = getFetchableLoader(loader.name);
        if (internalLoader) {
          const registered: RegisteredLoader = {
            fn: internalLoader.fn,
            middleware: internalLoader.middleware,
          };
          loaderRegistry.set(id, registered);
          return registered;
        }
      }
    } catch (error) {
      console.error(`[LoaderRegistry] Failed to load loader "${id}":`, error);
    }
  }

  return undefined;
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

/**
 * Register a loader by its $$id (injected by Vite plugin)
 * This is called by the exposeLoaderId plugin during module loading
 */
export function registerLoaderById(loader: {
  $$id?: string;
  name: string;
  fn?: LoaderFn<any, any, any>;
}): void {
  if (!loader.$$id) {
    // Skip loaders without $$id (non-fetchable loaders)
    return;
  }
  if (loaderRegistry.has(loader.$$id)) {
    // Already registered (can happen during HMR)
    return;
  }

  // For fetchable loaders, fn is stored in the internal registry, not on the loader object
  // Look it up by name to get the fn and middleware
  const internalLoader = getFetchableLoader(loader.name);
  if (internalLoader) {
    loaderRegistry.set(loader.$$id, {
      fn: internalLoader.fn,
      middleware: internalLoader.middleware,
    });
    return;
  }

  // Fall back to using fn from the loader object (non-fetchable loaders)
  if (loader.fn) {
    loaderRegistry.set(loader.$$id, { fn: loader.fn, middleware: [] });
  }
}
