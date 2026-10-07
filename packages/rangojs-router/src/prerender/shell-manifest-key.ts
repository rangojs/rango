/**
 * Build-time shell manifest key, `{routerId}@{pathname}`: the ONE derivation
 * shared by the producer (vite/discovery/shell-prerender-phase.ts) and the
 * consumer (rsc/shell-build-manifest.ts) so the two sides cannot drift. The
 * router part follows the router rule (cache-key-utils.ts). Host-free (the
 * build knows no request host); a manifest namespace, never a store keyspace.
 */
import { routerKeyPrefix } from "../cache/cache-key-utils.js";

export function buildShellManifestKey(
  routerId: string,
  pathname: string,
): string {
  return `${routerKeyPrefix(routerId)}${pathname}`;
}
