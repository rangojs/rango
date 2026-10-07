/**
 * Build-time shell manifest key — the ONE derivation shared by the producer
 * (vite/discovery/shell-prerender-phase.ts, staging) and the consumer
 * (rsc/shell-build-manifest.ts, runtime lookup) so the two sides of the join
 * cannot drift. The producer runs node-side in the plugin, the consumer in
 * the RSC runtime.
 *
 * ROUTER ID + PATHNAME. Host-free because the build knows no request host.
 * The id is the capturing router's on the producer side and the serving
 * router's on the consumer side, so a router reads only a shell it captured
 * (#1065): keyed by pathname alone, a router with a `ppr` route on a pathname
 * another router prerendered served that router's shell whenever their
 * versions matched. The two sides compute the same id (routerKeyPrefix); the
 * route manifest and the cache versions this phase stamps are keyed by it
 * too.
 *
 * This is a manifest namespace, never a store keyspace: the runtime shell key
 * is buildShellKey (rsc/shell-capture-constants.ts).
 */
import { routerKeyPrefix } from "../cache/cache-key-utils.js";

export function buildShellManifestKey(
  routerId: string,
  pathname: string,
): string {
  return `${routerKeyPrefix(routerId)}${pathname}`;
}
