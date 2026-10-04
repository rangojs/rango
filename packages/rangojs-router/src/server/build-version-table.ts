/// <reference path="../vite/plugins/version.d.ts" />
/**
 * Runtime side of the per-router cache versions: binds the
 * `@rangojs/router:version` virtual module and answers "which versions does
 * this router, or this request, use".
 *
 * Design: docs/design/per-app-cache-version.md.
 */
import { ROUTER_VERSIONS, VERSION } from "@rangojs/router:version";
import {
  resolveVersionsFrom,
  uniformVersions,
  type RouterVersions,
  type RouterVersionsTable,
} from "../router-versions.js";
import { _getRequestContext } from "./request-context.js";

/**
 * The build's table. Module state only so the testing primitive
 * (testing/build-versions.ts) can install one where the build's is absent;
 * production never reassigns it.
 */
let table: RouterVersionsTable | undefined = ROUTER_VERSIONS;

/**
 * The versions a router serves with, in order:
 *
 * 1. `override`, a consumer-set `version` (createRouter or createRSCHandler):
 *    that exact value for both.
 * 2. The router's entry in the build table, else the whole-build entry.
 * 3. `VERSION` for both: the dev stamp, bumped on every RSC module edit.
 */
export function resolveRouterVersions(
  routerId: string | undefined,
  override?: string,
): RouterVersions {
  return (
    resolveVersionsFrom(table, routerId, override) ?? uniformVersions(VERSION)
  );
}

/**
 * The version an on-demand prerender overlay key carries: the router's data
 * version, because the overlay stores segment data, as the segment cache does
 * (a client-only deploy keeps both). The write side (`router.prerender`,
 * router.ts) and the read side (rsc/handler.ts) both call this with
 * `createRouter({ version })`, the only override the trigger can see, so they
 * cannot disagree; a `createRSCHandler({ version })` does not move it.
 */
export function resolvePrerenderVersion(
  routerId: string | undefined,
  routerVersion: string | undefined,
): string {
  return resolveRouterVersions(routerId, routerVersion).data;
}

/** The table gives some router a pair of its own. */
function hasRouterVersions(): boolean {
  if (!table) return false;
  const pairs = new Set(
    Object.values(table).map(([data, document]) => `${data}\0${document}`),
  );
  return pairs.size > 1;
}

let warnedOutsideRequest = false;

/**
 * The versions of the router serving the current request, for a cache store
 * building a key. A store operation with no request context (a detached task
 * that lost the ALS) gets the whole-build versions: it misses the request's
 * entries instead of reading another version's. When routers have versions of
 * their own that is a write no router reads back, so it is logged, once per
 * process: `ctx.waitUntil()` re-enters the request context for every task it
 * runs (server/request-context.ts), and this line in a production log means
 * some other path lost it.
 *
 * Public from `@rangojs/router/cache`, for a custom persistent store to key
 * the way the built-in ones do. Prefix cached RSC data (segment entries, items) with
 * `data` and stored HTML or responses (shells, document responses) with
 * `document`, and leave tag-invalidation records unversioned; an empty string
 * means "no version" (tests). Call it per operation, inside the request, not
 * in the store's constructor: the cache factory runs before the request
 * context exists.
 */
export function getCacheVersions(): RouterVersions {
  const versions = _getRequestContext()?._versions;
  if (versions) return versions;
  if (!warnedOutsideRequest && hasRouterVersions()) {
    warnedOutsideRequest = true;
    console.warn(
      "[rango] A cache key was built outside a request, so it carries the whole-build cache " +
        "version instead of a router's. This build has per-router versions: an entry written " +
        "under that key is not read by a router with its own version, and an entry that router " +
        "wrote is not found from here. A store operation ran in a task that lost the request's " +
        "async context. Logged once per process.",
    );
  }
  return resolveRouterVersions(undefined);
}

/** Which of the serving router's versions a store key carries; `null`: none. */
export type KeyVersion = keyof RouterVersions | null;

/**
 * The `v/{version}/` prefix of a persistent store key, or "" for an
 * unversioned one. A store-level `version` is used for every versioned kind;
 * otherwise the version is the serving router's, read per operation because
 * the cache factory builds the store before the request context exists.
 */
export function versionKeyPrefix(
  storeVersion: string | undefined,
  kind: KeyVersion,
): string {
  if (kind === null) return "";
  const version = storeVersion ?? getCacheVersions()[kind];
  return version ? `v/${version}/` : "";
}

/**
 * @internal Install a table, or restore the build's with `undefined`. A
 * request handler resolves its router's versions once, when it is created, so
 * a test that swaps the table (a "deploy") needs new handlers.
 */
export function installRouterVersionsTable(
  next: RouterVersionsTable | undefined,
): void {
  table = next ?? ROUTER_VERSIONS;
  warnedOutsideRequest = false;
}
