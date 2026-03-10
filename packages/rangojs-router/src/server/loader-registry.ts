/**
 * Server-side loader registry for GET-based fetching
 *
 * Loaders are loaded lazily via dynamic imports when first requested.
 * The RSC handler looks up loaders by $$id to execute them.
 */

import type { LoaderFn } from "../types.js";
import {
  getFetchableLoader,
  type LoaderRegistryEntry,
} from "./fetchable-loader-store.js";

// Server-side cache - maps loader $$id to function and middleware
// This is a CACHE populated by getLoaderLazy() when loaders are first accessed.
// The source of truth is fetchableLoaderRegistry in loader.ts, which is populated
// when createLoader() runs. This cache exists to:
// 1. Avoid repeated lookups/imports for the same loader
// 2. Support lazy loading in production (loaders imported on-demand)
// 3. Provide a stable reference for the RSC handler
const loaderRegistry = new Map<string, LoaderRegistryEntry>();

// Lazy import map - set by the loader manifest
// Maps loader $$id to a function that imports the loader module
type LazyLoaderImport = () => Promise<{ $$id: string }>;
let lazyLoaderImports: Map<string, LazyLoaderImport> | null = null;

/**
 * Set the lazy loader imports map (called by the loader manifest)
 */
export function setLoaderImports(
  imports: Record<string, LazyLoaderImport>,
): void {
  lazyLoaderImports = new Map(Object.entries(imports));
}

/**
 * Get a loader by $$id, loading it lazily if needed
 * This is the primary method for the RSC handler to get loaders
 *
 * In production: IDs are hashed, looked up via the lazy import map
 * In dev: IDs are "filePath#exportName", resolved via dynamic import
 */
export async function getLoaderLazy(
  id: string,
): Promise<LoaderRegistryEntry | undefined> {
  // Check if already cached in main registry
  const existing = loaderRegistry.get(id);
  if (existing) {
    return existing;
  }

  // Check the fetchable loader registry (populated by createLoader)
  const fetchable = getFetchableLoader(id);
  if (fetchable) {
    // Cache in main registry for future requests
    loaderRegistry.set(id, fetchable);
    return fetchable;
  }

  // Try to lazy load from the import map (production mode)
  if (lazyLoaderImports && lazyLoaderImports.size > 0) {
    const lazyImport = lazyLoaderImports.get(id);
    if (lazyImport) {
      try {
        // Import the loader module - this triggers createLoader which registers fn
        await lazyImport();

        // Now try to get from fetchable registry (createLoader registered it)
        const registered = getFetchableLoader(id);
        if (registered) {
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

    try {
      // In dev mode, Vite handles dynamic imports
      // Just importing the module triggers createLoader which registers the fn
      await import(/* @vite-ignore */ `/${filePath}`);

      // Now try to get from fetchable registry
      const registered = getFetchableLoader(id);
      if (registered) {
        loaderRegistry.set(id, registered);
        return registered;
      }
    } catch (error) {
      console.error(`[LoaderRegistry] Failed to load loader "${id}":`, error);
    }
  }

  return undefined;
}

/**
 * Register a loader by its $$id (injected by Vite plugin)
 * This is called during module loading to cache loaders
 */
export function registerLoaderById(loader: {
  $$id: string;
  fn?: LoaderFn<any, any, any>;
}): void {
  if (!loader.$$id) {
    return;
  }
  // For fetchable loaders, fn is stored in the fetchable registry by $$id.
  // Always re-check the fetchable registry so HMR picks up the new function.
  const fetchable = getFetchableLoader(loader.$$id);
  if (fetchable) {
    loaderRegistry.set(loader.$$id, fetchable);
    return;
  }

  // Fall back to using fn from the loader object (non-fetchable loaders)
  if (loader.fn) {
    loaderRegistry.set(loader.$$id, {
      fn: loader.fn,
      middleware: [],
      fetchable: false,
    });
  }
}
