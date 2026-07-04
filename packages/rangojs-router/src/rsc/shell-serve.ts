/**
 * Integrated PPR shell serving (Axis 2, see docs/design/ppr-shell-resume.md).
 *
 * PPR is opt-in per PAGE ROUTE via the `ppr` path option
 * (`path(pattern, Handler, { name, ppr: true | PartialPrerenderProps })`) and the
 * serving logic is INTEGRAL to the render pipeline — there is no middleware to
 * mount. This module owns the config/key/store plumbing the render layer
 * (rsc-rendering.ts) uses at its COMMIT POINT, which sits after the WHOLE
 * middleware chain (global `router.use()` chain AND route DSL `middleware()`,
 * both of which wrap the render pass): any middleware rejection/redirect wins
 * before a single shell byte is written.
 *
 * The shell store is the app-level `createRouter({ cache })` store
 * (`requestCtx._cacheStore`). A store without the `getShell`/`putShell` family
 * degrades a ppr route to axis 1 with a once-per-key warning (the declared
 * intent cannot be honored — unlike an undeclared route, which is silent).
 */

import React from "react";
import type { EntryData } from "../server/context.js";
import { sortedSearchString } from "../cache/cache-key-utils.js";
import type { ShellCacheEntry, SegmentCacheStore } from "../cache/types.js";

/** Debug/status header the browser (and e2e assertions) can read: HIT | MISS. */
export const SHELL_STATUS_HEADER = "x-rango-shell";

/**
 * Default shell ttl (seconds) for `ppr: true` and for a PartialPrerenderProps
 * that omits `ttl`.
 */
export const DEFAULT_PPR_TTL_SECONDS = 300;

/** The route's ppr option normalized to a concrete policy. */
export interface ResolvedPprConfig {
  ttl: number;
  swr?: number;
  tags?: string[];
}

/**
 * Normalize the matched page route's `ppr` path option. Returns null when the
 * route does not declare `ppr` (or declares `ppr: false`) — the caller then does
 * NOTHING: no store read, no capture, no logs. Pure axis 1, zero cost.
 *
 * PPR is a DOCUMENT-level property of the page route; there is no subtree
 * inheritance (declaring it on a layout is not supported — a follow-up).
 */
export function resolvePprConfig(
  entry: EntryData | undefined | null,
): ResolvedPprConfig | null {
  if (!entry || entry.type !== "route") return null;
  const ppr = entry.ppr;
  if (ppr === undefined || ppr === false) return null;
  if (ppr === true) return { ttl: DEFAULT_PPR_TTL_SECONDS };
  return {
    ttl: ppr.ttl ?? DEFAULT_PPR_TTL_SECONDS,
    swr: ppr.swr,
    tags: ppr.tags,
  };
}

/**
 * Shell cache key: host + pathname + sorted search + a `:shell` namespace suffix
 * (so it can never collide with a document-cache key; the store further isolates
 * the shell family internally).
 *
 * The key includes the request HOST: in a multi-tenant host-router deployment
 * (one worker, one shared KV/runtime-cache store) a host-less key would serve
 * tenant A's captured shell to tenant B's users.
 */
export function buildShellKey(url: URL): string {
  const sorted = sortedSearchString(url.searchParams);
  const searchSuffix = sorted ? `?${sorted}` : "";
  return `${url.host}${url.pathname}${searchSuffix}:shell`;
}

/**
 * React version captured at prerender time is the invalidation gate: a stored
 * shell whose reactVersion differs from the running React cannot be resumed (the
 * postponed blob is build-coupled), so it is treated as a miss — the recapture
 * overwrites the same key and the entry otherwise ages out via TTL.
 */
export function isValidShellHit(entry: ShellCacheEntry): boolean {
  return entry.reactVersion === React.version;
}

/** Decode a base64 prelude back into bytes for stream composition. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** True when the store implements the shell entry family. */
export function hasShellFamily(
  store: SegmentCacheStore | undefined,
): store is SegmentCacheStore & {
  getShell: NonNullable<SegmentCacheStore["getShell"]>;
  putShell: NonNullable<SegmentCacheStore["putShell"]>;
} {
  return !!store?.getShell && !!store?.putShell;
}

/** Keys already warned about a missing shell store family (once per key). */
const warnedMissingStore = new Set<string>();

/**
 * Warn once per key that a route declared `ppr` but the app-level cache store
 * does not implement the shell family (getShell/putShell), so the route stays on
 * axis 1. Unlike an undeclared route (silent), a declared route that cannot be
 * honored deserves a diagnostic.
 */
export function warnShellStoreMissingOnce(key: string): void {
  if (warnedMissingStore.has(key)) return;
  warnedMissingStore.add(key);
  console.warn(
    `[rango] Route for "${key}" declares the ppr path option, but the app-level ` +
      "cache store does not implement the shell family (getShell/putShell), so " +
      "the route is served on axis 1 without a shell. Use MemorySegmentCacheStore, " +
      "CFCacheStore, or VercelCacheStore (or add the family to your custom store) " +
      "via createRouter({ cache }).",
  );
}

/** Keys already warned about an active per-request nonce (once per key). */
const warnedNonceActive = new Set<string>();

/**
 * Warn once per key that a route declared `ppr` but a per-request CSP nonce is
 * active for the request, so the route stays on axis 1 (a shared shell would
 * freeze one request's nonce for every visitor — useNonce() renders it into every
 * nonced script/style/meta and the browser's CSP would then reject the frozen
 * nonce for all but the capture request). The nonce blocks capture whether it came
 * from the `createRouter({ nonce })` provider or from a direct `ctx.set(nonce, …)`
 * token write in middleware. Same declared-intent-cannot-be-honored doctrine as
 * the missing-store warning above (an undeclared route stays silent).
 */
export function warnPprNonceActiveOnce(key: string): void {
  if (warnedNonceActive.has(key)) return;
  warnedNonceActive.add(key);
  console.warn(
    `[rango] Route for "${key}" declares the ppr path option, but a per-request ` +
      "CSP nonce is active for this request (from createRouter({ nonce }) or a " +
      "ctx.set(nonce, …) token write in middleware), so the route is served on " +
      "axis 1 without a shell. A shell is shared per host+URL; baking one " +
      "request's nonce into it would break CSP for every other visitor. Drop the " +
      "ppr option on this route, or stop setting a per-request nonce for it.",
  );
}
