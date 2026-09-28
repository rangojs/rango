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
import type { SearchParamsFilter } from "../cache/search-params-filter.js";
import { base64ToBytes } from "../cache/cf/cf-base64.js";
import type {
  DocumentShellCacheEntry,
  ShellCacheEntry,
  ShellDocumentRead,
  ShellReadStats,
  ShellSnapshotRecord,
  SegmentCacheStore,
} from "../cache/types.js";
import { SHELL_CAPTURE_MAX_WAIT_MS } from "./shell-capture-constants.js";

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
 * Shell cache key: host + pathname + sorted search + a `:shell` namespace suffix
 * (so it can never collide with a document-cache key; the store further isolates
 * the shell family internally).
 *
 * The key includes the request HOST: in a multi-tenant host-router deployment
 * (one worker, one shared KV/runtime-cache store) a host-less key would serve
 * tenant A's captured shell to tenant B's users.
 *
 * `filter` is the request's compiled `cache.searchParams` config
 * (ctx._searchParamsFilter): excluded params collapse onto one shell slot.
 * Callers on the serve/capture path MUST pass it -- key drift between capture
 * and lookup makes every shell request a permanent miss.
 */
export function buildShellKey(url: URL, filter?: SearchParamsFilter): string {
  return `${url.host}${url.pathname}${shellSearchSeed(url, filter)}:shell`;
}

/**
 * The shell key's search portion (`?`-prefixed sorted search with the
 * cache.searchParams filter applied, or "") — ALSO the string the capture and
 * resume SSR renders seed their store location with (SSRRenderOptions.search
 * / ShellCaptureOptions.search / ShellResumeOptions.search). Search is part
 * of shell identity, so static-part `useSearchParams` reads render exactly
 * what the key names; deriving seed and key from this one helper is what
 * keeps capture, resume, and lookup byte-agreed (drift = replay mismatch or
 * permanent MISS).
 */
export function shellSearchSeed(url: URL, filter?: SearchParamsFilter): string {
  const sorted = sortedSearchString(url.searchParams, filter);
  return sorted ? `?${sorted}` : "";
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

/** The postponed blob is stored and parses (null is the DATA variant). */
function hasParseablePostponed(
  entry: ShellCacheEntry,
): entry is ShellCacheEntry & { postponed: string | null } {
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
  entry: ShellCacheEntry;
  prelude: Uint8Array;
  /** React's postponed state, parse-checked (null = DATA variant). */
  postponed: string | null;
  /**
   * The capture snapshot: on the entry, or still arriving on its own promise
   * after a prelude-first read (SegmentCacheStore.readShellDocument), which
   * only the tail awaits.
   */
  snapshot:
    | ShellSnapshotRecord[]
    | undefined
    | Promise<ShellSnapshotRecord[] | undefined>;
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
export function openShellDocument(
  entry: ShellCacheEntry,
  read?: Pick<ShellDocumentRead, "prelude" | "snapshot" | "stats">,
): ShellDocument | null {
  if (read) {
    if (!hasParseablePostponed(entry)) return null;
    return {
      entry,
      postponed: entry.postponed,
      prelude: read.prelude,
      snapshot: read.snapshot,
      ...(read.stats && { stats: read.stats }),
    };
  }
  if (!hasIntactShellPayload(entry)) return null;
  let prelude: Uint8Array;
  try {
    prelude = base64ToBytes(entry.prelude);
  } catch {
    return null;
  }
  return {
    entry,
    postponed: entry.postponed,
    prelude,
    snapshot: entry.snapshot,
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
