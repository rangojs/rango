/**
 * Build-time shell manifest key, `{routerId}@{pathname}` — the ONE derivation
 * shared by the producer (vite/discovery/shell-prerender-phase.ts, staging)
 * and the consumer (rsc/shell-build-manifest.ts, runtime lookup) so the two
 * sides of the join cannot drift. The capturing router's id on one side, the
 * serving router's on the other (cache-key-utils.ts, the router rule).
 * Host-free: the build knows no request host. A manifest namespace, never a
 * store keyspace (that is buildShellKey).
 */
import { routerKeyPrefix } from "../cache/cache-key-utils.js";

export function buildShellManifestKey(
  routerId: string,
  pathname: string,
): string {
  return `${routerKeyPrefix(routerId)}${pathname}`;
}
