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

// Cache populated by getLoaderLazy() when loaders are first accessed.
// Source of truth is fetchableLoaderRegistry in loader.ts (populated on createLoader).
const loaderRegistry = new Map<string, LoaderRegistryEntry>();

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
  // Check fetchableLoaderRegistry first — it's the source of truth.
  // createLoader() updates it on HMR, ensuring fresh functions after file changes.
  const fetchable = getFetchableLoader(id);
  if (fetchable) {
    loaderRegistry.set(id, fetchable);
    return fetchable;
  }

  const existing = loaderRegistry.get(id);
  if (existing) {
    return existing;
  }

  if (lazyLoaderImports && lazyLoaderImports.size > 0) {
    const lazyImport = lazyLoaderImports.get(id);
    if (lazyImport) {
      // A failed import is a real server breakage (broken transitive import,
      // syntax error, throw in module top-level code), not a "loader not
      // registered" case. Rethrow so the caller can return a 500 and route
      // the failure through onError, instead of collapsing it to a 404.
      await lazyImport();

      const registered = getFetchableLoader(id);
      if (registered) {
        loaderRegistry.set(id, registered);
        return registered;
      }
    }
  }

  // Dev fallback: parse ID (format: "src/path/to/file.ts#ExportName") and import
  const hashIndex = id.indexOf("#");
  if (hashIndex !== -1) {
    const filePath = id.slice(0, hashIndex);

    // Same as the lazy branch: a thrown import is a server error, not a
    // not-found. Let it propagate to the caller for a 500 + onError.
    await import(/* @vite-ignore */ `/${filePath}`);

    const registered = getFetchableLoader(id);
    if (registered) {
      loaderRegistry.set(id, registered);
      return registered;
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
  const fetchable = getFetchableLoader(loader.$$id);
  if (fetchable) {
    loaderRegistry.set(loader.$$id, fetchable);
    return;
  }

  if (loader.fn) {
    loaderRegistry.set(loader.$$id, {
      fn: loader.fn,
      middleware: [],
      fetchable: false,
    });
  }
}
