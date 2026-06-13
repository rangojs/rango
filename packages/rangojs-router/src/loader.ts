/**
 * @rangojs/router/loader (client version)
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
import { missingInjectedIdError } from "./missing-id-error.js";
import { isUnderTestRunner } from "./runtime-env.js";

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

// Implementation - client stub ($$id injected by Vite plugin, not user-provided)
export function createLoader<T>(
  _fn: LoaderFn<T, Record<string, string | undefined>, any>,
  _fetchable?: true | FetchableLoaderOptions,
  __injectedId?: string,
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>> {
  const loaderId = __injectedId || "";

  // Under test runner, no id needed (loaderId stays ""; loader.rsc.ts provides fallback).
  // Otherwise, missing id means unsupported shape — fail loud to avoid wrong key.
  if (!loaderId && !isUnderTestRunner()) {
    if (process.env.NODE_ENV !== "production") {
      throw missingInjectedIdError("Loader", "createLoader");
    }
    throw new Error(
      "[rango] Loader is missing $$id — the build plugin did not inject one. " +
        "Export it as `export const X = createLoader(...)`.",
    );
  }

  return {
    __brand: "loader",
    $$id: loaderId,
  };
}
