/**
 * Browser-side service registry.
 *
 * Stores service client functions (from createService) and their
 * instantiated instances. Instances persist across SPA navigations
 * and are only cleared on full page reload (in-memory Map).
 *
 * Populated at module load time when service modules are imported.
 */

import type { ServiceClientFn } from "../types.js";

const serviceFns = new Map<string, ServiceClientFn<any, any>>();
const serviceInstances = new Map<string, any>();

export function registerService(
  id: string,
  fn: ServiceClientFn<any, any>,
): void {
  serviceFns.set(id, fn);
}

export function getServiceInstance(id: string): any | undefined {
  return serviceInstances.get(id);
}

/**
 * Initialize a service with init data from the server.
 * Returns cached instance if already initialized (persist across navigations).
 */
export function initializeService(id: string, initData: any): any {
  const existing = serviceInstances.get(id);
  if (existing !== undefined) return existing;

  const fn = serviceFns.get(id);
  if (!fn) {
    throw new Error(
      `Service "${id}" not registered. ` +
      `Ensure the service module is imported in the client bundle.`,
    );
  }

  const instance = fn(initData);
  serviceInstances.set(id, instance);
  return instance;
}

export function hasServiceInstance(id: string): boolean {
  return serviceInstances.has(id);
}
