/**
 * rsc-router/loader (client version)
 *
 * Client-only stub for createLoader. Returns a minimal loader definition
 * that can be passed to hooks like useLoader. The actual loader function
 * is not included - it only exists on the server.
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
  fn: LoaderFn<T, Record<string, string | undefined>, any>
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 2: Fetchable with `true` (no middleware)
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable: true
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 3: Fetchable with middleware options
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  options: FetchableLoaderOptions
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Implementation - client stub that just returns the loader definition
// The $$id parameter is injected by Vite plugin, not user-provided
export function createLoader<T>(
  _fn: LoaderFn<T, Record<string, string | undefined>, any>,
  _fetchable?: true | FetchableLoaderOptions,
  __injectedId?: string
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>> {
  // Client only needs the $$id for identification
  // The actual loader function is only used on the server
  return {
    __brand: "loader",
    $$id: __injectedId || "",
  };
}
