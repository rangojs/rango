/**
 * rsc-router/client-loader (RSC/server version)
 *
 * Server-side createClientLoader stub. Returns a definition with only the $$id.
 * The client function is not included since it can only run in the browser.
 *
 * The $$id is injected by the Vite exposeInternalIds plugin.
 */

import type { ClientLoaderDefinition, ClientLoaderFn } from "./types.js";

export function createClientLoader<T>(
  _fn: ClientLoaderFn<T>,
  __injectedId?: string,
): ClientLoaderDefinition<Awaited<T>> {
  return {
    __brand: "clientLoader",
    $$id: __injectedId || "",
  };
}
