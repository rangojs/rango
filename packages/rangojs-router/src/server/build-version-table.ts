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

/** The whole-build pair, for {@link getCacheVersions} outside a request. */
let wholeBuild: RouterVersions | undefined;

/**
 * The versions of the router serving the current request, for a cache store
 * building a key. A store operation with no request context (a detached task
 * that lost the ALS) gets the whole-build versions: it misses the request's
 * entries instead of reading another version's.
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
  return (
    _getRequestContext()?._versions ??
    (wholeBuild ??= resolveRouterVersions(undefined))
  );
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

let generation = 0;

/**
 * @internal Install a table, or restore the build's with `undefined`. A
 * request handler resolves its router's versions once, when it is created, so
 * a test that swaps the table (a "deploy") needs new handlers:
 * {@link routerVersionsGeneration} tells a handler cache its entries are old.
 */
export function installRouterVersionsTable(
  next: RouterVersionsTable | undefined,
): void {
  table = next ?? ROUTER_VERSIONS;
  wholeBuild = undefined;
  generation++;
}

/** @internal Bumped by every installRouterVersionsTable call. */
export function routerVersionsGeneration(): number {
  return generation;
}
