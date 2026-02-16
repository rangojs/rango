/**
 * rsc-router/client-loader (client version)
 *
 * Client-side createClientLoader. Preserves the client function and registers
 * it in the browser-side client loader registry so it can be executed during
 * SPA navigation.
 *
 * The $$id is injected by the Vite exposeInternalIds plugin.
 */

import type { ClientLoaderDefinition, ClientLoaderFn } from "./types.js";
import { registerClientLoader } from "./browser/client-loader-registry.js";

export function createClientLoader<T>(
  fn: ClientLoaderFn<T>,
  __injectedId?: string,
): ClientLoaderDefinition<Awaited<T>> {
  const id = __injectedId || "";
  if (id && fn) {
    registerClientLoader(id, fn as ClientLoaderFn<any>);
  }
  return {
    __brand: "clientLoader",
    $$id: id,
    clientFn: fn as ClientLoaderFn<Awaited<T>>,
  };
}
