/**
 * rsc-router/loader (RSC/server version)
 *
 * Server-side createLoader implementation with full loader functionality.
 * Only used in react-server context via export conditions.
 *
 * For non-fetchable loaders: returns a loader definition with fn included
 * For fetchable loaders: stores fn in registry and returns a serializable loader
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
import { missingInjectedIdError } from "./missing-id-error.js";

export { getFetchableLoader };

// Counter for runtime-fallback loader ids assigned only in a bare unit test
// (no Vite plugin to inject one). Process-stable; never reached in a real build.
let runtimeLoaderIdCounter = 0;

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

// Implementation - the $$id parameter is injected by Vite plugin, not user-provided
export function createLoader<T>(
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable?: true | FetchableLoaderOptions,
  // Hidden parameter injected by Vite exposeInternalIds plugin
  __injectedId?: string,
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>> {
  // The $$id will be set on the returned object by Vite plugin
  // For fetchable loaders, __injectedId is also passed as a parameter
  let loaderId = __injectedId || "";

  // Throw unless under a test runner. The plugin always injects $$id for a
  // supported `export const` loader on both builds, so a missing id means either
  // no plugin (a bare test — fall back below) or an UNSUPPORTED shape (e.g. a
  // namespace import `rango.createLoader(...)`) the plugin skipped (dev OR a real
  // build — fail loud, never mask it). `process.env.VITEST` is the only signal
  // true in both vitest projects yet absent in a real build.
  if (!loaderId && !process.env.VITEST) {
    throw missingInjectedIdError("Loader", "createLoader");
  }

  // Under vitest with no plugin id: assign a process-stable runtime id so the fn
  // registers below and the loader is exercisable via runLoader(loaderHandle) (it
  // recovers the fn from the registry by $$id). Never reached in a real build —
  // the throw above fires there. Mirrors createHandle.
  if (!loaderId) {
    loaderId = `__rango_runtime_loader_${runtimeLoaderIdCounter++}`;
  }

  // If not fetchable, store fn in registry (for SSR ctx.use() resolution)
  // but mark fetchable=false so the _rsc_loader endpoint rejects it.
  if (fetchable === undefined) {
    if (fn && loaderId) {
      registerFetchableLoader(loaderId, fn, [], false);
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
  // The loader fetch handler looks it up by $$id when load() is called from the client.
  if (fn && loaderId) {
    registerFetchableLoader(loaderId, fn, middleware, true);
  }

  return {
    __brand: "loader",
    $$id: loaderId,
  };
}
