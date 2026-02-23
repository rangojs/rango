/**
 * rsc-router/loader (RSC/server version)
 *
 * Server-side createLoader implementation with full loader functionality.
 * Only used in react-server context via export conditions.
 *
 * For non-fetchable loaders: returns a loader definition with fn included
 * For fetchable loaders: stores fn in registry and returns a serializable loader with action
 *
 * The $$id is injected by the Vite exposeInternalIds plugin as a hidden parameter.
 * Users don't need to pass any name - IDs are auto-generated from file path.
 */

import type {
  FetchableLoaderOptions,
  LoaderDefinition,
  LoaderFn,
} from "./types.js";
import type { MiddlewareFn } from "./router/middleware.js";
import {
  registerFetchableLoader,
  getFetchableLoader,
} from "./server/fetchable-loader-store.js";
import { executeLoaderAction } from "./loader-action-shared.js";

export { getFetchableLoader };

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

// Implementation - the $$id parameter is injected by Vite plugin, not user-provided
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable?: true | FetchableLoaderOptions,
  // Hidden parameter injected by Vite exposeInternalIds plugin
  __injectedId?: string
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>> {
  // The $$id will be set on the returned object by Vite plugin
  // For fetchable loaders, __injectedId is also passed as a parameter
  const loaderId = __injectedId || "";

  // If not fetchable, store fn in registry and return a plain object.
  // Server-side code looks up fn via getFetchableLoader($$id).
  if (fetchable === undefined) {
    if (fn && loaderId) {
      registerFetchableLoader(loaderId, fn, []);
    }
    return {
      __brand: "loader",
      $$id: loaderId,
    };
  }

  // Fetchable loader - store fn in registry and return a serializable object
  const middleware: MiddlewareFn[] =
    fetchable === true ? [] : fetchable?.middleware || [];

  // Register the function in the internal registry by $$id (server-side only)
  // The server action will look it up by $$id when executed
  if (fn && loaderId) {
    registerFetchableLoader(loaderId, fn, middleware);
  }

  // Create server action for form-based fetching.
  // Signature must be (prevState, formData) for useActionState compatibility.
  // Delegates to shared executeLoaderAction for the actual execution.
  async function loaderAction(
    _prevState: Awaited<T> | null,
    formData: FormData,
  ): Promise<Awaited<T>> {
    "use server";
    return executeLoaderAction(loaderId, formData) as Promise<Awaited<T>>;
  }

  // Return a plain object with action for form-based fetching.
  // loaderAction has "use server" so RSC Flight serializes it natively as a server action reference.
  return {
    __brand: "loader",
    $$id: loaderId,
    action: loaderAction,
  };
}
