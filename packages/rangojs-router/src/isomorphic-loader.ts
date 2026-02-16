/**
 * rsc-router/isomorphic-loader (client version)
 *
 * Client-side createIsomorphicLoader. Preserves the client function and
 * registers it in the browser-side client loader registry. The server function
 * is stripped (not included in the client bundle).
 *
 * The $$id is injected by the Vite exposeInternalIds plugin.
 */

import type {
  IsomorphicLoaderDefinition,
  LoaderFn,
  ClientLoaderFn,
} from "./types.js";
import { registerClientLoader } from "./browser/client-loader-registry.js";

export function createIsomorphicLoader<T>(
  _serverFn: LoaderFn<T, Record<string, string | undefined>, any>,
  clientFn: ClientLoaderFn<T>,
  __injectedId?: string,
): IsomorphicLoaderDefinition<Awaited<T>> {
  const id = __injectedId || "";
  if (id && clientFn) {
    registerClientLoader(id, clientFn as ClientLoaderFn<any>);
  }
  return {
    __brand: "isomorphicLoader",
    $$id: id,
    clientFn: clientFn as ClientLoaderFn<Awaited<T>>,
  };
}
