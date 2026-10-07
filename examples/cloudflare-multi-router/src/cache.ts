import type { ExecutionContext } from "@rangojs/router";
import { CFCacheStore } from "@rangojs/router/cache";
import type { AppBindings } from "./env.js";

/**
 * The cache every sub-app that opts in shares: one Cache API namespace for the
 * whole worker. Pass it as `createRouter({ cache: appCache })`.
 *
 * Sharing is safe without a per-app prefix: every cache key that holds one
 * router's output starts with that router's id, so two apps answering under
 * the same host and path (the host-override cookie in worker.rsc.tsx) keep
 * their own shells and records.
 */
export function appCache(
  _env: AppBindings,
  ctx?: ExecutionContext,
): { store: CFCacheStore } {
  return {
    store: new CFCacheStore({ defaults: { ttl: 60, swr: 300 }, ctx: ctx! }),
  };
}
