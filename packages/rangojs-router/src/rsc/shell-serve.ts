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
import { isPprEntry, type EntryData } from "../server/context.js";
import { sortedSearchString } from "../cache/cache-key-utils.js";
import type { ShellCacheEntry, SegmentCacheStore } from "../cache/types.js";

/** Debug/status header the browser (and e2e assertions) can read: HIT | MISS. */
export const SHELL_STATUS_HEADER = "x-rango-shell";

/** Partial-navigation status header set only after captured PPR segments are consumed. */
export const PPR_REPLAY_STATUS_HEADER = "x-rango-ppr-replay";

/**
 * Default shell ttl (seconds) for `ppr: true` and for a PartialPrerenderProps
 * that omits `ttl`.
 */
export const DEFAULT_PPR_TTL_SECONDS = 300;

/**
 * Timeout for the dev /__rsc_shell endpoint's sequential /__rsc_prerender
 * pre-flight probe (vite/router-discovery.ts). Hoisted here so the client-side
 * fetch bound (shell-build-manifest.ts devShellFetchTimeoutMs) enumerates the
 * SAME term of the endpoint's worst-case envelope — the two cannot drift.
 */
export const DEV_SHELL_PROBE_TIMEOUT_MS: number = 10_000;

/** The route's ppr option normalized to a concrete policy. */
export interface ResolvedPprConfig {
  ttl: number;
  swr?: number;
  tags?: string[];
  /**
   * Snapshot size cap, passed through undefaulted (like swr/tags): the single
   * defaulting site is captureAndStoreShell (DEFAULT_PPR_MAX_SNAPSHOT_BYTES in
   * shell-capture.ts), so direct descriptor callers and resolved configs
   * cannot drift.
   */
  maxSnapshotBytes?: number;
  /**
   * Capture settle budget in ms (`ppr.captureTimeout`). Undefined = the
   * capture default (SHELL_CAPTURE_MAX_WAIT_MS, 15_000) — the default's single
   * owner stays shell-capture.ts so build/runtime producers cannot drift.
   */
  captureTimeout?: number;
}

/**
 * Validate the raw `ppr.captureTimeout` option: a finite number >= 1ms passes
 * through; anything else (including 0/negative/NaN/Infinity/non-number)
 * resolves to undefined, which means "use the capture default" downstream.
 * Mirrors the prefetch-limit option policy: invalid values silently fall back
 * to the default rather than throwing at request time. Also the boundary
 * re-normalizer for the dev /__rsc_shell endpoint (vite/router-discovery.ts),
 * whose param crossed an HTTP query string.
 */
export function normalizeCaptureTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? value
    : undefined;
}

/**
 * Normalize the matched page route's `ppr` path option. Returns null when the
 * route does not declare `ppr` (or declares `ppr: false`) — the caller then does
 * NOTHING: no store read, no capture, no logs. Pure axis 1, zero cost.
 *
 * The route's NAME is irrelevant here (and everywhere on the shell lane):
 * nameless `path()` routes register their EntryData under a synthesized
 * `$path_*` manifest key with the `ppr` option intact (urls/path-helper.ts),
 * so a nameless entry resolves exactly like a named one — pinned by the
 * nameless-ppr e2e in both apps (issue #714).
 *
 * PPR is a DOCUMENT-level property of the page route; there is no subtree
 * inheritance (declaring it on a layout is not supported — a follow-up).
 */
export function resolvePprConfig(
  entry: EntryData | undefined | null,
): ResolvedPprConfig | null {
  // isPprEntry (server/context.ts) is the ONE opt-in predicate — shared with
  // the header-write latch so serve and guard can never drift.
  if (!entry || !isPprEntry(entry)) return null;
  const ppr = entry.ppr;
  if (ppr === true) return { ttl: DEFAULT_PPR_TTL_SECONDS };
  return {
    ttl: ppr.ttl ?? DEFAULT_PPR_TTL_SECONDS,
    swr: ppr.swr,
    tags: ppr.tags,
    maxSnapshotBytes: ppr.maxSnapshotBytes,
    captureTimeout: normalizeCaptureTimeout(ppr.captureTimeout),
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
 * Version gates for a stored shell: reactVersion AND buildVersion must both
 * match the running server. The postponed blob encodes hole positions against
 * one exact tree, so resuming it under a different React OR a different app
 * build tree-mismatches inside resume() — after the 200 + prelude committed,
 * with no recovery. Either mismatch is a miss: the recapture overwrites the
 * same key (self-healing) and the entry otherwise ages out via TTL. An entry
 * with no buildVersion (stored before the field existed) is a miss for the
 * same reason — its build is unknown, so it cannot be proven resumable.
 */
export function isValidShellHit(
  entry: ShellCacheEntry,
  buildVersion: string,
): boolean {
  return (
    entry.reactVersion === React.version && entry.buildVersion === buildVersion
  );
}

/**
 * Payload integrity gate, run BEFORE the HIT response commits: a stored entry
 * whose prelude is not decodable base64 or whose postponed blob is not
 * parseable JSON would otherwise throw AFTER the 200 + full static prelude
 * flushed (`serveShellHit` decodes at stream construction, `resumeShellHTML`
 * parses in the tail) — the client gets a visually complete page that never
 * hydrates, re-served on every request until the entry ages out (no eviction
 * path exists; failure schedules no recapture by itself). Checking here turns
 * a corrupt entry (store-layer fault) into a plain MISS the recapture
 * overwrites. Cost: one duplicate decode/parse per HIT, sub-ms against a
 * prelude flush that dominates the path.
 */
export function hasIntactShellPayload(entry: ShellCacheEntry): boolean {
  try {
    base64ToBytes(entry.prelude);
    if (entry.postponed !== null) JSON.parse(entry.postponed);
    return true;
  } catch {
    return false;
  }
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

/**
 * Per-stage timing of one shell-HIT tail, all offsets in ms from the response
 * commit (prelude flush). The HIT commits its 200 + headers BEFORE the live
 * tail runs, so Server-Timing on the HIT response structurally cannot carry
 * these numbers — they ride the dev mirror below instead (same doctrine as
 * the ppr:capture mirror in rsc-rendering.ts, issue #651).
 */
export interface ShellTailTiming {
  key: string;
  outcome: "complete" | "redirect" | "error";
  /** Loader-family seed decode (only when the entry carried a snapshot). */
  seedMs?: number;
  /** Tail router.match() settled. */
  matchMs?: number;
  /** Tail stream (resume output) handed to the response stream. */
  handoverMs?: number;
  /** First resumed-HTML byte enqueued on the wire. */
  firstHtmlMs?: number;
  /** Tail fully drained (last hole settled and flushed). */
  completeMs?: number;
  /** Prelude size flushed at commit (decoded bytes). */
  preludeBytes?: number;
  /** Total tail bytes streamed behind the prelude. */
  tailBytes?: number;
}

/**
 * Compact single-line form for the console log and the dev Server-Timing
 * mirror's `desc`. Plain alphanumerics/`=`/`-` only — no quoted-string
 * escaping needed.
 */
export function describeShellTailTiming(timing: ShellTailTiming): string {
  const parts: string[] = [timing.outcome];
  if (timing.seedMs !== undefined) parts.push(`seed=${timing.seedMs}ms`);
  if (timing.matchMs !== undefined) parts.push(`match=${timing.matchMs}ms`);
  if (timing.handoverMs !== undefined) {
    parts.push(`handover=${timing.handoverMs}ms`);
  }
  if (timing.firstHtmlMs !== undefined) {
    parts.push(`first-html=${timing.firstHtmlMs}ms`);
  }
  if (timing.completeMs !== undefined) {
    parts.push(`complete=${timing.completeMs}ms`);
  }
  if (timing.preludeBytes !== undefined) {
    parts.push(`prelude=${timing.preludeBytes}b`);
  }
  if (timing.tailBytes !== undefined) parts.push(`tail=${timing.tailBytes}b`);
  return parts.join(" ");
}

/**
 * Dev-only last-tail-per-key buffer backing the `ppr:tail` Server-Timing
 * mirror: a HIT's tail finishes after its own headers are long gone, so its
 * per-stage numbers ride the NEXT ppr GET for the key when the metrics
 * surface is active (debugPerformance). Same shape and FIFO cap as the
 * capture mirror (shell-capture.ts lastCaptureEventsForTiming); dev-only so
 * production isolates never grow the map.
 */
const lastTailTimingsForServerTiming = new Map<string, ShellTailTiming>();
const MAX_TAIL_TIMING_KEYS = 100;

/** Buffer one terminal tail timing for the dev Server-Timing mirror. */
export function publishShellTailTiming(timing: ShellTailTiming): void {
  if (process.env.NODE_ENV === "production") return;
  lastTailTimingsForServerTiming.delete(timing.key);
  if (lastTailTimingsForServerTiming.size >= MAX_TAIL_TIMING_KEYS) {
    const oldest = lastTailTimingsForServerTiming.keys().next().value;
    if (oldest !== undefined) lastTailTimingsForServerTiming.delete(oldest);
  }
  lastTailTimingsForServerTiming.set(timing.key, timing);
}

/**
 * Consume (read-and-clear) the buffered tail timing for `key`, so one tail
 * reports into exactly one later response's Server-Timing.
 */
export function takeShellTailTimingForServerTiming(
  key: string,
): ShellTailTiming | undefined {
  const timing = lastTailTimingsForServerTiming.get(key);
  if (timing) lastTailTimingsForServerTiming.delete(key);
  return timing;
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
