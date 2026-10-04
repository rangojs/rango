/**
 * PPR shell capture orchestration (Axis 2, see docs/design/ppr-shell-resume.md).
 *
 * Capture does NOT flow through the HTTP middleware pipeline. The integrated PPR
 * serve path (rsc-rendering.ts + shell-serve.ts) builds a ShellCaptureDescriptor
 * from the route's `ppr` path option after the served response is built and calls
 * scheduleShellCapture. The capture then runs as a background task that re-derives
 * the page via `ctx.router.match()` under its OWN derived request context — fresh
 * handle store, `_shellCaptureRun: true` so live-lane loaders mask (loader-mask.ts)
 * and postpone at their loading() or inline <Suspense> boundary. The match is
 * MIXED-CHAIN: cache()'d segments replay from ring 3, uncached segments execute
 * their handlers. The record-first step (settleCaptureRecord) waits for the
 * handler layer, writes the doc record every HIT replays, and renders the
 * capture's Flight payload from it; the static prerender runs to a quiescent
 * shell, aborts to freeze the prelude + postponed state, and putShell stores the
 * pair with the snapshot. Because it uses match() rather than the HTTP pipeline,
 * the middleware chain (auth, logging) never re-runs — it already ran for the
 * triggering request, and the derived context inherits its post-middleware state
 * (variables, cache store). Guarding is serve-time.
 */

import React from "react";
import { isLoaderDataResult, type MatchResult } from "../types.js";
import { bytesToBase64 } from "../cache/cf/cf-base64.js";
import { SHELL_BAKE_TAG_OWNER, getSegmentTags } from "../cache/cache-tag.js";
import { reportCacheError } from "../cache/cache-error.js";
import {
  raceDeadline,
  runBackground,
  settleGrowing,
} from "../cache/background-task.js";
import {
  CaptureQueueFullError,
  CaptureQueueWaitTimeoutError,
  captureQueueDepths,
  enqueueSerializedCapture,
} from "./capture-queue.js";
import {
  PPR_LANE_HINT,
  SHELL_CAPTURE_MAX_WAIT_MS,
  SHELL_CAPTURE_TASK_HARD_CAP_MS,
  resetShellWarningsForTests,
  warnOnce,
} from "./shell-capture-constants.js";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import { observePhase, PHASES } from "../router/instrument.js";
import type { TraceSpan } from "../router/tracing.js";
import {
  runWithRequestContext,
  setRequestContextParams,
  wireRenderBarrier,
  UNTRACKED_BACKGROUND_TASK,
  type RequestContext,
  type RouteRecordWindow,
} from "../server/request-context.js";
import {
  DEFAULT_FUNCTION_TTL,
  resolveSwrWindow,
  resolveTtl,
} from "../cache/cache-policy.js";
import { createHandleStore, type HandleStore } from "../server/handle-store.js";
import {
  maskNestedContainerThenables,
  settleNestedThenables,
  type MaskReport,
} from "../router/segment-resolution/mask-nested.js";
import {
  findEnclosingLoaderBody,
  getCurrentLoaderBodyId,
  isInsideLoaderScope,
} from "../server/context.js";
import { isThenable } from "../handles/is-thenable.js";
import { requestHeaders } from "../server/request-headers.js";
import type {
  CachedEntryData,
  ShellCacheEntry,
  SegmentCacheStore,
  ShellSnapshotHandlesValue,
  ShellSnapshotRecord,
} from "../cache/types.js";
import {
  elideLoaderContainer,
  isLoaderHoleMarker,
} from "../router/segment-resolution/loader-snapshot.js";
import {
  RecordingShellStore,
  SHELL_HANDLES_RECORD_KEY,
  SnapshotOnlySegmentStore,
  countSnapshotFamilies,
  estimateShellEntryBytes,
  getRecordingStore,
  hasDocRecord,
  pruneShellSnapshot,
} from "../cache/shell-snapshot.js";
import {
  captureOwnedHandles,
  encodeHandles,
} from "../cache/handle-snapshot.js";
import type { HandlerContext } from "./handler-context.js";
import type { SSRModule } from "./types.js";
import { buildFullPayload, payloadInitialTheme } from "./full-payload.js";
import { resolveDeferredHandleValues } from "../handles/deferred-resolution.js";
import { renderRscFlightStage } from "./render-pipeline.js";
import { stripInternalParams } from "../router/handler-context.js";

/**
 * Task-quantized quiesce: the number of consecutive macrotask hops with zero new
 * Flight bytes that marks the shell "quiet". This replaces the old 50ms
 * wall-clock debounce.
 *
 * The capture Flight render is a REGULAR renderToReadableStream (not a static
 * prerender), so React schedules both its retries and its byte-flush on
 * setTimeout(0) MACROTASKS (verified against the vendored edge production
 * react-server-dom build: pingTask uses scheduleMicrotask only when
 * request.type === PRERENDER, otherwise setTimeout; enqueueFlush is always
 * setTimeout). Masked loaders are the live lane — their rows never emit — so once
 * the shell rows finish flushing the stream goes permanently byte-silent, and K
 * consecutive quiet macrotask hops after the last observed byte declare quiesce.
 *
 * K=2 gives a race window of ~two event-loop turns: shell work still producing
 * bytes keeps resetting the counter; anything not producing bytes within the
 * window (the masked loaders) becomes a hole. Handler output never races it: the
 * capture's Flight input is the doc record's fragments, rendered after
 * settleCaptureRecord waited for the handler layer. See
 * docs/design/ppr-shell-resume.md.
 */
const FLIGHT_QUIET_HOPS = 2;

/**
 * Upper bound on waiting for the capture's DEFERRED cache writes to settle before
 * draining the snapshot. Cache writes run under waitUntil (fire-and-forget on
 * Node, executionContext on workerd), so a MISS-at-capture value's setItem/set —
 * hence its snapshot record — can land after the shell has quiesced. We collect
 * those write promises and await them here so the written value is pinned. Kept
 * short: a pathological slow write must never stall the background capture; a key
 * that does not settle in time is simply left unpinned (it drifts, the
 * pre-snapshot behavior) rather than hanging. Reads that HIT are recorded
 * synchronously during the render and do not depend on this.
 */
const SHELL_SNAPSHOT_WRITE_SETTLE_MS = 1000;

/**
 * Upper bound on the pre-render WRITE BARRIER: before the capture's match/render,
 * settle the background tasks the FOREGROUND request already scheduled — its
 * deferred ring-3 cacheRoute and ring-1 setItem writes all go through
 * reqCtx.waitUntil, and every one of them is scheduled BEFORE scheduleShellCapture
 * runs (the response, and its onResponse callbacks, are committed first). Draining
 * them turns the capture's cache reads from a RACE into an ORDERING EDGE: the
 * capture deterministically observes the foreground's cache generation, replays it
 * (handler skipped, module-level side effects untouched), and records THAT
 * generation into the snapshot — so prelude, snapshot, and ring-3 all agree on the
 * foreground's generation and the capture can never clobber a foreground-produced
 * entry with a re-render of its own. Scar tissue: without this, the capture's
 * ring-3 lookup could land between the foreground write chain's serialization and
 * its store.set, MISS, re-execute the route handler (bumping module-level
 * counters), and — via the synthetic onResponse fire below — overwrite the
 * foreground's entry (the mini shell-manifest regression). Bounded: a slow
 * consumer waitUntil task must never stall the background capture; on timeout the
 * capture proceeds with the pre-barrier (racy) behavior.
 */
const SHELL_CAPTURE_WRITE_BARRIER_MS = 1500;

/**
 * Settle the tracked background tasks on `reqCtx._pendingBackgroundTasks`,
 * including nested ones a settled task scheduled (cache-store's cacheRoute
 * outer task schedules the actual store.set in a second waitUntil), until the
 * list stops growing or the timeout passes. The capture's own task never
 * enters the list (UNTRACKED_BACKGROUND_TASK), so the wait terminates.
 */
async function settleTrackedBackgroundTasks(
  reqCtx: RequestContext<any>,
  timeoutMs: number,
): Promise<void> {
  const tasks = reqCtx._pendingBackgroundTasks;
  if (tasks) await settleGrowing(tasks, Date.now() + timeoutMs);
}

/**
 * Delay before the in-place retry of a capture that produced no usable shell.
 *
 * The dominant reason a first capture comes back with a trivial prelude is a
 * COLD render: in dev the module transform graph (route modules, the SSR/Flight
 * transforms) is being built lazily and outlasts the task-quantized quiesce, so
 * the shell has not finished rendering when we freeze it; on a cold worker the
 * first invocation pays the same one-time cost. The first attempt WARMS that
 * graph, so a second attempt a short beat later usually completes the shell in
 * the SAME background task — no extra HTTP request needed. Short enough to feel
 * instant, long enough for the module graph to settle. See
 * docs/design/ppr-shell-resume.md ("Capture retry-in-place").
 */
const SHELL_CAPTURE_RETRY_DELAY_MS = 400;

/** Sleep `ms`, unref'd so a Node dev process is never kept alive by the timer. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * Bound one capture task at {@link SHELL_CAPTURE_TASK_HARD_CAP_MS}. Rejects on
 * expiry so the caller's existing catch applies backoff + reporting and its
 * settle path releases the stampede guard and queue slot; resolves/rejects
 * transparently otherwise.
 */
async function raceTaskHardCap<T>(task: Promise<T>, key: string): Promise<T> {
  const raced = await raceDeadline(
    task,
    Date.now() + SHELL_CAPTURE_TASK_HARD_CAP_MS,
  );
  if (raced.done) return raced.value;
  throw new Error(
    `capture task for ${key} exceeded the ${SHELL_CAPTURE_TASK_HARD_CAP_MS}ms hard cap; ` +
      `a handler is likely wedged on a never-settling await`,
  );
}

/**
 * Module-level in-flight key map: the stampede guard for background captures, and
 * its single owner. One capture runs per key per isolate; concurrent MISS/stale
 * requests for the same key coalesce onto the first (the rest see the key present
 * in scheduleShellCapture and skip). Added when a capture is scheduled and cleared
 * in the task's settle paths via a token-guarded release, so a later request can
 * recapture when TTL rolls. Living here (not split across the middleware) keeps
 * the add/clear lifecycle in one layer.
 *
 * The value is the owning task's token ({@link CaptureGuardToken}) rather than
 * a bare set entry: workerd can kill a capture's waitUntil context before its
 * finally runs (or the task can wedge past every deadline), stranding the key.
 * scheduleShellCapture treats an entry older than
 * SHELL_CAPTURE_TASK_HARD_CAP_MS as abandoned and reclaims it; the token guard
 * keeps a late-settling stale task from releasing its replacement's entry.
 */
interface CaptureGuardToken {
  /**
   * The schedule time while the capture waits in the queue (which drops it at
   * CAPTURE_QUEUE_WAIT_BUDGET_MS, under the cap), then the time its hard cap
   * started. Stamped only at schedule time, a capture that had waited in the
   * queue read as older than its cap while still inside it, and the next
   * request scheduled a duplicate capture of the key.
   */
  startedAt: number;
}

const inFlightCaptures = new Map<string, CaptureGuardToken>();

/** Token-guarded release: only the entry's owning task may clear it. */
function releaseCaptureGuard(key: string, token: CaptureGuardToken): void {
  if (inFlightCaptures.get(key) === token) {
    inFlightCaptures.delete(key);
  }
}

/**
 * Refused-capture backoff bounds. The window is EXPONENTIAL in the consecutive
 * failure count: `min(BASE * 2^(failures-1), ceiling)` — 1s, 2s, 4s, … up to the
 * mode's ceiling (60s in production, {@link REFUSED_CAPTURE_DEV_MAX_MS} in dev).
 *
 * Why exponential and not a flat 60s: a flat long window conflates two very
 * different failures. A STRUCTURALLY ineligible route (a boundary-less live
 * loader read, a cookie reader) fails forever and wants the long 60s cap. But a
 * cold-but-ELIGIBLE route can also fail the in-place retry under a truly cold
 * graph (dev module transform, or a cold worker under parallel load) — and it
 * must recover FAST, on the next
 * request or two, not be frozen for 60s (that would re-break the very cold-start DX
 * the retry fixes; it bit the cloudflare dev e2e). Escalating from 1s means the
 * eligible route re-probes almost immediately (warm now → HIT and clear), while the
 * doomed route ramps to the ceiling within a handful of failures. Either way an
 * app-wide mount never re-renders a doomed route on EVERY request.
 */
const REFUSED_CAPTURE_BASE_MS = 1_000;
const REFUSED_CAPTURE_MAX_MS = 60_000;

/**
 * DEV-only backoff ceiling. In dev the 60s production cap is pure harm: the
 * dominant no-shell cause is a COLD module graph (route modules, SSR/Flight
 * transforms built lazily), and the very attempt that failed WARMS that graph, so
 * the next attempt a beat later usually completes the shell. Capping the dev window
 * low keeps a cold-but-eligible route re-probing every ~2s instead of freezing for
 * up to 60s once the exponential climbs (1s→2s→4s→…→60s). A 60s freeze outlasts the
 * e2e warm windows on cold CI runners: the capture races an unfinished shell,
 * escalates the backoff past the poll window, and every subsequent request inside
 * that window is skipped as backed-off — an eternal MISS for the test even though
 * the modules are warm by then. Production keeps the full 60s cap: there the
 * no-shell cause is far more likely to be a genuinely ineligible route (no
 * loading()), which SHOULD be re-probed rarely. See #652 (item 3) and
 * docs/design/ppr-shell-resume.md ("Refused-capture backoff").
 */
const REFUSED_CAPTURE_DEV_MAX_MS = 2_000;

/**
 * Dev signal, matching the rest of the RSC runtime (handler.ts, server-action.ts,
 * progressive-enhancement.ts): treat anything but an explicit production build as
 * dev. The build folds `process.env.NODE_ENV` to a literal, so this is a compile-
 * time constant in the shipped worker — no runtime probe.
 */
function isDevMode(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** The active backoff ceiling for the current mode (dev capped low, prod at 60s). */
function refusedCaptureCeilingMs(): number {
  return isDevMode() ? REFUSED_CAPTURE_DEV_MAX_MS : REFUSED_CAPTURE_MAX_MS;
}

/**
 * Refused-capture backoff: key -> { consecutive failure count, epoch ms until which
 * the key is not re-probed }. A key enters backoff only after runShellCapture's
 * in-place retry ALSO failed (or a genuine error). A successful capture clears the
 * entry outright (failure count resets). Module-level (same lifetime as
 * inFlightCaptures) so the whole lifecycle lives in one layer.
 */
const refusedCaptures = new Map<string, { failures: number; until: number }>();

/** A bake-lane container that settled with redirect() or notFound(). */
function isSettledLoaderSignal(value: unknown): boolean {
  return (
    isLoaderDataResult(value) &&
    !value.ok &&
    (value.redirect !== undefined || value.notFound === true)
  );
}

/** True iff `key` is still inside its (exponential) backoff window. */
function isCaptureBackedOff(key: string): boolean {
  const entry = refusedCaptures.get(key);
  if (entry === undefined) return false;
  // Window elapsed: allow a re-probe. Keep the entry (its failure count drives the
  // NEXT window's escalation if the re-probe also fails); a success clears it.
  return Date.now() < entry.until;
}

/**
 * Record a refused/failed capture, escalating the backoff window exponentially up
 * to the current mode's ceiling. The failure count keeps climbing across attempts
 * (so a genuinely doomed route still ramps toward its cap), but the WINDOW is
 * clamped: 60s in production, {@link REFUSED_CAPTURE_DEV_MAX_MS} in dev so a
 * cold-but-eligible route re-probes fast instead of freezing out the e2e warm
 * window on a cold CI runner (#652 item 3).
 */
function markCaptureBackoff(key: string): void {
  const failures = (refusedCaptures.get(key)?.failures ?? 0) + 1;
  const window = Math.min(
    REFUSED_CAPTURE_BASE_MS * 2 ** (failures - 1),
    refusedCaptureCeilingMs(),
  );
  refusedCaptures.set(key, { failures, until: Date.now() + window });
}

/** Clear any backoff for a key that just captured successfully. */
function clearCaptureBackoff(key: string): void {
  refusedCaptures.delete(key);
}

/**
 * Warn once per key that a capture produced no usable shell: after the
 * in-place retry (runShellCapture attempt 2), or after one attempt that ran
 * out of its deadline (no retry: CaptureAttemptStats.noShellCause), with the
 * terminal attempt's cause and pending component stacks. Naming both causes with the
 * distinguishing signal — does the route ever flip to HIT — is the whole point:
 * the pre-retry version blamed "a loader route without loading()" unconditionally
 * and misled users whose route DID have loading() and was merely cold. Because the
 * retry already absorbs the cold-start case, by the time this fires cold-start has
 * usually healed, so a firing warning leans toward the structural cause — but we
 * still name both so a cold-start straggler is not misdiagnosed.
 *
 * The pointer is the shared PPR_LANE_HINT: the /ppr skill ships in the npm
 * tarball, so the path resolves for consumers (a05c8251 convention).
 */
function warnNullCaptureOnce(
  key: string,
  retried: boolean,
  attempt: CaptureAttemptStats,
): void {
  const cause = attempt.noShellCause;
  const pendingStacks = attempt.pendingStacks;
  warnOnce(
    "capture-no-shell",
    key,
    () =>
      `[rango] Shell capture for "${key}" produced no usable shell` +
      (retried ? " after an in-place retry" : "") +
      "; nothing was stored, so this request stays on MISS. " +
      (cause
        ? `Cause: ${cause}. Every capture waits for the handler layer to finish and ` +
          'bakes it; make the slow part cheaper (cache() or "use cache"), raise ' +
          "ppr.captureTimeout, or move it into a live loader (no ssr: false) read under " +
          "loading() or an inline <Suspense>.\n"
        : "Causes, told apart by whether the route ever flips to HIT:\n" +
          "  1. Cold-start warmup (dev module transform, or a cold worker): the capture raced " +
          "an unfinished shell render. This SELF-HEALS — the route flips to HIT once a later " +
          "request warms the modules.\n" +
          "  2. Something suspends above <body> with no Suspense boundary and never settles " +
          "within the capture window: a live loader (no ssr: false) read without loading() or " +
          "an inline <Suspense>, or a loader(Def, { ssr: false }) or top-level push (e.g. Meta) " +
          "slower than ppr.captureTimeout. The boundary belongs to the entry or component " +
          "that owns the data.\n") +
      (pendingStacks && pendingStacks.length > 0
        ? "Components still pending when the capture froze the shell (one of them " +
          "suspended above <body>):\n" +
          pendingStacks.map(formatPendingStack).join("\n") +
          "\n"
        : "") +
      PPR_LANE_HINT,
  );
}

/** Stacks kept per attempt: the root pin is almost always among the first. */
const MAX_PENDING_STACKS = 3;

/** The first lines of one component stack, indented under the warning. */
function formatPendingStack(stack: string): string {
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((line) => `    ${line}`)
    .join("\n");
}

/**
 * Warn once per key that the capture was REFUSED for a deterministic reason
 * (identity-guard trip, a rejected or signal-settled bake-lane loader, a store
 * refusal). Distinct from warnNullCaptureOnce: these are not cold-start
 * shapes, the retry is skipped, and the message carries the concrete cause
 * instead of a differential. Lane-dependent causes pass PPR_LANE_HINT as the
 * trailing pointer; the rest keep the plain skill pointer.
 */
function warnCaptureRefusedOnce(
  key: string,
  reason: string,
  pointer: string = "See the /ppr skill (node_modules/@rangojs/router/skills/ppr/SKILL.md).",
): void {
  warnOnce(
    "capture-refused",
    key,
    () =>
      `[rango] Shell capture for "${key}" was refused: ${reason}\n` +
      "The route stays on MISS (axis 1) — the page keeps working, only the shell " +
      `cache is off. ${pointer}`,
  );
}

/**
 * Refuse the capture when a capture guard tripped: a request-scoped read
 * (cookies(), headers(), a { cache: false } variable) or ctx.dynamic() made
 * anywhere the capture waited for — a handler, a promise it passes or pushes,
 * an async server component, a bake-lane loader. The read throws where it
 * happens, but the code can catch that throw, so the flag the guard sets on
 * the capture context is what decides (server/context.ts
 * guardIdentityRead). Returns true when it refused (and warned).
 */
function refuseOnCaptureGuard(
  key: string,
  derivedCtx: RequestContext<any>,
): boolean {
  if (derivedCtx._dynamic) {
    // A build-time capture reports dynamic() as its own outcome
    // (build-shell-capture.ts): the URL keeps runtime capture.
    if (derivedCtx.build) return true;
    warnCaptureRefusedOnce(
      key,
      "ctx.dynamic() was called while capturing the shared shell (in a handler, or " +
        "in a promise or async component the capture waited for). A dynamic render " +
        "has no shell; the route keeps serving axis 1 for requests that opt out.",
    );
    return true;
  }
  const trip = derivedCtx._shellCaptureGuardTripped;
  if (!trip) return false;
  // Name the recorded source instead of hardcoding a lane: a trip can come
  // from a bake-lane SEGMENT loader or from handler/render code, including a
  // loader a handler awaits (issue #672). The guard recorded the read and its
  // fix (server/context.ts guardIdentityRead): cookies()/headers(), a
  // { cache: false } variable, and the theme reads (#971).
  const loaderId = derivedCtx._shellCaptureGuardTrippedLoaderId;
  const origin = loaderId
    ? `the loader "${loaderId}"`
    : "handler/render code (no loader body was executing)";
  warnCaptureRefusedOnce(
    key,
    `${origin} read ${trip.surface} during capture; request-scoped data must not ` +
      `bake into the shared shell. ${trip.fix}`,
    PPR_LANE_HINT,
  );
  return true;
}

/** The no-shell cause for handler output that missed the capture deadline. */
const HANDLER_OUTPUT_TIMEOUT_REASON: string =
  "the handler output (a promise it passes or pushes, or an async server " +
  "component) did not settle within ppr.captureTimeout";

/** The refusal for a capture that stored no doc record (a HIT needs it). */
const NO_DOC_RECORD_REASON: string =
  "the capture produced no doc segment record, so a HIT could not replay the " +
  "handler layer. Either the route's cache() refused the write (cache(false), or " +
  "a condition() that returned false for the capture), or rendering the handler " +
  "output failed (see the cache-write error reported for this key).";

/**
 * Default limit (bytes) on a whole stored shell entry — prelude, postponed
 * state, and snapshot — when the store declares none
 * (SegmentCacheStore.maxShellEntryBytes). Cloudflare KV's 25 MiB value limit:
 * the tightest common store tier a shell entry lands in.
 */
export const DEFAULT_SHELL_ENTRY_MAX_BYTES: number = 25 * 1024 * 1024;

/**
 * Default cap (serialized UTF-8 bytes) on the capture data snapshot riding
 * inside a shell entry, when the route's `ppr` option does not set
 * `maxSnapshotBytes`. 8 MiB: the snapshot shares the stored envelope with the
 * base64 prelude and the postponed blob, and the tightest store value limit is
 * Cloudflare KV's 25 MiB — 8 MiB of snapshot leaves the envelope well under it
 * while still fitting any sane pinned-ring payload. Applied ONLY in
 * captureAndStoreShell (the single defaulting site — resolvePprConfig passes
 * the option through undefaulted), so every producer and direct caller gets
 * the same policy. The doc record is exempt; over the cap the other records
 * are dropped (shell still stored and replayed; the pins' loaders read the
 * live store — see PartialPrerenderProps.maxSnapshotBytes).
 */
export const DEFAULT_PPR_MAX_SNAPSHOT_BYTES: number = 8 * 1024 * 1024;

/** Cached encoder for the snapshot byte measurement (one per module, not per capture). */
const SNAPSHOT_BYTE_ENCODER = new TextEncoder();

/**
 * Warn once per key that the capture's loader pins exceeded the route's
 * `maxSnapshotBytes` cap and were dropped. The shell entry is still stored
 * with its doc record and every HIT replays the handler layer; only the
 * pinned loaders lose their captured values, so their cached data can drift
 * from the frozen prelude and hydration repairs it client-side. Once per
 * key: the same page recaptures on every TTL roll and would otherwise
 * re-warn forever.
 */
function warnSnapshotOverCapOnce(
  key: string,
  snapshotBytes: number,
  capBytes: number,
): void {
  warnOnce(
    "snapshot-over-cap",
    key,
    () =>
      `[rango] Shell capture for "${key}" recorded ${snapshotBytes} bytes of ` +
      `loader pins, over the ${capBytes}-byte cap — the pins were dropped and ` +
      "the shell was stored with its doc record only. HITs still replay the " +
      "handler layer, but ssr: false loaders now read the live store: if " +
      "their data drifts before the shell's TTL, hydration repairs the " +
      "mismatch client-side. Raise the cap via the route's ppr option " +
      "({ maxSnapshotBytes }) if the entry still fits your store's value limit " +
      "(Cloudflare KV: 25 MiB per value), or shrink the cache()'d data the " +
      "loaders read.",
  );
}

/**
 * Dev warning threshold (ms) for the record-first settle
 * (CaptureAttemptStats.recordSettleMs). Bake time is by-design shell latency
 * (handler output, top-level pushed handle promises and bake-lane loader
 * containers settle before the freeze), but it recurs on EVERY capture of the
 * route and occupies the per-isolate serialized capture queue — silently: the
 * served response's own timing never shows it (a route can read 13ms TTFB
 * while each of its captures holds the queue for seconds). Past this
 * threshold the cost gets named once per key with the remedy ladder.
 */
const SHELL_CAPTURE_BAKE_WARN_MS = 2_000;

/**
 * Dev-only, once per key: name the bake cost and the three remedies in
 * preference order. Handler output and bake-lane values are shell material
 * by design, so this is a cost report with an exit, not a deprecation.
 */
function warnBakeCostOnce(key: string, source: string, ms: number): void {
  warnOnce(
    "bake-cost",
    key,
    () =>
      `[rango] Shell capture for "${key}" waited ${ms}ms for ${source} to ` +
      "settle before the shell could freeze. This cost recurs on every capture " +
      "of the route and occupies the per-isolate capture queue; the served " +
      "response never shows it. To keep it baked but cheap, wrap the work in " +
      'cache() or "use cache"; to make it per-request, load it in a live ' +
      "loader (no ssr: false) read under loading() or an inline <Suspense>; for " +
      "a loader(Def, { ssr: false }), return the slow part as a nested promise " +
      "or drop ssr: false. " +
      PPR_LANE_HINT,
  );
}

/**
 * One structured event from the background capture pipeline, mirroring the
 * CFCacheReadDebugEvent pattern (cache/cf/cf-cache-types.ts): typed fields an
 * operator can assert against, emitted per attempt and per skip, so the
 * stored / no-shell / refused / backed-off lifecycle is observable outside
 * dev console warnings. Configured via `createRouter({ debugShellCapture })`.
 */
export interface ShellCaptureDebugEvent {
  /** Shell cache key the event is about. */
  key: string;
  /**
   * What happened:
   * - stored / redirect / no-shell / refused / expired: one capture
   *   ATTEMPT's outcome (see CaptureAttemptOutcome for the semantics of each)
   * - error: the capture task failed with a genuine error (also routed through
   *   reportCacheError; the key is backed off)
   * - skip-stored: a capture for the key stored after the scheduling request
   *   read the store and missed (ShellCaptureDescriptor.storedSeqAtRead), so
   *   the shell that request missed exists now
   * - skip-in-flight: scheduleShellCapture found a capture already running for
   *   the key (stampede guard) and scheduled nothing
   * - skip-backoff: the key is inside its refused-capture backoff window and
   *   the capture was not attempted
   * - skip-capacity: the isolate capture queue is full; a later request may retry
   * - skip-inert-store: the resolved store's shell family is missing or
   *   declared inert (SegmentCacheStore.shellFamilyInert — a custom store
   *   whose backing tier is unavailable; built-in stores never declare it);
   *   nothing could store the result, so the background render was not
   *   scheduled at all
   * - skip-queue-timeout: the capture waited past CAPTURE_QUEUE_WAIT_BUDGET_MS
   *   behind other captures and was dropped unrun (no backoff — the route is
   *   not doomed, the isolate was busy; a later request re-probes). Carries
   *   queueWaitMs.
   * - backoff: the key entered (or escalated) backoff after a terminal
   *   no-shell — carries the new backoff state
   */
  outcome:
    | "stored"
    | "redirect"
    | "no-shell"
    | "refused"
    | "expired"
    | "error"
    | "skip-in-flight"
    | "skip-stored"
    | "skip-backoff"
    | "skip-capacity"
    | "skip-inert-store"
    | "skip-queue-timeout"
    | "backoff";
  /** Attempt number (1 = first, 2 = in-place retry). Absent on skips. */
  attempt?: number;
  /** Wall-clock ms of the whole attempt (barrier + render + drain + put). */
  attemptMs?: number;
  /**
   * Wall-clock ms the pre-render WRITE BARRIER waited on the foreground
   * request's deferred cache writes (bounded by SHELL_CAPTURE_WRITE_BARRIER_MS).
   */
  barrierWaitMs?: number;
  /**
   * Wall-clock ms spent awaiting the capture's own deferred cache writes
   * before the snapshot drain (bounded by SHELL_SNAPSHOT_WRITE_SETTLE_MS).
   */
  writeSettleMs?: number;
  /** Stored prelude size in bytes (pre-base64). */
  preludeBytes?: number;
  /** Serialized snapshot size in UTF-8 bytes. Absent when nothing was recorded. */
  snapshotBytes?: number;
  /** True when the snapshot exceeded maxSnapshotBytes and was dropped. */
  snapshotSkipped?: boolean;
  /** A bake-lane loader settled into a shell that uses TTL/SWR-only invalidation. */
  untaggedBake?: true;
  /** Outcome reported by a store that supports shell-write acknowledgements. */
  storeWrite?: "stored" | "invalidated" | "uncacheable";
  /** Consecutive failure count in the key's backoff entry, when one exists. */
  backoffFailures?: number;
  /** Ms remaining in the key's backoff window, when one exists. */
  backoffRemainingMs?: number;
  /** Ms the capture waited in the serialized queue (skip-queue-timeout). */
  queueWaitMs?: number;
  /** Queue priority class at enqueue: document outranks queued navigation. */
  queuePriority?: "document" | "navigation";
  /**
   * Captures ahead at enqueue: the active one plus every waiting capture of
   * same-or-higher priority. 0 = this capture starts immediately.
   */
  queueAhead?: number;
  /**
   * How long the capture waited for its doc record: the handler layer's
   * promises, async server components and handle pushes settling, then the
   * record's encode (settleCaptureRecord). Part of the one capture deadline.
   */
  recordSettleMs?: number;
  /** Bytes of the stored entry: prelude, postponed state, and snapshot. */
  entryBytes?: number;
}

/**
 * Debug sink for the capture pipeline, mirroring {@link CFCacheDebug}: `true`
 * logs each event to console (visible via `wrangler tail`), a function
 * receives the events for programmatic capture. Off by default.
 */
export type ShellCaptureDebug =
  | boolean
  | ((event: ShellCaptureDebugEvent) => void);

/**
 * Compact single-line form of an event's fields, shared by the console sink
 * and the dev Server-Timing mirror's `desc` (rsc-rendering). Plain
 * alphanumerics/`=`/`-`/`()` only, so it needs no quoted-string escaping.
 */
export function describeShellCaptureEvent(
  event: ShellCaptureDebugEvent,
): string {
  const parts: string[] = [event.outcome];
  if (event.attempt !== undefined) parts.push(`attempt=${event.attempt}`);
  if (event.attemptMs !== undefined) parts.push(`${event.attemptMs}ms`);
  if (event.barrierWaitMs !== undefined) {
    parts.push(`barrier=${event.barrierWaitMs}ms`);
  }
  if (event.writeSettleMs !== undefined) {
    parts.push(`write-settle=${event.writeSettleMs}ms`);
  }
  if (event.preludeBytes !== undefined) {
    parts.push(`prelude=${event.preludeBytes}b`);
  }
  if (event.snapshotBytes !== undefined) {
    parts.push(
      `snapshot=${event.snapshotBytes}b${event.snapshotSkipped ? " (over cap, skipped)" : ""}`,
    );
  }
  if (event.untaggedBake) parts.push("untagged-bake");
  if (event.storeWrite !== undefined) {
    parts.push(`store-write=${event.storeWrite}`);
  }
  if (event.backoffFailures !== undefined) {
    parts.push(`backoff-failures=${event.backoffFailures}`);
  }
  if (event.backoffRemainingMs !== undefined) {
    parts.push(`backoff-remaining=${event.backoffRemainingMs}ms`);
  }
  if (event.queueWaitMs !== undefined) {
    parts.push(`queue-wait=${event.queueWaitMs}ms`);
  }
  if (event.queuePriority !== undefined) {
    parts.push(`queue-priority=${event.queuePriority}`);
  }
  if (event.queueAhead !== undefined) {
    parts.push(`queue-ahead=${event.queueAhead}`);
  }
  if (event.recordSettleMs !== undefined) {
    parts.push(`record=${event.recordSettleMs}ms`);
  }
  if (event.entryBytes !== undefined) {
    parts.push(`entry=${event.entryBytes}b`);
  }
  return parts.join(" ");
}

/** The `debugShellCapture: true` console sink: one compact line per event. */
function consoleCaptureDebugSink(event: ShellCaptureDebugEvent): void {
  console.log(
    `[ShellCache][debug] ${event.key} ${describeShellCaptureEvent(event)}`,
  );
}

/**
 * Resolve the `debugShellCapture` router option to a callable sink, or
 * undefined when off. The INTERNAL_RANGO_DEBUG env-flag fallback lives HERE
 * (not at a call site) so every producer that resolves a sink inherits it;
 * an explicit `false` wins over the env flag.
 */
export function resolveShellCaptureDebugSink(
  option: ShellCaptureDebug | undefined,
): ((event: ShellCaptureDebugEvent) => void) | undefined {
  if (option === false) return undefined;
  if (option === true) return consoleCaptureDebugSink;
  if (typeof option === "function") return option;
  return INTERNAL_RANGO_DEBUG ? consoleCaptureDebugSink : undefined;
}

/**
 * Attempt-terminal outcomes recorded for the dev Server-Timing mirror. Skip
 * events are excluded so a later request's skip cannot overwrite the
 * interesting terminal event before a metrics-enabled request reads it.
 */
const TIMING_RECORDED_OUTCOMES = new Set<ShellCaptureDebugEvent["outcome"]>([
  "stored",
  "redirect",
  "no-shell",
  "refused",
  "expired",
  "error",
]);

/**
 * Dev-only last-terminal-event-per-key buffer backing the Server-Timing
 * mirror: the capture runs AFTER its triggering response is committed, so its
 * outcome can only ride a LATER response's header. rsc-rendering consumes this
 * on the next ppr GET for the key when the metrics store is active
 * (debugPerformance) and appends a `ppr:capture` Server-Timing entry. Dev-only
 * (isDevMode) so production isolates never grow the map; FIFO-capped because
 * with debugPerformance OFF nothing ever drains it, and a long dev session
 * sweeping many URLs would otherwise accumulate one entry per shell key
 * forever.
 */
const lastCaptureEventsForTiming = new Map<string, ShellCaptureDebugEvent>();
const MAX_TIMING_EVENT_KEYS = 100;

/**
 * Consume (read-and-clear) the buffered terminal capture event for `key`, so
 * one capture reports into exactly one later response's Server-Timing.
 */
export function takeCaptureDebugEventForTiming(
  key: string,
): ShellCaptureDebugEvent | undefined {
  const event = lastCaptureEventsForTiming.get(key);
  if (event) lastCaptureEventsForTiming.delete(key);
  return event;
}

/**
 * Publish one capture debug event: buffer terminal outcomes for the dev
 * Server-Timing mirror, then hand the event to the configured sink. A
 * throwing sink is swallowed — diagnostics must never fail a capture.
 */
function publishCaptureDebugEvent(
  descriptor: Pick<ShellCaptureDescriptor, "debugSink">,
  event: ShellCaptureDebugEvent,
): void {
  if (isDevMode() && TIMING_RECORDED_OUTCOMES.has(event.outcome)) {
    // Refresh insertion order for the FIFO cap, then evict the oldest key.
    lastCaptureEventsForTiming.delete(event.key);
    if (lastCaptureEventsForTiming.size >= MAX_TIMING_EVENT_KEYS) {
      const oldest = lastCaptureEventsForTiming.keys().next().value;
      if (oldest !== undefined) lastCaptureEventsForTiming.delete(oldest);
    }
    lastCaptureEventsForTiming.set(event.key, event);
  }
  const sink = descriptor.debugSink;
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // Diagnostics only: a throwing consumer sink must never fail the capture.
  }
}

/** Current backoff state fields for `key` (empty when no backoff entry). */
function backoffFields(
  key: string,
): Pick<ShellCaptureDebugEvent, "backoffFailures" | "backoffRemainingMs"> {
  const entry = refusedCaptures.get(key);
  if (!entry) return {};
  return {
    backoffFailures: entry.failures,
    backoffRemainingMs: Math.max(0, entry.until - Date.now()),
  };
}

export interface FlightCaptureGate {
  /** Identity passthrough of the source stream; feed this to captureShellHTML. */
  stream: ReadableStream<Uint8Array>;
  /**
   * Resolves once the source has been byte-quiet for FLIGHT_QUIET_HOPS macrotask
   * hops (or has closed — the DATA variant). At that instant the gate FREEZES:
   * no further source byte reaches the fizz side, and the readable is left open
   * (never closed / errored) so fizz postpones the still-pending references
   * instead of seeing "Connection closed".
   */
  quiesce: Promise<void>;
  /**
   * Stop the internal macrotask-hop loop. captureShellHTML's maxWaitMs bounds the
   * overall wait; dispose() is the clean shutdown for the pathological case where
   * the source never goes byte-quiet (quiesce never fires), so the hop loop would
   * otherwise keep rescheduling after captureShellHTML has already aborted and
   * returned.
   */
  dispose(): void;
}

/**
 * Wrap the capture Flight stream so the fizz shell prerender reads a stream that
 * (a) forwards the shell rows unchanged, (b) resolves `quiesce` after the rows go
 * byte-silent for FLIGHT_QUIET_HOPS macrotask hops, and (c) FREEZES at that
 * instant — dropping any later byte without closing or erroring the readable, so
 * the pending masked-loader references stay pending and fizz postpones them (the
 * "unclosing stream" property, here for free because the masked rows never emit).
 * Freezing also guarantees no post-quiesce byte — including an error row from any
 * later abort/cancel of the underlying render — can corrupt the frozen prelude.
 *
 * Quiet is measured in TASKS, not wall-clock: after the first byte a macrotask
 * hop loop compares a byte counter each turn and fires after K quiet turns. The
 * hop timers are unref'd so they never keep a Node process alive, and the source
 * closing (no holes) fires quiesce immediately for the DATA variant — the
 * TransformStream then closes the readable, so fizz completes with postponed null.
 *
 * Nothing the shell bakes can still be pending here: settleCaptureRecord already
 * waited for the top-level handle promises and the bake-lane loader containers
 * before the capture's Flight render began, so the handles row and the baked
 * loader rows emit at once and only the holes stay silent.
 */
export function gateFlightForCapture(
  source: ReadableStream<Uint8Array>,
): FlightCaptureGate {
  let resolveQuiet!: () => void;
  const quiesce = new Promise<void>((resolve) => {
    resolveQuiet = resolve;
  });

  let bytesSeen = 0;
  let armed = false;
  let settled = false;
  let disposed = false;
  let frozen = false;

  const fire = (): void => {
    if (settled) return;
    settled = true;
    frozen = true;
    resolveQuiet();
  };

  const scheduleHop = (fn: () => void): void => {
    const t = setTimeout(fn, 0);
    // Never let the quiet-detection hop alone keep a Node process alive
    // (no-op on workerd).
    (t as { unref?: () => void }).unref?.();
  };

  // The hop loop starts only after the first byte, so it can never declare
  // quiesce before fizz has begun pulling rows through the transform.
  const arm = (): void => {
    if (armed || settled || disposed) return;
    armed = true;
    let lastSeen = bytesSeen;
    let quiet = 0;
    const hop = (): void => {
      if (settled || disposed) return;
      if (bytesSeen === lastSeen) {
        quiet += 1;
        if (quiet >= FLIGHT_QUIET_HOPS) {
          fire();
          return;
        }
      } else {
        lastSeen = bytesSeen;
        quiet = 0;
      }
      scheduleHop(hop);
    };
    scheduleHop(hop);
  };

  const monitor = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Post-quiesce: drop the byte. Do NOT enqueue and do NOT close/error — the
      // frozen fizz input must stay a fixed byte set behind an open (unclosing)
      // readable so still-pending references postpone.
      if (frozen) return;
      bytesSeen += chunk.length;
      arm();
      controller.enqueue(chunk);
    },
    flush() {
      // Source closed with no freeze => DATA variant (no holes): quiet
      // immediately. The TransformStream then closes the readable, so fizz
      // completes and postponed comes back null.
      fire();
    },
  });

  return {
    stream: source.pipeThrough(monitor),
    quiesce,
    dispose(): void {
      disposed = true;
    },
  };
}

/**
 * The background shell-capture descriptor: everything the capture task needs to
 * store the shell. Built by the integrated PPR serve path (rsc-rendering.ts) from
 * the route's `ppr` path option (`PartialPrerenderProps`) and the app-level cache
 * store, and passed to scheduleShellCapture directly — it is NOT threaded through
 * the request context. `tags` carries the route's OPERATIONAL `ppr.tags`; the
 * capture UNIONS them with the shell's own auto-collected (non-loader) request
 * tags from its derived render (the collected set stays authoritative). That
 * union happens at the putShell WRITE BARRIER in captureAndStoreShell — after the
 * capture quiesces — not at stream construction, so a tag recorded after an await
 * in async shell content is still collected (issue #676). `store` is the same
 * store the serve path resolved for its getShell read (requestCtx._cacheStore),
 * so the capture writes where the serve reads.
 */
export interface ShellCaptureDescriptor {
  key: string;
  /**
   * The key's search portion (shellSearchSeed: `?`-prefixed sorted search,
   * cache.searchParams filter applied, or ""). Seeds the capture render's SSR
   * store so static-part `useSearchParams` reads bake markup consistent with
   * the shell's own key; the resume pass derives the identical string from
   * the HIT request. Computed next to the key so the two cannot drift.
   * Omitted (build-time bare-pathname captures) = search-less, same as "".
   */
  searchSeed?: string;
  /**
   * The scheduling request's origin, seeding the capture render's SSR store
   * location. Shell keys are host-scoped, so the resume pass's request
   * agrees modulo protocol drift; the seed keeps origin-dependent static
   * markup (Link's data-external) identical across capture, resume, and
   * browser hydration. Omitted (build-time host-agnostic captures) falls
   * back to the internal host.
   */
  originSeed?: string;
  /**
   * The RSC handler's build version (HandlerContext.version), stamped into the
   * stored entry as ShellCacheEntry.buildVersion — the serve-side
   * isValidShellHit gate compares it against the running build so a persistent
   * store can never resume a stale build's postponed blob.
   */
  buildVersion: string;
  ttl?: number;
  swr?: number;
  tags?: string[];
  /**
   * Per-route capture settle budget in ms (`ppr.captureTimeout`, resolved by
   * resolvePprConfig): the ONE deadline bounding the whole capture — the match,
   * the record-first settle (settleCaptureRecord), then the fizz prerender with
   * what is left (captureShellHTML's maxWaitMs). Undefined =
   * SHELL_CAPTURE_MAX_WAIT_MS (15_000).
   */
  captureTimeout?: number;
  store?: SegmentCacheStore<any>;
  /**
   * Cap (serialized UTF-8 bytes) on the entry's capture data snapshot; over it
   * the snapshot is skipped and the shell stored without it (reported once per
   * key). Absent = DEFAULT_PPR_MAX_SNAPSHOT_BYTES, applied in
   * captureAndStoreShell — the single defaulting site.
   */
  maxSnapshotBytes?: number;
  /**
   * Structured capture-pipeline debug sink, resolved from
   * `createRouter({ debugShellCapture })` (or INTERNAL_RANGO_DEBUG) via
   * {@link resolveShellCaptureDebugSink}. Receives one
   * {@link ShellCaptureDebugEvent} per attempt/skip.
   */
  debugSink?: (event: ShellCaptureDebugEvent) => void;
  /** Store the snapshot for navigation replay, never the captured HTML prelude. */
  navigationOnly?: true;
  /**
   * lastStoredCaptureSeq(key) when a document request read the store and
   * missed. The request schedules its capture only after rendering the MISS,
   * so a capture another request started can store in between; a later
   * sequence number then skips the redundant one (`skip-stored`), which would
   * re-render the page and drop the isolate's memo of the shell just stored.
   */
  storedSeqAtRead?: number;
}

/** Per key, the sequence number of its latest stored capture (bounded). */
const storedCaptureSeqs = new Map<string, number>();
const STORED_CAPTURE_SEQS_MAX = 1_000;
let storedCaptureSeq = 0;

/** The latest stored capture's sequence number for `key` in this isolate, or 0. */
export function lastStoredCaptureSeq(key: string): number {
  return storedCaptureSeqs.get(key) ?? 0;
}

function noteCaptureStored(key: string): void {
  storedCaptureSeqs.delete(key);
  if (storedCaptureSeqs.size >= STORED_CAPTURE_SEQS_MAX) {
    const oldest = storedCaptureSeqs.keys().next().value;
    if (oldest !== undefined) storedCaptureSeqs.delete(oldest);
  }
  storedCaptureSeqs.set(key, ++storedCaptureSeq);
}

/**
 * Schedule the background shell capture for a served document. Stampede-guarded:
 * one capture per key per isolate. Runs via runBackground (waitUntil on workerd,
 * fire-and-forget in Node dev), so the served response is never blocked on it. Any
 * error is routed through reportCacheError — capture is best-effort; a failure just
 * means the next request recaptures.
 *
 * Eligibility (nonce/partial/status/strategy) is decided by the caller. An SSR
 * module loader may be passed for cold partial requests; it runs only after the
 * capture enters the guarded background queue, never on response latency.
 */
export function scheduleShellCapture(
  ctx: HandlerContext<any>,
  request: Request,
  env: any,
  url: URL,
  reqCtx: RequestContext<any>,
  ssrModule:
    | SSRModule
    | ((request: Request, url: URL) => Promise<SSRModule | null>),
  descriptor: ShellCaptureDescriptor,
): void {
  const key = descriptor.key;
  const inFlight = inFlightCaptures.get(key);
  if (inFlight) {
    if (Date.now() - inFlight.startedAt <= SHELL_CAPTURE_TASK_HARD_CAP_MS) {
      publishCaptureDebugEvent(descriptor, { key, outcome: "skip-in-flight" });
      return;
    }
    // Older than the task hard cap: the owning task never settled (wedged
    // render, or workerd killed its context before the release ran). Treat the
    // key as abandoned and schedule a replacement — the set() below installs a
    // new token, and the stale task's token-guarded release can no longer
    // touch it.
  }
  if (
    descriptor.storedSeqAtRead !== undefined &&
    lastStoredCaptureSeq(key) > descriptor.storedSeqAtRead
  ) {
    publishCaptureDebugEvent(descriptor, { key, outcome: "skip-stored" });
    return;
  }
  // Refused/failed within the window → skip the doomed re-render (one probe per
  // key per window per isolate). Expired entries self-evict inside the check.
  if (isCaptureBackedOff(key)) {
    publishCaptureDebugEvent(descriptor, {
      key,
      outcome: "skip-backoff",
      ...backoffFields(key),
    });
    return;
  }
  // A capture whose write can only no-op is dead work that still occupies the
  // serialized queue (a promise-heavy route bakes for seconds per MISS),
  // starving captures that CAN store. Skip scheduling entirely when the
  // resolved store (same defaulting as captureAndStoreShell) has no shell
  // family or declared it inert (a custom-store escape hatch; built-in
  // stores never declare it — a KV-less CFCacheStore stores L1-only).
  const scheduledStore = descriptor.store ?? reqCtx._cacheStore;
  if (!scheduledStore?.putShell || scheduledStore.shellFamilyInert) {
    publishCaptureDebugEvent(descriptor, { key, outcome: "skip-inert-store" });
    return;
  }
  const guardToken: CaptureGuardToken = { startedAt: Date.now() };
  inFlightCaptures.set(key, guardToken);
  const captureTask = async (span: TraceSpan) => {
    // The guard's age counts from the task's start, not its scheduling: a
    // capture queued behind others (up to CAPTURE_QUEUE_WAIT_BUDGET_MS) is
    // not abandoned while its SSR setup loads.
    guardToken.startedAt = Date.now();
    try {
      // A navigation-only capture renders under document request identity:
      // its transport parameters and headers are stripped once, here, for the
      // SSR setup and every attempt.
      const captureUrl = descriptor.navigationOnly
        ? stripInternalParams(url)
        : url;
      const captureRequest = descriptor.navigationOnly
        ? createNavigationCaptureRequest(request, captureUrl)
        : request;
      const resolvedSsrModule =
        typeof ssrModule === "function"
          ? await ssrModule(captureRequest, captureUrl)
          : ssrModule;
      if (
        !resolvedSsrModule ||
        !resolvedSsrModule.resumeShellHTML ||
        !resolvedSsrModule.captureShellHTML
      ) {
        return;
      }
      // Hard-capped: ppr.captureTimeout bounds the attempt, but a match that
      // loses its deadline keeps running (no abort signal), and a handler
      // wedged on a never-settling upstream await would strand the stampede
      // guard and the queue slot (production pilot). The cap rejects, riding
      // the existing catch: backoff + reportCacheError + token-guarded
      // release. The abandoned attempt keeps running until its context dies;
      // nothing awaits it. From here the guard's age counts from the cap's
      // start, so a slow SSR setup does not shorten the capped run.
      guardToken.startedAt = Date.now();
      const outcome = await raceTaskHardCap(
        runShellCapture(
          ctx,
          captureRequest,
          env,
          captureUrl,
          reqCtx,
          resolvedSsrModule,
          descriptor,
        ),
        key,
      );
      span.setAttribute("rango.background.outcome", outcome);
      // Update the negative cache off the terminal outcome. A stored shell clears
      // any prior backoff; a `no-shell` (after the in-place retry) backs the key
      // off so the next requests don't re-probe it. A `redirect` has no shell but
      // is not a doomed render — leave the backoff untouched.
      if (outcome === "stored") {
        clearCaptureBackoff(key);
        // Only a document entry is the shell a document MISS read the store
        // for: document serving reads a navigation-only entry as a MISS, even
        // one a corrupt-snapshot heal stored under the document key.
        if (!descriptor.navigationOnly) noteCaptureStored(key);
      } else if (outcome === "no-shell") {
        markCaptureBackoff(key);
        publishCaptureDebugEvent(descriptor, {
          key,
          outcome: "backoff",
          ...backoffFields(key),
        });
      }
    } catch (error) {
      // Detached background task — pass reqCtx so onError still fires when the ALS
      // context is gone. A genuine failure recurs, so back it off too (re-probe
      // once per window, not every request) and report it once.
      markCaptureBackoff(key);
      span.setAttribute("rango.background.outcome", "error");
      publishCaptureDebugEvent(descriptor, {
        key,
        outcome: "error",
        ...backoffFields(key),
      });
      reportCacheError(error, "cache-write", "[ShellCache] capture", reqCtx);
    } finally {
      releaseCaptureGuard(key, guardToken);
    }
  };
  // Serialize capture EXECUTION per isolate (capture-queue.ts): concurrent
  // captures starve each other's task-quantized quiet windows — one grinding
  // capture makes the sibling freeze a trivial prelude and store nothing
  // (rotating eternal-MISS victims on GH runners). The stampede guard above
  // stays per-key (dedupe while queued); the queue is cross-key.
  //
  // The whole serialized task — queue wait INCLUDED — is wrapped in the
  // rango.background span (kind=shell-capture). The span is the explanatory
  // parent for the capture's platform KV/fetch/cache spans (the capture's own
  // rango.* phase spans stay suppressed — deriveShellCaptureContext strips
  // _tracing), and queue_wait_ms makes a capture parked behind a slow
  // predecessor link visible instead of reading as an unexplained dead gap
  // (observed in production: ~24s of zero I/O before capture start).
  // observePhase reads tracing off the ALS context captured when runBackground
  // registered the task — the foreground request context, tracing intact.
  const serializedTask = async () => {
    await observePhase(PHASES.background("shell-capture"), async (span) => {
      span.setAttribute("rango.shell_key", key);
      // A production page can enqueue several navigation-only captures through
      // viewport prefetching. Let a later document MISS overtake that queued
      // speculative work so it can become a shell HIT before the 15s queue
      // budget expires. Never preempts the active capture. Priority and the
      // backlog ahead at enqueue ride the span (and the skip event below), so
      // a skip-queue-timeout diagnoses itself instead of needing a trace dive.
      const queuePriority = descriptor.navigationOnly
        ? ("navigation" as const)
        : ("document" as const);
      const depths = captureQueueDepths();
      const queueAhead =
        (depths.running ? 1 : 0) +
        depths.document +
        (queuePriority === "navigation" ? depths.navigation : 0);
      span.setAttribute("rango.background.queue_priority", queuePriority);
      span.setAttribute("rango.background.queue_ahead", queueAhead);
      const queueStart = performance.now();
      try {
        await enqueueSerializedCapture(
          () => {
            span.setAttribute(
              "rango.background.queue_wait_ms",
              Math.round(performance.now() - queueStart),
            );
            return captureTask(span);
          },
          { priority: queuePriority },
        );
      } catch (error) {
        if (error instanceof CaptureQueueFullError) {
          releaseCaptureGuard(key, guardToken);
          span.setAttribute("rango.background.outcome", "skip-capacity");
          publishCaptureDebugEvent(descriptor, {
            key,
            outcome: "skip-capacity",
          });
          return;
        }
        if (error instanceof CaptureQueueWaitTimeoutError) {
          // Dropped unrun after waiting past the queue budget: no backoff (the
          // route is not doomed, the isolate was busy) — a later request
          // re-probes the key.
          releaseCaptureGuard(key, guardToken);
          span.setAttribute("rango.background.outcome", "skip-queue-timeout");
          span.setAttribute(
            "rango.background.queue_wait_ms",
            Math.round(error.waitedMs),
          );
          publishCaptureDebugEvent(descriptor, {
            key,
            outcome: "skip-queue-timeout",
            queueWaitMs: Math.round(error.waitedMs),
            queuePriority,
            queueAhead,
          });
          return;
        }
        throw error;
      }
    });
  };
  // The capture's own task must NOT enter reqCtx._pendingBackgroundTasks: the
  // capture drains that list before rendering (the write-barrier ordering edge),
  // and awaiting its own still-running promise would burn the whole barrier
  // deadline on every capture.
  (serializedTask as { [UNTRACKED_BACKGROUND_TASK]?: boolean })[
    UNTRACKED_BACKGROUND_TASK
  ] = true;
  runBackground(reqCtx, serializedTask);
}

/**
 * The ttl/swr a shell is stored with: the route's ppr policy, capped by the
 * route cache() records the capture replayed or wrote
 * (RequestContext._routeRecordWindow). A HIT replays the capture's handler
 * output, while a client navigation reads the route's cache() tier first, so
 * a shell that outlived its record would show a document request other
 * handler output than a navigation of the same URL. Freshness and total
 * lifetime are capped separately, like the record's own SWR: the shell is
 * fresh while the record is (at most `ttl`), and servable while the record
 * is (at most `ttl + swr`), so a record already inside its swr window yields
 * a shell that is stale from the start and serves while it recaptures.
 *
 * Whole seconds, rounded up (the SegmentCacheStore.putShell contract), so the
 * shell may outlast the record by under a second. Null when the record's
 * total lifetime has run out: the shell would be dead on arrival.
 */
export function capShellWindow(
  ttl: number,
  swr: number,
  record: Pick<RouteRecordWindow, "freshUntil" | "staleUntil">,
  now: number,
): { ttl: number; swr: number } | null {
  const total = Math.min(ttl + swr, (record.staleUntil - now) / 1000);
  if (!(total > 0)) return null;
  // At most `total`: freshUntil <= staleUntil and swr >= 0.
  const fresh = Math.max(0, Math.min(ttl, (record.freshUntil - now) / 1000));
  const wholeTtl = Math.ceil(fresh);
  return { ttl: wholeTtl, swr: Math.ceil(total) - wholeTtl };
}

/**
 * Warn once per route (dev and production) that no shell was stored because
 * the route cache() entry ran out before the capture could store one
 * (capShellWindow returned null) where a retry cannot help: the capture
 * wrote the entry itself (`written`), or the in-place retry's entry ran out
 * too, or no budget was left to retry. The key backs off like a refused
 * capture.
 */
function warnRecordRanOutOnce(
  route: string,
  record: RouteRecordWindow,
  detail: string,
): void {
  warnOnce(
    "record-ran-out",
    route,
    () =>
      `[rango] Route "${route}": its cache() entry (ttl ${record.ttl}, swr ` +
      `${record.swr}) ran out before the shell capture could store a shell ` +
      `(${detail}), so no shell is stored and the route renders without ` +
      "one. A shell never outlives the route cache() entry it replays: give " +
      "that cache() a ttl or swr longer than the capture takes, queue wait " +
      "included.",
  );
}

/**
 * A terminal `expired`: warn once per route with the record the attempt ran
 * out on, and return `no-shell` so the caller backs the key off.
 */
function expiredTerminal(
  attempt: CaptureAttemptStats,
  reason: string,
): "no-shell" {
  const expired = attempt.expired;
  if (expired) {
    warnRecordRanOutOnce(
      expired.route,
      expired.record,
      `${reason}; the last attempt took ${expired.captureMs} ms`,
    );
  }
  return "no-shell";
}

/**
 * The outcome of one capture attempt.
 * - `stored`: a usable shell was captured (and a putShell was attempted; a store
 *   I/O failure is reported separately and does NOT make the attempt retryable —
 *   the capture itself worked).
 * - `redirect`: the matched route redirects, so there is no shell to capture.
 * - `no-shell`: captureShellHTML returned null because the prelude was unusable
 *   or its private capture abort landed before the shell completed, or the
 *   capture ran out of ppr.captureTimeout. Retried once in place, when no
 *   deadline ran out (CaptureAttemptStats.noShellCause).
 * - `expired`: the route cache() record the capture read (not wrote) ran out
 *   before the store (capShellWindow null): it was near its end (its age,
 *   queue wait). Retried once in place, where a fresh match reads or renders
 *   a newer record; an `expired` retry, or no hard-cap budget left for the
 *   retry, is terminal `no-shell` (backoff, warned once per route).
 */
type CaptureAttemptOutcome =
  | "stored"
  | "redirect"
  | "no-shell"
  | "refused"
  | "expired";

/**
 * What a capture task ends with (runShellCapture): a refusal and a terminal
 * `expired` are `no-shell`, which the scheduler backs off.
 */
type CaptureTaskOutcome = "stored" | "redirect" | "no-shell";

function createNavigationCaptureRequest(request: Request, url: URL): Request {
  const headers = new Headers(requestHeaders(request));
  headers.set("accept", "text/html");
  for (const name of [
    "rsc-action",
    "x-rango-prefetch",
    "x-rango-state",
    "x-rsc-hmr",
    "x-rsc-router-client-path",
    "x-rsc-router-intercept-source",
  ]) {
    headers.delete(name);
  }
  return new Request(url, { method: request.method, headers });
}

/**
 * One attempt's record, filled along the capture path (barrier and deadline
 * causes in attemptCapture, the rest in captureAndStoreShell). runShellCapture
 * folds the observability fields into the attempt's
 * {@link ShellCaptureDebugEvent} and reads the rest to decide the retry and
 * the warning. A plain mutable bag, not a return value: captureAndStoreShell's
 * outcome type stays a string union producer B consumes unchanged.
 */
type CaptureAttemptStats = Pick<
  ShellCaptureDebugEvent,
  | "barrierWaitMs"
  | "writeSettleMs"
  | "preludeBytes"
  | "snapshotBytes"
  | "snapshotSkipped"
  | "untaggedBake"
  | "storeWrite"
  | "recordSettleMs"
  | "entryBytes"
> & {
  /**
   * Why a no-shell attempt ran out of ppr.captureTimeout (the match, the
   * handler output, or the prerender after them). A set cause skips the
   * in-place retry: the attempt's match may still be running.
   */
  noShellCause?: string;
  /**
   * Dev only: component stacks of the tasks still pending at a no-shell
   * attempt's abort, reported through prerender's onError (captureShellHTML's
   * onAbortedTask).
   */
  pendingStacks?: string[];
  /** The route cache() record an `expired` attempt ran out on. */
  expired?: { route: string; record: RouteRecordWindow; captureMs: number };
};

/**
 * Run the shell capture with a single in-place retry, then store the result.
 *
 * Each attempt re-derives EVERYTHING (fresh context, fresh router.match, fresh
 * Flight render) via {@link attemptCapture} — a capture consumes its handle store,
 * its request-tag set, and its one-shot Flight stream, so none of them are
 * reusable across attempts. A first attempt that comes back `no-shell` is almost
 * always a cold render (dev module transform / cold worker) that had not finished
 * when we froze the shell; the attempt itself warmed the module graph, so a second
 * attempt a short beat later usually completes the shell in the SAME background
 * task. That kills the old multi-request warmup where the caller had to re-issue
 * several HTTP requests before a capture stuck. We retry ONLY on `no-shell`
 * that did not run out of ppr.captureTimeout (CaptureAttemptStats.noShellCause),
 * and on `expired`; a genuine render error is NOT retried — it propagates to
 * scheduleShellCapture's reportCacheError. See docs/design/ppr-shell-resume.md.
 *
 * `request` and `url` are the capture's own identity (scheduleShellCapture
 * strips a navigation-only capture's transport parameters). `retryDelayMs` is
 * a parameter (defaulting to the module const) so unit tests can drive the
 * retry without a real 400ms wall-clock wait.
 */
async function runShellCapture(
  ctx: HandlerContext<any>,
  request: Request,
  env: any,
  url: URL,
  reqCtx: RequestContext<any>,
  ssrModule: SSRModule,
  descriptor: ShellCaptureDescriptor,
  retryDelayMs: number = SHELL_CAPTURE_RETRY_DELAY_MS,
): Promise<CaptureTaskOutcome> {
  const key = descriptor.key;

  // One attempt + its structured debug event: the stats object rides through
  // attemptCapture/captureAndStoreShell collecting the observability fields
  // (barrier wait, write-settle wait, prelude/snapshot bytes), and the event
  // folds them with the outcome. A genuine render error skips the attempt
  // event — scheduleShellCapture's catch publishes the terminal `error` event.
  const timedAttempt = async (
    attempt: number,
  ): Promise<{
    outcome: CaptureAttemptOutcome;
    stats: CaptureAttemptStats;
  }> => {
    const stats: CaptureAttemptStats = {};
    const start = performance.now();
    const outcome = await attemptCapture(
      ctx,
      request,
      env,
      url,
      reqCtx,
      ssrModule,
      descriptor,
      stats,
    );
    const { noShellCause, pendingStacks, expired, ...eventFields } = stats;
    publishCaptureDebugEvent(descriptor, {
      key,
      outcome,
      attempt,
      attemptMs: Math.round(performance.now() - start),
      ...eventFields,
    });
    return { outcome, stats };
  };

  const taskStartedAt = performance.now();
  const first = await timedAttempt(1);
  // "refused" is deterministic (identity guard / rejected bake-lane loader —
  // its own warning already fired): no retry, and the caller backs the key off
  // exactly like a structural no-shell.
  if (first.outcome === "refused") return "no-shell";
  if (first.outcome === "stored" || first.outcome === "redirect") {
    return first.outcome;
  }
  if (first.outcome === "expired") {
    // The record attempt 1 read ran out mid-capture: a fresh match reads or
    // renders a newer one. The whole task races SHELL_CAPTURE_TASK_HARD_CAP_MS,
    // so a retry that could not finish inside it (barrier + captureTimeout)
    // is not started.
    const retryBudgetMs =
      SHELL_CAPTURE_TASK_HARD_CAP_MS - (performance.now() - taskStartedAt);
    const retryNeedsMs =
      SHELL_CAPTURE_WRITE_BARRIER_MS +
      (descriptor.captureTimeout ?? SHELL_CAPTURE_MAX_WAIT_MS);
    if (retryBudgetMs < retryNeedsMs) {
      return expiredTerminal(first.stats, "no time was left to retry");
    }
  } else {
    // Attempt 1 ran out of ppr.captureTimeout (a cause is recorded): its
    // handlers may still be running (a match is not cancellable), and a retry
    // would start the same work beside them. A cold-module abort, the retry's
    // reason, ends well inside the deadline.
    if (first.stats.noShellCause !== undefined) {
      warnNullCaptureOnce(key, false, first.stats);
      return "no-shell";
    }
    // Attempt 1 produced no usable shell. Retry ONCE in place — the first
    // attempt warmed the dev transform graph / cold worker, so attempt 2
    // typically completes the shell without another HTTP request.
    await delay(retryDelayMs);
  }

  // The retry is the last attempt, so none of its outcomes is retried: an
  // `expired` retry is terminal like a no-shell one, not handed back to the
  // scheduler (which would neither back the key off nor warn).
  const second = await timedAttempt(2);
  if (second.outcome === "expired") {
    return expiredTerminal(
      second.stats,
      first.outcome === "expired" ? "twice in a row" : "on the in-place retry",
    );
  }
  if (second.outcome === "refused") return "no-shell";
  if (second.outcome !== "no-shell") return second.outcome;

  // Both attempts came back with no usable shell. Cold-start would have healed by
  // now, so the eternal-MISS structural shape (a boundary-less live-loader read;
  // lane rule: see resolveLoaderData, loader-cache.ts) is the likely cause —
  // warn once per key. Ordering matters: because the retry
  // absorbs cold-start, cold-start routes almost never reach this warning. The
  // caller (scheduleShellCapture) reads this `no-shell` return to back the key off.
  warnNullCaptureOnce(key, true, second.stats);
  return "no-shell";
}

/**
 * What the record-first step produced ({@link settleCaptureRecord}):
 * - `record`: the doc record settled; `match` carries its fragments in place
 *   of the handler layer's elements, so the capture's Flight payload is the
 *   bytes every HIT replays.
 * - `prerender`: the prerender store supplied the handler layer (a
 *   Prerender route); its HIT tail replays the same build-time segments, so
 *   the capture renders the match as is.
 * - `timeout`: handler output did not settle within the capture budget.
 * - `refused`: a deterministic refusal (a capture guard tripped, the route
 *   opted out, or the handler output failed); the warning already fired.
 */
export type CaptureRecordOutcome =
  | { kind: "record" | "prerender"; match: MatchResult }
  | { kind: "timeout"; reason: string }
  | { kind: "refused" };

/**
 * Record-first capture: the doc record is both the settle signal and the
 * parity source.
 *
 * Writing the record Flight-serializes every non-loader segment
 * (serializeSegments), which runs each handler's async server components and
 * waits for every promise the handler output carries — the capture's "is the
 * handler layer done" signal. Live-lane loader data is not in the record
 * (loader segments are excluded and their masked promises never settle), so
 * the wait never depends on a hole.
 *
 * The capture then renders its OWN Flight payload from the record's
 * fragments (fragmentSegments, the function a HIT tail uses) instead of from
 * the elements the match produced. Server components therefore render once
 * per capture, inside the record's encode: before this, the capture's Flight
 * render and the record's encode each ran them, so an uncached async
 * component showed one value in the prelude and another on every HIT.
 *
 * Order, all bounded by the one capture deadline (`ppr.captureTimeout`):
 * top-level handle promises, the handler pushes' nested promises, and the
 * bake-lane loader containers settle first (the record encodes the handles
 * a HIT restores, and its handle encode has its own 5s timeout that must
 * never be the one that fires); then the capture's onResponse callbacks fire
 * with a synthetic 200 (the implicit doc scope's cacheRoute, an explicit
 * scope's own write), and the deferred writes settle.
 */
export async function settleCaptureRecord(
  match: MatchResult,
  derivation: CaptureContextDerivation,
  capture: Pick<ShellCaptureDescriptor, "key">,
  deadline: number,
): Promise<CaptureRecordOutcome> {
  const { derivedCtx, freshHandleStore } = derivation;
  const recording = getRecordingStore(derivedCtx._cacheStore);

  // Seal so handleStore.settled resolves once the tracked handlers settle:
  // cacheRoute waits for it, and so does the capture's quiesce. It gates only
  // on tracked handlers, not on deferred handle values
  // (ctx.use(Handle).defer()), so a defer whose resolver depends on a masked
  // loader never settles and the wait below runs into the deadline instead.
  freshHandleStore.seal();
  const loaderRecords = derivedCtx._shellCaptureLoaderRecords;
  const settled = await raceDeadline(
    Promise.all([
      freshHandleStore.getData().then(resolveDeferredHandleValues),
      derivation.handlerPushesSettled(),
      loaderRecords && loaderRecords.size > 0
        ? Promise.allSettled([...loaderRecords.values()])
        : undefined,
    ]).catch(() => undefined),
    deadline,
  );
  // Past the deadline the record cannot settle in time: stop before its
  // write starts (no encode for a capture that already failed).
  if (!settled.done) {
    if (refuseOnCaptureGuard(capture.key, derivedCtx))
      return { kind: "refused" };
    return { kind: "timeout", reason: HANDLER_OUTPUT_TIMEOUT_REASON };
  }

  const callbacks = derivedCtx._onResponseCallbacks?.splice(0) ?? [];
  if (callbacks.length > 0) {
    const synthetic = new Response(null, { status: 200 });
    for (const cb of callbacks) {
      try {
        cb(synthetic);
      } catch {
        // A capture-time cache write that throws is degradation, not failure.
      }
    }
  }
  const drained = recording
    ? await recording.settleWrites(Math.max(0, deadline - Date.now()))
    : true;

  // Capture guards first: a tripped guard usually also fails the record,
  // and its own message names the cause.
  if (refuseOnCaptureGuard(capture.key, derivedCtx)) return { kind: "refused" };

  const docKey = derivedCtx._shellImplicitCache?.docKey;
  const record =
    recording && docKey !== undefined ? recording.getRecord(docKey) : undefined;
  if (
    !record ||
    !Array.isArray(record.segments) ||
    record.segments.length === 0
  ) {
    // Post-match serve-source truth (cache-lookup.ts tryPrerenderLookup).
    if (derivedCtx._pprReplayPostMatchReason === "prerender-store") {
      return { kind: "prerender", match };
    }
    if (!drained) {
      return { kind: "timeout", reason: HANDLER_OUTPUT_TIMEOUT_REASON };
    }
    warnCaptureRefusedOnce(capture.key, NO_DOC_RECORD_REASON);
    return { kind: "refused" };
  }

  // A handle encode that timed out stores "" (handle-snapshot.ts
  // encodeHandleValue). With every handler push settled above, that only
  // happens for a promise the walk does not reach (inside a Map, Set, or class
  // instance), which never settles in time on a retry either.
  if (!record.handles && recordSegmentsHaveHandles(record, freshHandleStore)) {
    warnCaptureRefusedOnce(
      capture.key,
      "a handle value the handler pushed did not finish encoding into the doc " +
        "record. A promise inside a Map, Set, or class instance is not awaited " +
        "before the encode; push plain objects and arrays.",
    );
    return { kind: "refused" };
  }

  const { fragmentSegments } = await import("../cache/segment-codec.js");
  const fragments = new Map(
    (await fragmentSegments(record.segments)).map((s) => [s.id, s]),
  );
  return {
    kind: "record",
    match: {
      ...match,
      segments: match.segments.map((segment) => {
        const fragment =
          segment.type === "loader" ? undefined : fragments.get(segment.id);
        return fragment
          ? {
              ...segment,
              component: fragment.component,
              layout: fragment.layout,
              loading: fragment.loading,
            }
          : segment;
      }),
    },
  };
}

/** Whether the handle store holds handler pushes for the record's segments. */
function recordSegmentsHaveHandles(
  record: CachedEntryData,
  handleStore: HandleStore,
): boolean {
  for (const segment of record.segments) {
    const id = segment?.metadata?.id;
    if (id === undefined) continue;
    const data = handleStore.getDataForSegment(id, true);
    for (const name in data) {
      if (data[name]!.length > 0) return true;
    }
  }
  return false;
}

/**
 * One capture attempt in a DERIVED request context.
 *
 * The derived context is `Object.create(reqCtx)` so it inherits the foreground's
 * post-middleware state (variables, cache store, env/request/url, waitUntil) while
 * overriding the render-scoped accumulators as own properties:
 *   - _handleStore: a fresh store. The foreground store is already drained to
 *     completion (its stream() flipped `completed` on settle) and would throw
 *     LateHandlePushError on any re-push. Every downstream reader resolves the
 *     store off the ambient context (setupLoaderAccess captures
 *     _getRequestContext()._handleStore; trackHandler reads it), so the fresh
 *     store on the derived context is what the capture match() writes handles to.
 *   - _requestTags: a fresh Set. The capture collects its OWN shell tags here —
 *     non-loader tags only, since loaders are masked — which is exactly the tag
 *     set a shell entry should be invalidatable by (loader tags belong to holes).
 *   - _shellCaptureRun: true — the switch loaders/cookies/headers guards read.
 *   - _dynamic / dynamic(): an own latch the capture reads.
 *   - _metricsStore: undefined so the capture never appends to the foreground's
 *     (already-finalized) metrics.
 *   - _renderBarrier family: an own barrier wired to the fresh handle store
 *     (wireRenderBarrier), plus _treeHasStreaming/deadlock-guard resets — the
 *     capture's rendered() lifecycle is its own, not the foreground's.
 *
 * The capture is MIXED-CHAIN: its match() behaves like a normal render with
 * respect to the segment cache — cache()'d segments replay from ring 3, UNCACHED
 * segments execute their handlers fresh (which is why the cookies()/headers()
 * capture guard is load-bearing). Middleware is NOT re-run: it already ran for the
 * triggering request, and the derived context inherits its post-middleware state
 * (guarding is serve-time; the shell is never served without the full chain).
 * After the match, {@link settleCaptureRecord} writes the doc record and the
 * capture renders from it.
 *
 * A FRESH context (and match/render) per attempt is what makes the retry sound:
 * the second attempt is a clean capture, not a resumption of the first.
 */
async function attemptCapture(
  ctx: HandlerContext<any>,
  request: Request,
  env: any,
  url: URL,
  reqCtx: RequestContext<any>,
  ssrModule: SSRModule,
  descriptor: ShellCaptureDescriptor,
  stats: CaptureAttemptStats,
): Promise<CaptureAttemptOutcome> {
  // WRITE BARRIER (ordering edge, not a narrower race): settle the foreground's
  // already-scheduled background tasks — its deferred ring-3/ring-1 cache writes —
  // BEFORE this attempt's match/render, so the capture's cache reads observe the
  // foreground's generation deterministically. Contract: a capture must never
  // clobber a ring-3 entry the foreground produced; with the barrier, the
  // capture's ring-3 lookup HITs the foreground's entry and REPLAYS it (handler
  // skipped, cache-store middleware's write path gated off by state.cacheHit), so
  // prelude, snapshot, and ring-3 agree on the foreground's generation. Runs per
  // attempt (the retry re-checks; already-settled promises are free).
  const barrierStart = performance.now();
  await settleTrackedBackgroundTasks(reqCtx, SHELL_CAPTURE_WRITE_BARRIER_MS);
  stats.barrierWaitMs = Math.round(performance.now() - barrierStart);

  const derivation = deriveShellCaptureContext(
    reqCtx,
    descriptor,
    descriptor.navigationOnly ? { request, url } : undefined,
  );
  const { derivedCtx, freshHandleStore } = derivation;
  // The capture generation starts before matching or any snapshot read
  // (ShellCacheEntry.createdAt): a tag invalidated after it wins.
  const captureStartedAt = Date.now();

  return runWithRequestContext(derivedCtx, async () => {
    // One deadline for the whole capture (see
    // PartialPrerenderProps.captureTimeout): the match (handlers, and the
    // loaders they await), then the record, then the prerender with what is
    // left. A match that loses it keeps running (no abort signal), so the
    // attempt records a cause and runShellCapture does not retry it.
    const deadline =
      Date.now() + (descriptor.captureTimeout ?? SHELL_CAPTURE_MAX_WAIT_MS);
    const matched = await raceDeadline(
      ctx.router.match(request, { env }),
      deadline,
    );
    if (!matched.done) {
      stats.noShellCause =
        "the handlers (or a loader a handler awaits) did not return within " +
        "ppr.captureTimeout";
      return "no-shell";
    }
    const match = matched.value;
    // A route that redirects has no shell to capture — bail (no store write, no
    // retry: a redirect is deterministic).
    if (match.redirect) return "redirect";

    setRequestContextParams(match.params, match.routeName);

    const settleStart = performance.now();
    const settled = await settleCaptureRecord(
      match,
      derivation,
      descriptor,
      deadline,
    );
    stats.recordSettleMs = Math.round(performance.now() - settleStart);
    if (
      process.env.NODE_ENV !== "production" &&
      settled.kind === "record" &&
      stats.recordSettleMs >= SHELL_CAPTURE_BAKE_WARN_MS
    ) {
      warnBakeCostOnce(
        descriptor.key,
        "the handler output (promises it passes or pushes, async server components)",
        stats.recordSettleMs,
      );
    }
    if (settled.kind === "refused") return "refused";
    if (settled.kind === "timeout") {
      stats.noShellCause = settled.reason;
      return "no-shell";
    }

    const payload = buildFullPayload(
      settled.match,
      ctx,
      url,
      derivedCtx,
      freshHandleStore,
    );
    const flightStage = renderRscFlightStage({
      ctx,
      request,
      env,
      url,
      payload,
      tracking: {
        mode: "full",
        routeKey: derivedCtx._routeName,
      },
    });

    // Pass the descriptor with its STATIC ppr.tags unchanged. The shell's own
    // render-recorded tags are snapshotted at the putShell WRITE BARRIER inside
    // captureAndStoreShell, not here: a tag recorded AFTER an await in async shell
    // content (and tags propagated by async cache()/"use cache" reads) lands after
    // this synchronous construction point, so snapshotting here dropped it — the
    // shell-tag snapshot must sit behind the quiesce gate (issue #676).
    const outcome = await captureAndStoreShell(
      ssrModule,
      flightStage.stream,
      derivedCtx,
      {
        ...descriptor,
        captureTimeout: Math.max(1, deadline - Date.now()),
      },
      captureStartedAt,
      stats,
    );
    if (outcome === "no-shell" && Date.now() >= deadline) {
      stats.noShellCause =
        "the shell render did not finish within what ppr.captureTimeout left " +
        `after the handler output settled (${stats.recordSettleMs}ms)`;
    }
    return outcome;
  });
}

/**
 * The derived capture context and its fresh (mask-funneled) handle store,
 * shared by BOTH shell producers: the runtime background capture
 * (attemptCapture, producer A) and the build-time prerender shell capture
 * (prerender/build-shell-capture.ts, producer B — issue #699). One
 * implementation so the capture semantics — the handle push funnel (handler
 * pushes settled, loader pushes masked), the capture guards, snapshot
 * recording, the implicit doc-cache scope — cannot drift between producers.
 */
export interface CaptureContextDerivation {
  derivedCtx: RequestContext;
  freshHandleStore: HandleStore;
  /**
   * Resolves once every handler handle push has settled at any depth of
   * plain objects and arrays (top-level promise, then the promises nested
   * in what it resolved to). The record-first step awaits it before the doc
   * record encodes its handles, so that encode never races a pending value.
   */
  handlerPushesSettled: () => Promise<void>;
}

/**
 * Derive the capture request context from a base context. Producer A passes
 * the foreground request's post-middleware context (the derived context
 * inherits its variables/env/cookie machinery through the prototype);
 * producer B passes a synthetic build-request context created by
 * createRequestContext over the build env, with a fresh MemorySegmentCacheStore
 * as `_cacheStore` so the recording/snapshot machinery arms identically.
 */
export function deriveShellCaptureContext(
  reqCtx: RequestContext<any>,
  descriptor: Pick<ShellCaptureDescriptor, "ttl" | "swr">,
  identity?: { request: Request; url: URL },
): CaptureContextDerivation {
  const freshHandleStore = createHandleStore();
  freshHandleStore.onError = reqCtx._handleStore.onError;
  // The capture handle store's push is the single funnel every push wrapper
  // (setupLoaderAccess, createUseFunction, prerender) goes through; the store
  // exists only for this capture attempt, so the foreground store is
  // untouched. Two lanes:
  //  - HANDLER pushes (outside a DSL loader scope: handler bodies, handler-
  //    invoked ctx.use(loader) bodies, defers) are handler output, baked like
  //    everything else the handler layer produces. They pass through
  //    unmasked; settleHandlerPush tracks each one so the record-first step
  //    (settleCaptureRecord) can wait for its promises, top-level and nested,
  //    before the doc record encodes the handles a HIT replays. A route
  //    cache() record's restore (handle-snapshot.ts restoreHandles) lands
  //    here too: a value it restores as a placeholder keeps that loader as
  //    owner, so a HIT restores it as that loader's (pushRestored).
  //  - DSL-LOADER pushes. Only bake-lane { ssr: false } loaders and the
  //    loaders they await via ctx.use execute at capture (live loaders are
  //    masked), their pushes are in the captured HTML (<head> title/meta,
  //    useHandle echoes), and a HIT does not run a promise-free bake-lane
  //    loader (loader-cache.ts), so the stored record carries them: each
  //    settled, thenable-free push from a loader body keeps that loader as
  //    `owner` (HandleStore.push), the record stores it
  //    (CachedEntryData.handleOwners), and a replay that serves the loader
  //    from its pin restores it through pushRestored (restoreHandles). Those
  //    copies stand: a promise-carrying bake-lane loader that runs on the
  //    replay reads the store, so its settled pushes (and those replayed
  //    inside its body) are dropped and only its thenable ones are added. A
  //    loader the replay does not serve from a pin is a hole: one the route
  //    also runs on the live lane, or one whose pin the entry lost. Its run
  //    replaces its copies (pushPlaceholder, #936), those of the
  //    dependencies it awaits included (they are credited to it). Nested
  //    thenables stay masked (the promise shape is the liveness
  //    declaration, mask-nested.ts). A deferred (thenable) push,
  //    one with masked nested promises, or one outside a loader body (a
  //    loader-cache replay names its loader: pushReplayed below) stays
  //    tagged (HandleStore.push loaderPush) so the
  //    handle encode cannot stall on a never-resolving mask. A tagged push
  //    is out of the record (captureHandles) and out of the capture's own
  //    render (resolvedHandleStream `recordedOnly`, issue #1035): the
  //    prelude is rendered from what the record keeps, which is what a HIT
  //    hydrates with. The loader records then carry `runs: 1` so a HIT runs
  //    those bodies for them, and what they push reaches the client after
  //    hydration (HandleStore.freezeDocumentSnapshot).
  const handlerPushSettles: Promise<void>[] = [];
  // A replay (a loader-cache HIT, loader-cache.ts replayLoaderHandles, or a
  // route cache() record's owned values, restoreHandles) re-pushes a loader's
  // recorded values through pushReplayed or pushPlaceholder, which call
  // push() outside any loader body: name that loader for the funnel so the
  // record keeps them under it too.
  let replayOwner: string | undefined;
  // The live-lane loader whose body a push is made in, at any depth, unless
  // a bake-lane loader's body is nearer (createMatchContextForFull sets the
  // lanes before any loader runs).
  // A replay of a live-lane loader's push (a "use cache" or loader cache()
  // hit a recapture makes inside a bake-lane body) is that hole's too.
  const liveLaneOwner = (): string | undefined => {
    const lanes = derivedCtx._shellCaptureLoaderLanes;
    if (!lanes) return undefined;
    return (
      findEnclosingLoaderBody(
        (id) => lanes.get(id) === "live",
        (id) => lanes.get(id) === "bake",
      ) ??
      (replayOwner !== undefined && lanes.get(replayOwner) === "live"
        ? replayOwner
        : undefined)
    );
  };
  for (const copy of ["pushReplayed", "pushPlaceholder"] as const) {
    const raw = freshHandleStore[copy].bind(freshHandleStore);
    freshHandleStore[copy] = (handleName, segmentId, value, loaderId) => {
      replayOwner = loaderId;
      try {
        raw(handleName, segmentId, value, loaderId);
      } finally {
        replayOwner = undefined;
      }
    };
  }
  const rawCapturePush = freshHandleStore.push.bind(freshHandleStore);
  freshHandleStore.push = (
    handleName: string,
    segmentId: string,
    value: unknown,
  ) => {
    if (!isInsideLoaderScope()) {
      handlerPushSettles.push(settleNestedThenables(value));
      rawCapturePush(handleName, segmentId, value, false, replayOwner);
      return;
    }
    let maskedNestedThenable = false;
    const mask = (v: unknown): unknown => {
      const report: MaskReport = { thenable: false };
      const masked = maskNestedContainerThenables(v, undefined, report);
      if (report.thenable) maskedNestedThenable = true;
      return masked;
    };
    let masked: unknown;
    let loaderPush = true;
    let owner: string | undefined;
    if (isThenable(value)) {
      // Deferred (thenable) loader pushes always keep the tag — the
      // carve-out below is for settled values only. Promise.resolve first: a
      // loader cache() entry replays a deferred push as the thenable Flight
      // decoded it to, whose then() returns nothing, and the slot was
      // `undefined` (the empty element of issue #1035).
      masked = Promise.resolve(value).then(mask);
    } else {
      masked = mask(value);
      if (!maskedNestedThenable) {
        // A settled, thenable-free push from a loader body is shell
        // material (see the funnel comment above): only bake-lane loaders
        // and the loaders they await run at capture, and a HIT does not run
        // a promise-free bake-lane loader (loader-cache.ts), so the record
        // keeps the push under the loader that made it. A push under a
        // live-lane loader's body, at any depth, is that hole's output: it
        // is credited to the hole, whose live run replaces it on a HIT and
        // a navigation. The first loader around the push that the route
        // registers decides: a bake-lane one keeps the push under the
        // innermost body, and a dependency on neither lane is walked past. A
        // replay of a hole's push is that hole's, unless a live-lane body
        // around it takes it first.
        const bodyLoaderId =
          liveLaneOwner() ?? getCurrentLoaderBodyId() ?? replayOwner;
        loaderPush = bodyLoaderId === undefined;
        if (!loaderPush) owner = bodyLoaderId;
      }
    }
    // A push the record cannot keep reaches a HIT only from a live run of
    // its loader, so the loader records ask for one (runs: 1).
    if (loaderPush) derivedCtx._shellCaptureUnrecordedLoaderPush = true;
    rawCapturePush(handleName, segmentId, masked, loaderPush, owner);
  };

  // The capture reuses the record keys its request resolved (CacheScope
  // resolveKeyFrom), read through the prototype: the map must exist on the
  // request before the derivation, or the capture would start its own and
  // run key() under the capture guard.
  reqCtx._resolvedCacheKeys ??= new Map();
  const derivedCtx: RequestContext = Object.assign(Object.create(reqCtx), {
    _handleStore: freshHandleStore,
    // The capture notes the route records it reads or writes itself; the
    // foreground's (a partial request's `partial:` record, say) are not the
    // ones this shell is captured from.
    _routeRecordWindow: undefined,
  });
  if (identity) {
    derivedCtx.request = identity.request;
    derivedCtx.url = identity.url;
    derivedCtx.originalUrl = new URL(identity.url);
    derivedCtx.pathname = identity.url.pathname;
    derivedCtx.searchParams = identity.url.searchParams;
  }
  // Own render barrier, closure-bound to the derived ctx and the fresh store
  // (issue #684, plan 009). Without this every _renderBarrier* read fell
  // through the prototype to the foreground's ALREADY-RESOLVED barrier: a
  // bake-lane loader's `await ctx.rendered()` resolved instantly and
  // ctx.use(handle) read the FOREGROUND handle snapshot — foreground
  // per-request handle data could bake into the shared shell. wireRenderBarrier
  // also resets _treeHasStreaming (recomputed for the capture's tree) and the
  // deadlock-guard fields as own properties.
  wireRenderBarrier(derivedCtx, freshHandleStore);
  derivedCtx._requestTags = new Set<string>();
  // Own explicit-store registry: cache-store resolutions during the capture
  // (the implicit scope's SnapshotOnlySegmentStore, any per-capture explicit
  // store instance) must NOT register into the handler-lifetime
  // _explicitTaggedStores set — a capture-ephemeral store pinned there would
  // trip the partial-tag-store warning on every later updateTag() and retain
  // the whole capture snapshot in memory. Capture registrations die with this
  // context; module-singleton stores stay registered by normal renders.
  derivedCtx._explicitTaggedStores = new Set();
  // Own list: the capture's render errors refuse the capture only, and the
  // foreground's never reach it.
  derivedCtx._renderErrors = [];
  derivedCtx._shellCaptureRun = true;
  // Own dynamic() latch. The inherited method writes the FOREGROUND context
  // (its closure), which already served, and nothing read it for a runtime
  // capture: handler code that opts out after an await (a handler promise the
  // capture now waits for) must refuse THIS capture instead
  // (settleCaptureRecord and captureAndStoreShell read _dynamic). The ppr
  // header latch is left alone: a capture's response is never sent.
  derivedCtx._dynamic = false;
  derivedCtx.dynamic = (): void => {
    derivedCtx._dynamic = true;
  };
  // Own-property reset: an inherited flag would make serializeSegments store
  // a double-encoded fragment. No current arming site reaches a capture
  // render (kept as defense-in-depth for a future one).
  derivedCtx._shellFragmentPayload = false;
  derivedCtx._metricsStore = undefined;
  // Spans, like perf metrics above, are a FOREGROUND surface: the capture
  // re-render must not emit a second rango.render/loader/ssr set after the
  // foreground rango.request span ended (orphan spans in the trace).
  // _tracing is otherwise inherited through Object.create(reqCtx).
  derivedCtx._tracing = undefined;
  // Bake-lane (`ssr: false`) loader containers, which execute during capture
  // (docs/design/loader-container-bake.md). resolveLoaderData registers each
  // container promise here; settleCaptureRecord waits for them, and the drain
  // in captureAndStoreShell elides + pins them into the snapshot's loader
  // family.
  derivedCtx._shellCaptureLoaderRecords = new Map();
  // Own onResponse list so the capture's match-middleware callbacks (the doc
  // record registers here) are ISOLATED from the foreground's shared array AND
  // can be fired by settleCaptureRecord. The segment write is gated behind
  // onResponse, which the capture never triggers (it builds no Response):
  // without the synthetic fire, no doc record is written.
  derivedCtx._onResponseCallbacks = [];

  // Capture data snapshot: route the capture's cache-store calls through a
  // recording wrapper on the DERIVED context's store (own property, so the
  // shared reqCtx._cacheStore is untouched — the snapshot is per-capture). It
  // records the doc segment record, which rides inside the ShellCacheEntry
  // with the bake-lane loader pins; no cache read is recorded. See
  // cache/shell-snapshot.ts and the design doc.
  //
  // Cache writes are deferred (waitUntil): the doc record's write would
  // otherwise land after the match returns. Override the derived context's
  // waitUntil to COLLECT those write promises (still forwarding to the parent
  // so the write persists and the worker stays alive), then
  // settleCaptureRecord and captureAndStoreShell await them before reading
  // the record and draining.
  if (reqCtx._cacheStore) {
    const recordingStore = new RecordingShellStore(reqCtx._cacheStore);
    derivedCtx._cacheStore = recordingStore;
    derivedCtx.waitUntil = (fn: () => Promise<void>): void => {
      const p = Promise.resolve().then(fn);
      recordingStore.trackWrite(p);
      reqCtx.waitUntil(() => p);
    };
    // The doc record (capture side): the implicit doc-cache scope makes the
    // capture's match write ALL matched non-loader segments as one doc-keyed
    // segment record — into the snapshot only (SnapshotOnlySegmentStore), so
    // the record dies with the shell entry and the next capture's lookup
    // still misses (handlers re-run on recapture). A route deriving its own
    // cache() scope keeps it, and recordShellCaptureDocRecord (cache-store.ts)
    // writes the same record for it.
    derivedCtx._shellImplicitCache = {
      ttl: descriptor.ttl,
      swr: descriptor.swr,
      store: new SnapshotOnlySegmentStore(recordingStore),
      keyPrefix: "doc",
    };
  }

  return {
    derivedCtx,
    freshHandleStore,
    handlerPushesSettled: () =>
      Promise.all(handlerPushSettles).then(() => undefined),
  };
}

/**
 * Derive the quiesce signal, prerender + abort via the SSR module's
 * captureShellHTML, and store the result. Runs after settleCaptureRecord (both
 * producers), which sealed the capture's handle store (`reqCtx._handleStore`)
 * and waited for everything the shell bakes. Returns the attempt outcome (the
 * caller owns retry/warn decisions). Never throws out of the store write: a
 * failed putShell is routed through reportCacheError so the background task
 * stays best-effort, and the attempt still counts as `stored` (the capture
 * worked; only the store I/O failed). `ssrModule.captureShellHTML` MUST be
 * present (eligibility is checked before scheduling). `captureStartedAt` is the
 * capture generation's start, stamped before the match (ShellCacheEntry
 * .createdAt).
 *
 * A `no-shell` result from captureShellHTML is the only retryable outcome. Every
 * captureShellHTML error propagates to reportCacheError and is NOT retried. The
 * capture handler converts only its own private abort sentinel to null before this
 * layer sees it.
 */
async function captureAndStoreShell(
  ssrModule: SSRModule,
  rscStream: ReadableStream<Uint8Array>,
  reqCtx: RequestContext<any>,
  capture: ShellCaptureDescriptor,
  captureStartedAt: number,
  stats: CaptureAttemptStats = {},
): Promise<Exclude<CaptureAttemptOutcome, "redirect">> {
  const captureShellHTML = ssrModule.captureShellHTML!;

  const gate = gateFlightForCapture(rscStream);
  // Quiesce = handles settled AND the Flight shell rows went task-quiet. Either
  // half stalling is bounded by captureShellHTML's maxWaitMs.
  const quiesce = Promise.all([reqCtx._handleStore.settled, gate.quiesce]).then(
    () => {},
  );

  // Deterministic capture-guard refusal (refuseOnCaptureGuard), checked at
  // BOTH exits below: the guard error either rejects the prerender itself
  // (boundary-less segment — lands in the catch) or is swallowed into
  // per-loader error UI (the render completes — caught after the try).
  const refuseOnGuardTrip = (): "refused" | undefined =>
    refuseOnCaptureGuard(capture.key, reqCtx) ? "refused" : undefined;

  // Dev diagnostics for a no-shell attempt (warnNullCaptureOnce): the stacks of
  // the tasks React reports as still pending at the capture's abort. React's
  // componentStack is computed on read, so it is read only while there is room.
  let pendingStacks: string[] | undefined;
  let onAbortedTask:
    | ((errorInfo: { componentStack?: string } | undefined) => void)
    | undefined;
  if (process.env.NODE_ENV !== "production") {
    const stacks: string[] = [];
    pendingStacks = stacks;
    onAbortedTask = (errorInfo) => {
      if (stacks.length >= MAX_PENDING_STACKS) return;
      const componentStack = errorInfo?.componentStack;
      if (componentStack && !stacks.includes(componentStack)) {
        stacks.push(componentStack);
      }
    };
  }

  try {
    // captureShellHTML CONSUMES the (gated) stream — it is not also SSR'd.
    let result: Awaited<ReturnType<typeof captureShellHTML>>;
    try {
      // One deadline for the whole capture — semantics spec'd on the option
      // (PartialPrerenderProps.captureTimeout, urls/pattern-types.ts).
      result = await observePhase(PHASES.ssr, () =>
        captureShellHTML(gate.stream, {
          quiesce,
          maxWaitMs: capture.captureTimeout ?? SHELL_CAPTURE_MAX_WAIT_MS,
          // The shell key's own search seeds the capture render's store —
          // static-part search reads bake what the key names.
          search: capture.searchSeed,
          origin: capture.originSeed,
          onError: (error) => {
            reqCtx._renderErrors?.push(error);
          },
          onAbortedTask,
        }),
      );
    } catch (error) {
      // Guard-tripped rejection arrives here (not at the drain), so refuse it
      // before propagating other capture errors.
      const refused = refuseOnGuardTrip();
      if (refused) return refused;
      // captureShellHTML converts its OWN deliberate abort to null by sentinel
      // identity. An escaped AbortError can therefore be a component's real
      // cancellation and must not be hidden or retried by name.
      throw error;
    }

    // null = sanity gate refused (trivial/empty prelude, no <body>). Store nothing
    // and report `no-shell` so the caller (runShellCapture) can retry once and, if
    // that also fails, warn once per key. On a cold render this is the shell not
    // yet finished; a boundary-less live-loader read (lane rule: see
    // resolveLoaderData, loader-cache.ts) is the structural eternal-MISS shape.
    // The caller's warning names both.
    // Guard check first — BEFORE the trivial-prelude retry path. A guard trip
    // is deterministic (retrying re-trips it), and when the tripping loader's
    // error UI still completed a shell, storing it would bake the failure into
    // a shared page.
    const refused = refuseOnGuardTrip();
    if (refused) return refused;

    if (result === null) {
      stats.pendingStacks = pendingStacks;
      return "no-shell";
    }
    stats.preludeBytes = result.prelude.length;

    // Drain the doc record from the recording store on the derived context.
    // The capture's own deferred cache writes ("use cache" and loader
    // cache() misses made while it rendered) settle first, bounded, so the
    // next HIT's holes find them in the store. When no recording store is
    // installed (unit tests that call this directly), the snapshot starts
    // empty.
    const recording = getRecordingStore(reqCtx._cacheStore);
    let snapshot: ShellSnapshotRecord[] = [];
    if (recording) {
      const settleStart = performance.now();
      await recording.settleWrites(SHELL_SNAPSHOT_WRITE_SETTLE_MS);
      stats.writeSettleMs = Math.round(performance.now() - settleStart);
      snapshot = recording.drainSnapshot() ?? [];
    }

    // Pin the bake-lane loader containers (loader family). Settled containers
    // are promise-elided (a still-pending nested promise is a hole marker, not
    // shell material) and Flight-serialized; a REJECTED container refuses the
    // capture — per-loader error UI must never bake into the shared shell. A
    // container still pending here either pinned the tree (the trivial-prelude
    // gate above already returned no-shell) or postponed under an ANCESTOR
    // boundary (it is a hole; omitting the record keeps it live).
    const loaderRecords = reqCtx._shellCaptureLoaderRecords;
    // Set once a bake-lane loader settles with real (non-hole) material: its data
    // is frozen into the shell prelude regardless of whether snapshot
    // serialization succeeds. Drives the opt-in debug metadata below.
    let bakedLoaderMaterial = false;
    if (loaderRecords && loaderRecords.size > 0) {
      // The codec import is deferred past the elide probes: a rejected record
      // refuses and a never-settled record is omitted WITHOUT touching Flight
      // (also keeps the virtual @vitejs/plugin-rsc import out of unit configs).
      let serializeContainer:
        | typeof import("../cache/segment-codec.js").serializeResult
        | undefined;
      // Capture-wide, read once: every record of this snapshot agrees.
      const runs: 0 | 1 = reqCtx._shellCaptureUnrecordedLoaderPush ? 1 : 0;
      for (const [segmentKey, containerPromise] of loaderRecords) {
        const elided = await elideLoaderContainer(containerPromise);
        if (elided.state === "rejected") {
          warnCaptureRefusedOnce(
            capture.key,
            `the loader for segment "${segmentKey}" rejected during capture; its error UI must not bake into the shared shell. ` +
              "Fix the loader, or drop its ssr: false to move it to the live lane.",
            PPR_LANE_HINT,
          );
          return "refused";
        }
        // The container itself never settled: it is a hole (under an ancestor
        // boundary) or the trivial-prelude gate already fired. Omit — no pin.
        if (isLoaderHoleMarker(elided.value)) continue;
        // redirect()/notFound() RESOLVE as ok:false envelopes
        // (wrapLoaderWithErrorHandling), so the rejection check above never
        // sees them; the tree builder resolves them to LoaderRedirect / the
        // not-found UI (segment-system buildLoaderStreams), which must not
        // bake into a shell every visitor shares.
        if (isSettledLoaderSignal(elided.value)) {
          warnCaptureRefusedOnce(
            capture.key,
            `the loader for segment "${segmentKey}" settled with redirect()/notFound() during capture; a request-specific signal must not bake into the shared shell. ` +
              "Drop its ssr: false to move it to the live lane, or move the decision into middleware.",
            PPR_LANE_HINT,
          );
          return "refused";
        }
        // Past the hole check: this container settled with real material that
        // bakes into the shell prelude (independent of the snapshot pin below).
        bakedLoaderMaterial = true;
        try {
          // serializeResult (not rscSerialize): null is a valid container and
          // must round-trip; serializeResult preserves it through Flight.
          serializeContainer ??= (await import("../cache/segment-codec.js"))
            .serializeResult;
          // A value Flight cannot encode (an async component that throws, a
          // rejected promise the elide walk does not reach, a function, a
          // class instance) completes with an error row instead of rejecting
          // (issue #927). Collected with the render's errors, so the check
          // after this drain refuses the capture.
          const serialized = await serializeContainer(elided.value, (error) => {
            reqCtx._renderErrors?.push(error);
          });
          if (serialized !== null) {
            snapshot.push({
              family: "loader",
              key: segmentKey,
              // The hole bit rides with the record so the HIT overlay knows
              // without rescanning whether the pin can resolve immediately
              // (holes: 0) or must wait for the fresh run's live promises
              // (holes: 1). See ShellSnapshotLoaderValue.
              value: {
                value: serialized,
                holes: elided.hasHole ? 1 : 0,
                runs,
              },
            });
          }
        } catch {
          // Codec import failed: leave it unpinned (it drifts on a HIT, the
          // pre-snapshot behavior) rather than failing the capture.
        }
      }
    }

    // A prerender-served capture (settleCaptureRecord `prerender`) has no doc
    // record, and the prerender store's build-time entry holds no loader
    // push: the loader-owned pushes the prelude rendered are kept in a
    // `handles` record, in the doc record's format, which the HIT restores
    // after the prerender store's handles (cache-lookup.ts yieldFromStore,
    // issue #1057). Its encode errors refuse the capture with the render's.
    const docKey = reqCtx._shellImplicitCache?.docKey;
    let prerenderHandles: ShellSnapshotHandlesValue | undefined;
    if (!capture.navigationOnly && !hasDocRecord(snapshot, docKey)) {
      const handleStore = reqCtx._handleStore;
      const segmentIds = new Set<string>();
      for (const bySegment of Object.values(await handleStore.getData())) {
        for (const id in bySegment) segmentIds.add(id);
      }
      const { handles, owners } = captureOwnedHandles(segmentIds, handleStore);
      prerenderHandles = {
        handles: await encodeHandles(handles, (error) => {
          reqCtx._renderErrors?.push(error);
        }),
        handleOwners: owners,
      };
    }

    // A shell component that threw inside a Suspense boundary does not reject
    // the capture: Flight and Fizz report it through onError and the prelude
    // carries the errored boundary, which every HIT would serve (issue #915).
    // The drain's container encode adds its Flight errors here too (#927).
    // After the loader drain so a rejected bake-lane loader keeps its specific
    // refusal. Thrown like a fatal shell error: no retry, reportCacheError and
    // backoff in scheduleShellCapture.
    const renderErrors = reqCtx._renderErrors;
    if (renderErrors && renderErrors.length > 0) throw renderErrors[0];

    // Store only what a HIT reads (issue #941): the doc record and, for a
    // document entry, the bake-lane loader pins. Before the size guards, so
    // they measure what is stored.
    let prunedRecords: string | undefined;
    const { kept, pruned } = pruneShellSnapshot(
      snapshot,
      capture.navigationOnly === true,
      docKey,
    );
    if (pruned.length > 0) {
      prunedRecords = countSnapshotFamilies(pruned);
      snapshot = kept;
    }

    // Snapshot size guard (issue #651): `maxSnapshotBytes` bounds the loader
    // pins; over it they are dropped and the entry keeps its doc record, so
    // every HIT still replays the handler layer (the pins' loaders then run
    // on the HIT: documented drift, repaired client-side). The doc record is
    // exempt: without it a HIT could not serve at all. The whole entry is
    // bounded separately below, by the store's value limit.
    if (snapshot.length > 0) {
      const docRecord =
        docKey !== undefined
          ? snapshot.find((r) => r.family === "segment" && r.key === docKey)
          : undefined;
      const pins = docRecord
        ? snapshot.filter((r) => r !== docRecord)
        : snapshot;
      const pinBytes =
        pins.length > 0
          ? SNAPSHOT_BYTE_ENCODER.encode(JSON.stringify(pins)).length
          : 0;
      stats.snapshotBytes = pinBytes;
      const cap = capture.maxSnapshotBytes ?? DEFAULT_PPR_MAX_SNAPSHOT_BYTES;
      if (pinBytes > cap) {
        warnSnapshotOverCapOnce(capture.key, pinBytes, cap);
        snapshot = docRecord ? [docRecord] : [];
        stats.snapshotSkipped = true;
      }
    }
    // Exempt from the cap like the doc record it stands in for: without the
    // pins the HIT restores these as placeholders the loaders' runs replace.
    if (prerenderHandles) {
      snapshot.push({
        family: "handles",
        key: SHELL_HANDLES_RECORD_KEY,
        value: prerenderHandles,
      });
    }

    // settleCaptureRecord refused every capture without a doc record except a
    // prerender-served one (the prerender store supplies its handler layer on
    // every HIT), and the record survives the drain, the pruning and the size
    // cap above.
    const storedDocKey = hasDocRecord(snapshot, docKey) ? docKey : undefined;

    // Shell tags: what the shell renders from, and nothing else. The handler
    // layer is the doc record, whose tags are what its content recorded (the
    // handlers, the server components its serialization rendered, the loaders
    // they consumed, the handle values; cache-scope.ts collectRecordTags), or
    // what a replayed route cache() record carried (recordSegmentTags). So a
    // capture that rendered fresh and one that replayed the route's record
    // store the same tags. Bake-lane loaders add theirs (SHELL_BAKE_TAG_OWNER):
    // their data is in the shell, and no handler reads it. A live-lane loader
    // never runs at capture, and one whose cache() config tags are recorded
    // anyway is a hole's, so request-level tags are not the source. Read at
    // the write barrier: the record settled and the deferred writes were
    // awaited, so a tag recorded after an await (#676) is in. A capture
    // without a doc record (the prerender store served its match) keeps the
    // request-level set. Union with the route's static ppr.tags.
    const docRecordValue = storedDocKey
      ? (snapshot.find((r) => r.family === "segment" && r.key === storedDocKey)
          ?.value as CachedEntryData | undefined)
      : undefined;
    const collected = docRecordValue
      ? [
          ...(docRecordValue.tags ?? []),
          ...getSegmentTags(reqCtx, SHELL_BAKE_TAG_OWNER),
        ]
      : [...reqCtx._requestTags];
    const union = new Set<string>([...(capture.tags ?? []), ...collected]);
    const shellTags = union.size > 0 ? [...union] : undefined;

    // Whole-entry guard: the prelude, postponed state, snapshot, and tags
    // travel in one stored value. Over the store's limit (Cloudflare KV:
    // 25 MiB) the write would fail inside waitUntil and every MISS would
    // recapture, so refuse here (the key backs off) instead. Measured as the
    // stores write it (estimateShellEntryBytes): the postponed state rides a
    // JSON head as an escaped string.
    const entryBytes = estimateShellEntryBytes({
      // A navigation-only entry stores no document half.
      preludeBytes: capture.navigationOnly ? 0 : result.prelude.length,
      postponed: capture.navigationOnly ? undefined : result.postponed,
      snapshot,
      tags: shellTags,
      docKey: storedDocKey,
      prunedRecords: snapshot.length > 0 ? prunedRecords : undefined,
    });
    stats.entryBytes = entryBytes;
    const entryLimit =
      (capture.store ?? reqCtx._cacheStore)?.maxShellEntryBytes ??
      DEFAULT_SHELL_ENTRY_MAX_BYTES;
    if (entryBytes > entryLimit) {
      warnCaptureRefusedOnce(
        capture.key,
        `the shell entry is ${entryBytes} bytes (prelude, postponed state, ` +
          `snapshot, and head), over the store's ${entryLimit}-byte value limit. ` +
          "Shrink the page the shell bakes, or move large regions under a live " +
          "loader's boundary.",
      );
      return "refused";
    }

    // Missing tags are valid: the shell follows TTL/SWR-only invalidation. Expose
    // that choice only to operators who enabled structured capture diagnostics.
    if (capture.debugSink && bakedLoaderMaterial && shellTags === undefined) {
      stats.untaggedBake = true;
    }

    const store = capture.store ?? reqCtx._cacheStore;
    if (store?.putShell) {
      try {
        const entry: ShellCacheEntry = {
          // Document half only for document captures. A navigationOnly entry's
          // HTML is never served (document reads skip the flag; partial replay
          // consumes only snapshot/docKey), so storing it would ride every KV
          // write/read as dead weight — the prerender still ran above as the
          // completeness arbiter and sanity gate, its output is dropped here.
          ...(capture.navigationOnly
            ? {}
            : {
                // bytesToBase64 encodes the view's own region, so a prelude
                // that is a subarray of a larger buffer encodes correctly.
                prelude: bytesToBase64(result.prelude),
                postponed: result.postponed,
              }),
          reactVersion: React.version,
          buildVersion: capture.buildVersion,
          // The theme this capture's payload was built with (buildFullPayload
          // reads payloadInitialTheme off the derived context: the no-cookie
          // default, #971). The serve tail replays it so the resume tree
          // matches the frozen prelude — see ShellCacheEntry.initialTheme.
          initialTheme: payloadInitialTheme(reqCtx),
          snapshot,
          prunedRecords: snapshot.length > 0 ? prunedRecords : undefined,
          // The canonical doc segment record's key, published by the doc
          // scope's cacheRoute during this capture's match. Every HIT tail
          // looks the record up by this key (serveShellHit fixedDocKey);
          // undefined only for a prerender-served entry.
          docKey: storedDocKey,
          navigationOnly: capture.navigationOnly,
          createdAt: captureStartedAt,
        };
        // Capped to the route record the capture used: the policy the
        // store would apply (resolveTtl/resolveSwrWindow, as putShell does),
        // made explicit.
        const record = reqCtx._routeRecordWindow;
        let window: { ttl?: number; swr?: number } = {
          ttl: capture.ttl,
          swr: capture.swr,
        };
        if (record) {
          const capped = capShellWindow(
            resolveTtl(capture.ttl, store.defaults, DEFAULT_FUNCTION_TTL),
            resolveSwrWindow(capture.swr, store.defaults),
            record,
            Date.now(),
          );
          if (!capped) {
            // Dead on arrival, not stored. A record this attempt wrote ran
            // out between its write and the store, which a retry repeats:
            // warn, refuse, back off. A record it read was near its end (its
            // age, queue wait): `expired` retries on a fresh match.
            const route = reqCtx._routeName ?? capture.key;
            if (record.written) {
              const sinceWriteMs =
                Date.now() - (record.freshUntil - record.ttl * 1000);
              warnRecordRanOutOnce(
                route,
                record,
                `${sinceWriteMs} ms after this capture wrote it`,
              );
              return "refused";
            }
            stats.expired = {
              route,
              record,
              captureMs: Date.now() - captureStartedAt,
            };
            return "expired";
          }
          window = capped;
        }
        const storeWrite = await store.putShell(
          capture.key,
          entry,
          window.ttl,
          window.swr,
          shellTags,
        );
        if (storeWrite) stats.storeWrite = storeWrite;
        if (storeWrite === "invalidated") {
          warnCaptureRefusedOnce(
            capture.key,
            "one of the shell's tags was invalidated after this capture generation started, so the store rejected the write. " +
              "If capture code deterministically calls updateTag() on its own shell tag, move that mutation out of the render; " +
              "otherwise every generation is invalidated before it can be served.",
          );
          return "refused";
        }
        if (storeWrite === "uncacheable") {
          // The store declared the entry unstorable under its current
          // configuration — every retry would refuse identically, so back
          // the key off like any refused capture instead of burning a full
          // serialized render per MISS. Store-neutral on purpose: the
          // acknowledging store emits its own diagnostic naming the specific
          // limit (CFCacheStore warns about the over-limit Cache-Tag set).
          warnCaptureRefusedOnce(
            capture.key,
            "the store cannot cache this shell under its current configuration and acknowledged " +
              "the write as permanently refusable, so the key is backed off. See the cache store's " +
              "own warning for the specific limit and remedy.",
          );
          return "refused";
        }
      } catch (error) {
        // Best-effort: a failed put must never throw out of the background task.
        reportCacheError(
          error,
          "cache-write",
          "[ShellCache] capture put",
          reqCtx,
        );
      }
    }
    // A shell was captured (ordinary store I/O failure is reported, not retried).
    // An acknowledged invalidation rejection returned `refused` above so the
    // scheduler backs the key off instead of recapturing on every request.
    return "stored";
  } finally {
    // Stop the hop loop for the pathological never-quiets path (quiesce never
    // fired, capture returned via maxWaitMs). On the normal path the loop already
    // stopped when it fired quiesce; dispose() is then a no-op.
    gate.dispose();
  }
}

// Exported for unit tests that drive the capture core directly, and — with the
// cold-graph retry pieces — for producer B (prerender/build-shell-capture.ts),
// which mirrors the runtime capture's retry-in-place with the same delay.
export {
  runShellCapture,
  captureAndStoreShell,
  delay,
  SHELL_CAPTURE_RETRY_DELAY_MS,
};

// Exported for unit tests that pin the refused-capture backoff policy directly
// (dev cap vs production exponential growth, stored-clears, cold-start re-probe).
// These are the same module-level functions the schedule path uses; a test that
// drove them through a real capture round-trip could not assert the exact window
// arithmetic without a full cold render.
export {
  isCaptureBackedOff,
  markCaptureBackoff,
  clearCaptureBackoff,
  REFUSED_CAPTURE_BASE_MS,
  REFUSED_CAPTURE_MAX_MS,
  REFUSED_CAPTURE_DEV_MAX_MS,
};

/**
 * @internal Reset this module's per-isolate state: the capture stampede
 * guard, the refused-capture backoff, the once-per-key warnings (the shell
 * path's one registry), the stored-capture sequence and the buffered debug
 * events. Tests only (testing/serve-shell-request.ts resetShellTestState),
 * between requests, never while a capture runs.
 */
export function resetShellCaptureStateForTests(): void {
  inFlightCaptures.clear();
  refusedCaptures.clear();
  resetShellWarningsForTests();
  storedCaptureSeqs.clear();
  lastCaptureEventsForTiming.clear();
}
