/**
 * rsc-router/loader (browser environment)
 *
 * createLoader is only available in RSC context.
 * This file exists to satisfy bundler analysis during client builds.
 */

import type { LoaderDefinition, LoaderFn } from "./types.js";

// Overload 1: With function, infer return type
export function createLoader<T>(
  name: string,
  fn: LoaderFn<T, Record<string, string | undefined>, any>
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 2: No function (client-side reference only)
export function createLoader(
  name: string
): LoaderDefinition<any, Record<string, string | undefined>>;

// Implementation - throws at runtime in browser
export function createLoader(
  name: string,
  _fn?: LoaderFn<any, Record<string, string | undefined>, any>
): LoaderDefinition<any, Record<string, string | undefined>> {
  // Return a stub loader definition for bundling purposes
  // This should never be called at runtime in browser
  return {
    __brand: "loader",
    name,
  };
}
