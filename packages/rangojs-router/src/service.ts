/**
 * rsc-router/service (client version)
 *
 * Client-side createService. Preserves the client function and registers
 * it in the browser-side service registry so it can initialize the service
 * instance during hydration.
 *
 * The $$id is injected by the Vite exposeInternalIds plugin.
 */

import type {
  ServiceDefinition,
  ServiceServerFn,
  ServiceClientFn,
} from "./types.js";
import { registerService } from "./browser/service-registry.js";

export function createService<TInit, TInstance>(
  serverFnOrClientFn: ServiceServerFn<TInit, any, any> | (() => TInstance),
  clientFn?: ServiceClientFn<TInit, TInstance>,
  __injectedId?: string,
): ServiceDefinition<TInit, TInstance> {
  const id = __injectedId || "";
  // One-arg form: clientFn only (no server fn)
  // Two-arg form: serverFn + clientFn
  const isClientOnly = !clientFn;
  const actualClientFn = isClientOnly
    ? (serverFnOrClientFn as unknown as ServiceClientFn<any, TInstance>)
    : clientFn;

  if (id && actualClientFn) {
    registerService(id, actualClientFn as ServiceClientFn<any, any>);
  }
  return {
    __brand: "service",
    $$id: id,
    clientFn: actualClientFn as ServiceClientFn<TInit, TInstance>,
  };
}
