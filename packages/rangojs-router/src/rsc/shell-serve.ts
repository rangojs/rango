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
import { base64ToBytes } from "../cache/cf/cf-base64.js";
import type {
  DocumentShellCacheEntry,
  ShellCacheEntry,
  ShellDocumentRead,
  ShellEntryHead,
  ShellReadStats,
  ShellSnapshotFailure,
  ShellSnapshotRecord,
  SegmentCacheStore,
} from "../cache/types.js";
import {
  SHELL_CAPTURE_MAX_WAIT_MS,
  hasWarnedOnce,
  resetShellWarningsForTests,
  warnOnce,
} from "./shell-capture-constants.js";

export {
  PPR_REPLAY_STATUS_HEADER,
  SHELL_STATUS_HEADER,
  buildShellKey,
  navigationShellKey,
  partitionShellKey,
  shellSearchSeed,
} from "./shell-capture-constants.js";

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
 * Validate the raw `ppr.captureTimeout` option: a finite number >= 1ms is
 * clamped to the default ceiling; anything else (including
 * 0/negative/NaN/Infinity/non-number) resolves to undefined, which means "use
 * the capture default" downstream.
 * Mirrors the prefetch-limit option policy: invalid values silently fall back
 * to the default rather than throwing at request time. Also the boundary
 * re-normalizer for the dev /__rsc_shell endpoint (vite/router-discovery.ts),
 * whose param crossed an HTTP query string.
 */
export function normalizeCaptureTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(value, SHELL_CAPTURE_MAX_WAIT_MS)
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
 * The forced-MISS query marker. A document HIT that cannot finish its tail
 * reloads the page with it (shellReloadScript); the serve gate renders a
 * request carrying it on axis 1, with no shell read and no capture, so the
 * reload can never be a HIT that degrades again. The handler drops it from
 * the request on entry (withoutShellMissMarker) and keeps only the flag
 * (RequestContext._shellForcedMiss), so nothing else sees it.
 */
export const SHELL_MISS_PARAM: string = "_rsc_shell";

/**
 * The request without the forced-MISS marker, or undefined when it carries
 * none. The handler calls it before anything reads the request: left in, the
 * marker reached `ctx.request.url`, `originalUrl`, middleware, and the SSR
 * search seed (so `useSearchParams` rendered it), and a `"use cache"` key
 * built from the request URL was never read again. GET and HEAD only: the
 * reload is a navigation, and a request with a body cannot be re-created
 * without re-streaming it. The substring test keeps the URL parse off every
 * other request.
 */
export function withoutShellMissMarker(request: Request): Request | undefined {
  if (!request.url.includes(SHELL_MISS_PARAM)) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  if (!url.searchParams.has(SHELL_MISS_PARAM)) return undefined;
  url.searchParams.delete(SHELL_MISS_PARAM);
  return new Request(url, request);
}

/**
 * The inline script a degraded document HIT ends with: reload once into a
 * forced MISS. The marker in the URL is the loop bound — a request carrying
 * it is never a HIT, so this script never runs on the reload, and if it ever
 * did (a server that ignores the marker) it would return without touching
 * the page. window.stop() runs only when it reloads: it keeps the half-sent
 * Flight stream from being closed by DOMContentLoaded, which would throw
 * React's "Connection closed" (#412) before the reload lands.
 */
export function shellReloadScript(): string {
  return inlineShellScript(
    "(function(){var u=new URL(location.href);" +
      `if(u.searchParams.has(${JSON.stringify(SHELL_MISS_PARAM)}))return;` +
      `u.searchParams.set(${JSON.stringify(SHELL_MISS_PARAM)},"miss");` +
      "try{window.stop()}catch(e){}location.replace(u.href)})()",
  );
}

/**
 * An inline script a shell HIT's tail appends. It carries no CSP nonce: a
 * request with an active per-request nonce never reaches a HIT
 * (rsc-rendering.ts shellServePlan serves it on axis 1).
 */
export function inlineShellScript(body: string): string {
  return `<script>${body}</script>`;
}

/**
 * Version gates for a stored shell: reactVersion AND buildVersion must both
 * match the running server. The postponed blob encodes hole positions against
 * one exact tree, so resuming it under a different React OR a different app
 * build tree-mismatches inside resume() — after the 200 + prelude committed,
 * with no recovery. Either mismatch is a miss: the recapture overwrites the
 * same key (self-healing) and the entry otherwise ages out via TTL.
 */
export function isValidShellHit(
  entry: Pick<ShellCacheEntry, "reactVersion" | "buildVersion">,
  buildVersion: string,
): boolean {
  return (
    entry.reactVersion === React.version && entry.buildVersion === buildVersion
  );
}

/** The postponed blob is stored and parses (null is the DATA variant). */
function hasParseablePostponed<T extends ShellEntryHead>(
  entry: T,
): entry is T & { postponed: string | null } {
  if (entry.postponed === undefined) return false;
  try {
    if (entry.postponed !== null) JSON.parse(entry.postponed);
    return true;
  } catch {
    return false;
  }
}

/**
 * DOCUMENT-half structural gate and type narrowing, without decoding the
 * prelude: the prelude is a string and the postponed blob parses. Partial
 * replay (which never serves the prelude) and the build-manifest read-through
 * use it as-is; the document HIT path runs it inside
 * {@link openShellDocument}, whose single decode is the prelude's check.
 *
 * navigationOnly entries store no document half (prelude/postponed absent) and
 * therefore never pass. The partial-replay path skips this gate for them
 * (replayableShellSnapshot) — snapshot fragment corruption is caught by the
 * consumer-side Flight decoders instead (SegmentFragmentDecodeError → healing
 * capture).
 */
export function hasIntactShellPayload(
  entry: ShellCacheEntry,
): entry is DocumentShellCacheEntry {
  return typeof entry.prelude === "string" && hasParseablePostponed(entry);
}

/** A document shell ready to serve: its prelude decoded exactly once. */
export interface ShellDocument {
  entry: ShellEntryHead;
  prelude: Uint8Array;
  /** React's postponed state, parse-checked (null = DATA variant). */
  postponed: string | null;
  /**
   * The capture snapshot: on the entry, or still arriving on its own promise
   * after a prelude-first read (SegmentCacheStore.readShellDocument), which
   * only the tail awaits.
   */
  snapshot: ShellSnapshotRecord[] | Promise<ShellSnapshotRecord[] | undefined>;
  /** Why a prelude-first read's snapshot is missing (ShellDocumentRead). */
  snapshotFailure?: Promise<ShellSnapshotFailure | undefined>;
  /** The prelude-first read's stats, when perf metrics are on. */
  stats?: ShellReadStats;
}

/**
 * Pre-commit integrity gate for a document HIT, and its only prelude decode.
 * A stored entry whose prelude is not decodable base64 or whose postponed blob
 * is not parseable JSON would otherwise throw AFTER the 200 + full static
 * prelude flushed (`resumeShellHTML` parses in the tail) — the client gets a
 * visually complete page that never hydrates, re-served on every request
 * until the entry ages out. Returning null here turns a corrupt entry
 * (store-layer fault) into a plain MISS the recapture overwrites. The decoded
 * bytes are what serveShellHit enqueues, so the check costs no second decode.
 * A prelude-first `read` (SegmentCacheStore.readShellDocument) already carries
 * the raw bytes and a pending snapshot, so only its postponed blob is checked.
 */
export function openShellDocument(entry: ShellCacheEntry): ShellDocument | null;
export function openShellDocument(
  entry: ShellEntryHead,
  read: Pick<
    ShellDocumentRead,
    "prelude" | "snapshot" | "snapshotFailure" | "stats"
  >,
): ShellDocument | null;
export function openShellDocument(
  entry: ShellEntryHead | ShellCacheEntry,
  read?: Pick<
    ShellDocumentRead,
    "prelude" | "snapshot" | "snapshotFailure" | "stats"
  >,
): ShellDocument | null {
  if (read) {
    if (!hasParseablePostponed(entry)) return null;
    return {
      entry,
      postponed: entry.postponed,
      prelude: read.prelude,
      snapshot: read.snapshot,
      ...(read.snapshotFailure && { snapshotFailure: read.snapshotFailure }),
      ...(read.stats && { stats: read.stats }),
    };
  }
  // The read-less overload takes a whole entry (getShell, a build shell).
  const whole = entry as ShellCacheEntry;
  if (!hasIntactShellPayload(whole)) return null;
  let prelude: Uint8Array;
  try {
    prelude = base64ToBytes(whole.prelude);
  } catch {
    return null;
  }
  return {
    entry: whole,
    postponed: whole.postponed,
    prelude,
    snapshot: whole.snapshot,
  };
}

/**
 * Prelude enqueue granularity. A streaming compressor in front of the worker
 * emits its first byte only after compressing the whole write it was handed:
 * one 629 KB enqueue delayed the first compressed byte by the full prelude's
 * compression time (brotli-6 5.1 ms, gzip-6 1.1 ms in Node zlib with a flush
 * per write; workerd's CompressionStream emits nothing until the whole write is
 * compressed), while 32 KB chunks emit within 0.1 ms and cost slightly more
 * in total compression (0.55-0.70 ms) than one write (issue #941).
 */
export const SHELL_PRELUDE_CHUNK_BYTES: number = 32 * 1024;

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
  /** The capture snapshot available to the tail (read and parsed). */
  snapshotMs?: number;
  /** Snapshot bytes read after the commit (prelude-first stores). */
  snapshotBytes?: number;
  /** Snapshot bytes read after the commit, excluding the parse. */
  snapshotReadMs?: number;
  /** Snapshot JSON.parse CPU (reads 0 on a deployed worker: see bytes). */
  snapshotParseMs?: number;
  /** Snapshot records by family, e.g. `segment:1/item:5` (no commas: it rides a Server-Timing desc). */
  snapshotRecords?: string;
  /** Records the capture pruned from the snapshot, same format (ShellCacheEntry.prunedRecords). */
  snapshotPruned?: string;
  /** Loader-family seed decode (only when the entry carried a snapshot). */
  seedMs?: number;
  /** The seed decode's own duration: Flight deserialization, CPU only. */
  seedCpuMs?: number;
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
 * Compact single-line form for the console log and the Server-Timing mirror's
 * `desc`: alphanumerics and `=`, `-`, `:`, `/` only (records=segment:1 pruned=item:5),
 * so no quoted-string escaping is needed. Offsets are from the commit; the
 * `-cpu` fields are CPU-only durations.
 */
export function describeShellTailTiming(timing: ShellTailTiming): string {
  const parts: string[] = [timing.outcome];
  if (timing.snapshotMs !== undefined) {
    parts.push(`snapshot=${timing.snapshotMs}ms`);
  }
  if (timing.snapshotReadMs !== undefined) {
    parts.push(`snapshot-read=${timing.snapshotReadMs}ms`);
  }
  if (timing.snapshotBytes !== undefined) {
    parts.push(`snapshot-bytes=${timing.snapshotBytes}b`);
  }
  if (timing.snapshotParseMs !== undefined) {
    parts.push(`snapshot-parse-cpu=${timing.snapshotParseMs}ms`);
  }
  if (timing.snapshotRecords !== undefined) {
    parts.push(`records=${timing.snapshotRecords}`);
  }
  if (timing.snapshotPruned !== undefined) {
    parts.push(`pruned=${timing.snapshotPruned}`);
  }
  if (timing.seedMs !== undefined) parts.push(`seed=${timing.seedMs}ms`);
  if (timing.seedCpuMs !== undefined) {
    parts.push(`seed-cpu=${timing.seedCpuMs}ms`);
  }
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
 * Last-tail-per-key buffer backing the `ppr:tail` Server-Timing mirror: a
 * HIT's tail finishes after its own headers are long gone, so its per-stage
 * numbers ride the NEXT ppr GET for the key when the metrics surface is
 * active (debugPerformance). Same shape and FIFO cap as the capture mirror
 * (shell-capture.ts lastCaptureEventsForTiming). serveShellHit collects and
 * publishes a timing only in dev or when the HIT itself collected metrics, so
 * a production isolate without debugPerformance never grows the map.
 */
const lastTailTimingsForServerTiming = new Map<string, ShellTailTiming>();
const MAX_TAIL_TIMING_KEYS = 100;

/** Buffer one terminal tail timing for the Server-Timing mirror. */
export function publishShellTailTiming(timing: ShellTailTiming): void {
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

/**
 * Warn once per key that a route declared `ppr` but the app-level cache store
 * does not implement the shell family (getShell/putShell), so the route stays on
 * axis 1. Unlike an undeclared route (silent), a declared route that cannot be
 * honored deserves a diagnostic.
 */
export function warnShellStoreMissingOnce(key: string): void {
  warnOnce(
    "store-missing",
    key,
    () =>
      `[rango] Route for "${key}" declares the ppr path option, but the app-level ` +
      "cache store does not implement the shell family (getShell/putShell), so " +
      "the route is served on axis 1 without a shell. Use MemorySegmentCacheStore, " +
      "CFCacheStore, or VercelCacheStore (or add the family to your custom store) " +
      "via createRouter({ cache }).",
  );
}

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
  warnOnce(
    "nonce-active",
    key,
    () =>
      `[rango] Route for "${key}" declares the ppr path option, but a per-request ` +
      "CSP nonce is active for this request (from createRouter({ nonce }) or a " +
      "ctx.set(nonce, …) token write in middleware), so the route is served on " +
      "axis 1 without a shell. A shell is shared per host+URL; baking one " +
      "request's nonce into it would break CSP for every other visitor. Drop the " +
      "ppr option on this route, or stop setting a per-request nonce for it.",
  );
}

/**
 * Dev only (the caller gates on NODE_ENV): warn once per route that the
 * route's cache() entry reduces an explicit `ppr.ttl` or `ppr.swr`. `shell`
 * is what the capture stores for a record written just now
 * (shell-capture.ts capShellWindow), so the message states the values the
 * shell actually gets. A ppr value the cap leaves whole (or raises: the
 * cap can move a record's stale time into the shell's swr) is silent, and
 * so is a ppr config that sets no ttl/swr.
 */
export function warnPprWindowCappedOnce(
  routeName: string,
  ppr: { ttl?: number; swr?: number },
  shell: { ttl: number; swr: number },
  cache: { ttl: number; swr: number },
): void {
  if (hasWarnedOnce("ppr-window-capped", routeName)) return;
  const reduced: string[] = [];
  for (const field of ["ttl", "swr"] as const) {
    const own = ppr[field];
    if (own !== undefined && shell[field] < own) {
      reduced.push(`ppr.${field} ${own}`);
    }
  }
  if (reduced.length === 0) return;
  warnOnce(
    "ppr-window-capped",
    routeName,
    () =>
      `[rango] Route "${routeName}": its shell is stored with ttl ${shell.ttl} ` +
      `and swr ${shell.swr}, below its ${reduced.join(" and ")}. A shell ` +
      `never outlives the route cache() entry (ttl ${cache.ttl}, swr ` +
      `${cache.swr}) it was captured from, so a document request and a ` +
      "client navigation show the same handler output. Keep ppr.ttl within " +
      "the cache() ttl, and ppr.ttl + ppr.swr within the cache() ttl + swr, " +
      "to silence this.",
  );
}

/**
 * Paths a partitioned request found without a build shell. Build shells are
 * per path (a param route prerenders some of its paths), so a negative is
 * kept per path, not per route; cleared when full, so it stays bounded.
 */
const pathsWithoutBuildShell = new Set<string>();
const PATHS_WITHOUT_BUILD_SHELL_MAX = 1_000;

/**
 * Whether a partitioned request needs no build-shell probe: its route was
 * already warned, or its path was already found without one.
 */
export function partitionBuildShellCheckDone(
  pathname: string,
  routeName: string | undefined,
): boolean {
  return (
    hasWarnedOnce("partition-build-shell", routeName ?? pathname) ||
    pathsWithoutBuildShell.has(pathname)
  );
}

/**
 * Record a partitioned request's build-shell probe, and warn once per route
 * when it found one: the route has a build-time shell its requests cannot
 * read. The route's request partition (a `cache({ key })` enclosing it, at
 * any depth (#970), or the store's keyGenerator) keys the shell per
 * partition, and the build captured only
 * the default one, so each partition captures at runtime. Same
 * declared-intent-cannot-be-honored doctrine as the warnings above; a path
 * with no build shell stays silent.
 */
export function notePartitionBuildShellCheck(
  pathname: string,
  routeName: string | undefined,
  found: boolean,
): void {
  if (!found) {
    if (pathsWithoutBuildShell.size >= PATHS_WITHOUT_BUILD_SHELL_MAX) {
      pathsWithoutBuildShell.clear();
    }
    pathsWithoutBuildShell.add(pathname);
    return;
  }
  // Concurrent first requests can both probe; one of them warns.
  warnOnce(
    "partition-build-shell",
    routeName ?? pathname,
    () =>
      `[rango] Route ${routeName ? `"${routeName}" ` : ""}("${pathname}") has a ` +
      "build-time shell, but its request partition (a cache({ key }) enclosing the route, " +
      "or the store's keyGenerator) keys its shell per partition, so the build " +
      "shell is not served and each partition captures its own at runtime. A " +
      "keyGenerator that returns the default key unchanged keeps the build shell.",
  );
}

/**
 * @internal Reset the serve path's once-per-key warnings (the shell path's
 * one registry), its build-shell probe memo and buffered tail timings. Tests
 * only (testing/serve-shell-request.ts resetShellTestState).
 */
export function resetShellServeStateForTests(): void {
  resetShellWarningsForTests();
  pathsWithoutBuildShell.clear();
  lastTailTimingsForServerTiming.clear();
}
