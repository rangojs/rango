/**
 * rsc-router/service (RSC/server version)
 *
 * Server-side createService stub. Returns a definition with the server fn
 * preserved (for ctx.use() in handlers) and the client fn stripped.
 *
 * The $$id is injected by the Vite exposeInternalIds plugin.
 */

import type {
  ServiceDefinition,
  ServiceServerFn,
  ServiceClientFn,
} from "./types.js";

export function createService<TInit, TInstance>(
  serverFnOrClientFn: ServiceServerFn<TInit, any, any> | (() => TInstance),
  clientFn?: ServiceClientFn<TInit, TInstance>,
  __injectedId?: string,
): ServiceDefinition<TInit, TInstance> {
  // Two-arg form: first arg is server fn
  // One-arg form: no server fn (client-only)
  const hasServerFn = !!clientFn;
  return {
    __brand: "service",
    $$id: __injectedId || "",
    serverFn: hasServerFn
      ? (serverFnOrClientFn as ServiceServerFn<TInit, any, any>)
      : undefined,
  };
}
