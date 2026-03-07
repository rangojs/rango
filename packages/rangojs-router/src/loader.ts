/**
 * rsc-router/loader (client version)
 *
 * Client-only stub for createLoader. Returns a minimal loader definition
 * ({ __brand, $$id }) that can be passed to hooks like useLoader.
 * The actual loader function is not included -- it only exists on the server.
 *
 * For export-only loader files, the Vite plugin replaces the entire file with
 * object literals (bypassing this function). Those stubs only contain
 * { __brand, $$id }.
 * This function only runs when loaders are in mixed files (not export-only).
 *
 * The $$id is injected by the Vite exposeInternalIds plugin.
 */

import type {
  FetchableLoaderOptions,
  LoaderDefinition,
  LoaderFn,
} from "./types.js";

// Overload 1: With function only (not fetchable)
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 2: Fetchable with `true` (no middleware)
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable: true,
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 3: Fetchable with middleware options
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  options: FetchableLoaderOptions,
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Implementation - client stub that just returns the loader definition
// The $$id parameter is injected by Vite plugin, not user-provided
//
// NOTE: For export-only loader files, the Vite plugin replaces the entire
// file with object literals (bypassing this function). This function only
// runs when loaders are in mixed files (not export-only).
export function createLoader<T>(
  _fn: LoaderFn<T, Record<string, string | undefined>, any>,
  _fetchable?: true | FetchableLoaderOptions,
  __injectedId?: string,
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>> {
  const loaderId = __injectedId || "";

  if (!loaderId && process.env.NODE_ENV === "development") {
    throw new Error(
      "[rsc-router] Loader is missing $$id. " +
        "Make sure the exposeInternalIds Vite plugin is enabled and " +
        "the loader is exported with: export const MyLoader = createLoader(...)",
    );
  }

  return {
    __brand: "loader",
    $$id: loaderId,
  };
}
