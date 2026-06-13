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
import { isUnderTestRunner } from "./runtime-env.js";

export { getFetchableLoader };

// Runtime-fallback counter for bare unit tests (no Vite plugin); process-stable.
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
  let loaderId = __injectedId || "";

  // Under test runner, fall back to synthetic id (recovers fn from registry by $$id).
  // Otherwise (dev or prod), missing id means unsupported shape — fail loud.
  if (!loaderId) {
    if (isUnderTestRunner()) {
      loaderId = `__rango_runtime_loader_${runtimeLoaderIdCounter++}`;
    } else if (process.env.NODE_ENV !== "production") {
      throw missingInjectedIdError("Loader", "createLoader");
    } else {
      throw new Error(
        "[rango] Loader is missing $$id — the build plugin did not inject one. " +
          "Export it as `export const X = createLoader(...)`.",
      );
    }
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

  // Fetchable loader - store fn in registry and return a serializable object.
  const middleware: MiddlewareFn[] =
    fetchable === true ? [] : fetchable?.middleware || [];
  if (fn && loaderId) {
    registerFetchableLoader(loaderId, fn, middleware, true);
  }

  return {
    __brand: "loader",
    $$id: loaderId,
  };
}
