/**
 * Testing primitive for the per-router cache versions.
 *
 * A production build gives every `createRouter()` a data version and a
 * document version (docs/design/per-app-cache-version.md) and ships them as a
 * table in the `@rangojs/router:version` module. A test has no build, so the
 * module is a stub and every router serves unversioned. `setBuildVersions`
 * installs a table in its place; the request handler, `dispatch` and the cache
 * stores then resolve versions through the same code path the built app uses.
 * Calling it again is a deploy: the next request is served by a handler that
 * resolved the new versions.
 */
import { installRouterVersionsTable } from "../server/build-version-table.js";
import {
  DEFAULT_ROUTER_VERSIONS_KEY,
  type RouterVersions,
  type RouterVersionsTable,
} from "../router-versions.js";

export type { RouterVersions };

/**
 * The versions a simulated build ships.
 *
 * - `data` and `document`: the versions of every router the test does not list
 *   under `routers` (the build's whole-build pair).
 * - `routers`: versions per router id (`router.id`), as a host-router build
 *   computes them.
 */
export interface BuildVersions extends RouterVersions {
  routers?: Record<string, RouterVersions>;
}

/**
 * Install the cache versions of a simulated build, or remove them with no
 * argument (routers serve unversioned again, the default in tests).
 *
 * A router that sets `createRouter({ version })` keeps that value for both
 * versions, exactly as in production.
 *
 * @example A deploy that changes the client only keeps cached data
 * ```ts
 * setBuildVersions({ data: "d1", document: "h1" });
 * await serveShellRequest(router, "/product/1", { cacheStore });
 * setBuildVersions({ data: "d1", document: "h2" });
 * const { shellStatus } = await serveShellRequest(router, "/product/1", {
 *   cacheStore,
 * });
 * // shellStatus is "MISS": the stored HTML was keyed by document version h1.
 * ```
 */
export function setBuildVersions(versions?: BuildVersions): void {
  if (!versions) {
    installRouterVersionsTable(undefined);
    return;
  }
  const table: Record<string, readonly [string, string]> = {
    [DEFAULT_ROUTER_VERSIONS_KEY]: [versions.data, versions.document],
  };
  for (const [routerId, pair] of Object.entries(versions.routers ?? {})) {
    table[routerId] = [pair.data, pair.document];
  }
  installRouterVersionsTable(table satisfies RouterVersionsTable);
}
