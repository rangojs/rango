/**
 * Per-router cache versions: the shapes shared by the build (which computes
 * them, vite/discovery/build-versions.ts) and the runtime (which reads them,
 * server/build-version-table.ts). No imports, so the Vite plugin bundle can
 * use it without resolving the `@rangojs/router:version` virtual module.
 *
 * Design: docs/design/per-app-cache-version.md.
 */

/**
 * The two versions one `createRouter()` serves with.
 *
 * - `data` keys cached RSC data: segment entries, `"use cache"` values and
 *   loader data. It follows the router's server code only.
 * - `document` keys stored HTML (PPR shells, document-cache responses), is the
 *   value the browser echoes as `_rsc_v`, and stamps `ShellCacheEntry.buildVersion`.
 *   It follows the server code and the client asset URLs.
 */
export interface RouterVersions {
  readonly data: string;
  readonly document: string;
}

/**
 * The build's table as the `@rangojs/router:version` module exports it:
 * router id to `[data, document]`. {@link DEFAULT_ROUTER_VERSIONS_KEY} holds
 * the whole-build pair, used for a router the build could not attribute.
 */
export type RouterVersionsTable = Readonly<
  Record<string, readonly [data: string, document: string]>
>;

/** Table key of the whole-build versions. Not a legal `$$id` (8 hex chars). */
export const DEFAULT_ROUTER_VERSIONS_KEY = "*";

/** One value for both versions: a consumer-set `version`, or the dev stamp. */
export function uniformVersions(version: string): RouterVersions {
  return { data: version, document: version };
}

/**
 * The versions a router serves with under `table`: a consumer-set `version`
 * for both; else the router's own entry; else the whole-build pair, for a
 * router the table does not list. `undefined` when there is no table (dev,
 * tests) or it has neither entry. One function for the request handler and
 * the build's shell capture, which must stamp what the handler will check.
 */
export function resolveVersionsFrom(
  table: RouterVersionsTable | undefined,
  routerId: string | undefined,
  override: string | undefined,
): RouterVersions | undefined {
  if (override !== undefined) return uniformVersions(override);
  if (!table) return undefined;
  const pair =
    (routerId !== undefined && Object.hasOwn(table, routerId)
      ? table[routerId]
      : undefined) ?? table[DEFAULT_ROUTER_VERSIONS_KEY];
  return pair ? { data: pair[0], document: pair[1] } : undefined;
}
