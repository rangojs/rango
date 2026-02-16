/**
 * rsc-router/isomorphic-loader (RSC/server version)
 *
 * Server-side createIsomorphicLoader. Preserves the server function and
 * registers it in the fetchable loader store. The client function is stripped.
 *
 * The $$id is injected by the Vite exposeInternalIds plugin.
 */

import type {
  IsomorphicLoaderDefinition,
  LoaderFn,
  ClientLoaderFn,
} from "./types.js";
import { registerFetchableLoader } from "./server/fetchable-loader-store.js";

export function createIsomorphicLoader<T>(
  serverFn: LoaderFn<T, Record<string, string | undefined>, any>,
  _clientFn: ClientLoaderFn<T>,
  __injectedId?: string,
): IsomorphicLoaderDefinition<Awaited<T>> {
  const id = __injectedId || "";
  if (id && serverFn) {
    registerFetchableLoader(id, serverFn, []);
  }
  // Do not include fn on the returned object - it would fail RSC serialization
  // when passed as props to client components. The server fn is registered in
  // fetchable-loader-store and looked up by $$id during SSR resolution.
  return {
    __brand: "isomorphicLoader",
    $$id: id,
  };
}
