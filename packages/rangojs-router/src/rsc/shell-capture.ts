/**
 * PPR shell capture orchestration (Axis 2, see docs/design/ppr-shell-resume.md).
 *
 * Capture does NOT flow through the HTTP middleware pipeline. The integrated PPR
 * serve path (rsc-rendering.ts + shell-serve.ts) builds a ShellCaptureDescriptor
 * from the route's `ppr` path option after the served response is built and calls
 * scheduleShellCapture. The capture then runs as a background task that re-derives
 * the page via `ctx.router.match()` under its OWN derived request context — fresh
 * handle store, `_shellCaptureRun: true` so loaders mask (loader-mask.ts) and every
 * loading() subtree postpones. The render is MIXED-CHAIN: cache()'d segments replay
 * from ring 3, uncached segments execute their handlers fresh. It drives the static
 * prerender to a quiescent shell, aborts to freeze the prelude + postponed state,
 * and stores the pair via putShell. Because it uses match() rather than the HTTP
 * pipeline, the middleware chain (auth, logging) never re-runs — it already ran for
 * the triggering request, and the derived context inherits its post-middleware
 * state (variables, cache store). Guarding is serve-time.
 */

import React from "react";
import { bufferToBase64 } from "../cache/cf/cf-base64.js";
import { reportCacheError } from "../cache/cache-error.js";
import { runBackground } from "../cache/background-task.js";
import { enqueueSerializedCapture } from "./capture-queue.js";
import { SHELL_CAPTURE_MAX_WAIT_MS } from "./shell-capture-constants.js";
import { INTERNAL_RANGO_DEBUG } from "../internal-debug.js";
import { observePhase, PHASES } from "../router/instrument.js";
import {
  runWithRequestContext,
  setRequestContextParams,
  wireRenderBarrier,
  UNTRACKED_BACKGROUND_TASK,
  type RequestContext,
} from "../server/request-context.js";
import { createHandleStore, type HandleStore } from "../server/handle-store.js";
import {
  maskNestedContainerThenables,
  type MaskReport,
} from "../router/segment-resolution/mask-nested.js";
import { isInsideLoaderScope } from "../server/context.js";
import { isThenable } from "../handles/is-thenable.js";
import type {
  ShellCacheEntry,
  SegmentCacheStore,
  ShellSnapshotRecord,
} from "../cache/types.js";
import {
  elideLoaderContainer,
  isLoaderHoleMarker,
} from "../router/segment-resolution/loader-snapshot.js";
import {
  RecordingShellStore,
  SnapshotOnlySegmentStore,
  getRecordingStore,
} from "../cache/shell-snapshot.js";
import type { HandlerContext } from "./handler-context.js";
import type { SSRModule } from "./types.js";
import { buildFullPayload } from "./full-payload.js";
import { resolveDeferredHandleValues } from "../handles/deferred-resolution.js";
import { renderRscFlightStage } from "./render-pipeline.js";

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
 * window (the masked loaders, and any genuinely pending I/O) becomes a hole. The
 * only residual is raw per-request I/O rendered directly in shell (not via a
 * loader) that resolves inside the window — a documented shell anti-pattern; put
 * per-request data in loaders. See docs/design/ppr-shell-resume.md.
 */
const FLIGHT_QUIET_HOPS = 2;

/**
 * Default capture budget. Canonical value, raise rationale, and ceiling math
 * live on the leaf module (shell-capture-constants.ts, importable from the ssr
 * graph too). Re-exported here so shell-build-manifest.ts's envelope math
 * keeps its existing import site and cannot drift from the capture.
 */
export { SHELL_CAPTURE_MAX_WAIT_MS };

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
 * ITERATIVELY: a settled task can have scheduled a nested one (cache-store's
 * cacheRoute outer task schedules the actual store.set in a second waitUntil), so
 * each awaited batch may append more. Loop until no new tasks appear or the
 * deadline passes. The capture's own task never enters the list
 * (UNTRACKED_BACKGROUND_TASK), so the loop terminates.
 */
async function settleTrackedBackgroundTasks(
  reqCtx: RequestContext<any>,
  timeoutMs: number,
): Promise<void> {
  const tasks = reqCtx._pendingBackgroundTasks;
  if (!tasks) return;
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (tasks.length > seen) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const batch = tasks.slice(seen);
    seen = tasks.length;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
      (timer as { unref?: () => void }).unref?.();
    });
    await Promise.race([Promise.allSettled(batch).then(() => {}), guard]);
    if (timer) clearTimeout(timer);
  }
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
 * Module-level in-flight key set: the stampede guard for background captures, and
 * its single owner. One capture runs per key per isolate; concurrent MISS/stale
 * requests for the same key coalesce onto the first (the rest see the key present
 * in scheduleShellCapture and skip). Added when a capture is scheduled and cleared
 * in the task's finally once it settles, so a later request can recapture when TTL
 * rolls. Living here (not split across the middleware) keeps the add/clear
 * lifecycle in one layer.
 */
const inFlightCaptures = new Set<string>();

/**
 * Refused-capture backoff bounds. The window is EXPONENTIAL in the consecutive
 * failure count: `min(BASE * 2^(failures-1), ceiling)` — 1s, 2s, 4s, … up to the
 * mode's ceiling (60s in production, {@link REFUSED_CAPTURE_DEV_MAX_MS} in dev).
 *
 * Why exponential and not a flat 60s: a flat long window conflates two very
 * different failures. A STRUCTURALLY ineligible route (no loading(), a cookie
 * reader) fails forever and wants the long 60s cap. But a cold-but-ELIGIBLE route
 * can also fail the in-place retry under a truly cold graph (dev module transform,
 * or a cold worker under parallel load) — and it must recover FAST, on the next
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
 * Keys already warned about a refused (null) capture, so the eternal-MISS shape
 * logs once per key per isolate instead of on every request.
 */
const warnedNullCaptures = new Set<string>();

/**
 * Warn once per key that a capture produced no usable shell EVEN AFTER the
 * in-place retry (runShellCapture attempt 2). Naming both causes with the
 * distinguishing signal — does the route ever flip to HIT — is the whole point:
 * the pre-retry version blamed "a loader route without loading()" unconditionally
 * and misled users whose route DID have loading() and was merely cold. Because the
 * retry already absorbs the cold-start case, by the time this fires cold-start has
 * usually healed, so a firing warning leans toward the structural cause — but we
 * still name both so a cold-start straggler is not misdiagnosed.
 *
 * The pointer is shipped-path-safe (a05c8251 convention): the /ppr skill ships in
 * the npm tarball, but docs/design/ is repo-only, so link it by absolute GitHub URL
 * rather than a relative path that dead-ends for consumers.
 */
function warnNullCaptureOnce(key: string): void {
  if (warnedNullCaptures.has(key)) return;
  warnedNullCaptures.add(key);
  console.warn(
    `[rango] Shell capture for "${key}" produced no usable shell after an in-place ` +
      "retry; nothing was stored, so this request stays on MISS. Causes, told apart " +
      "by whether the route ever flips to HIT:\n" +
      "  1. Cold-start warmup (dev module transform, or a cold worker): the capture raced " +
      "an unfinished shell render. This SELF-HEALS — the route flips to HIT once a later " +
      "request warms the modules. Usually nothing to do.\n" +
      "  2. Something suspends above <body> with no Suspense boundary and never settles " +
      "within the capture window: a slower-than-the-capture-guard bake-lane loader " +
      "(loaders on entries WITHOUT loading() execute at capture and their containers " +
      "bake — the boundary-less await must settle for a shell to exist), or a pending " +
      "promise consumed without a <Suspense> above it. The boundary belongs on the " +
      "entry/component that OWNS the data: loading() on the entry that registers the " +
      "loader (a child route's loading() does not unpin a parent layout's loaders), or " +
      "a <Suspense> above the consuming component.\n" +
      'See the /ppr skill (node_modules/@rangojs/router/skills/ppr/SKILL.md), "The hole ' +
      'doctrine" and "The layout-with-loaders playbook", or the design docs: ' +
      "https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/design/ppr-shell-resume.md",
  );
}

/** Keys already warned about a deterministic capture refusal (once per key). */
const warnedRefusedCaptures = new Set<string>();

/**
 * Warn once per key that the capture was REFUSED for a deterministic reason
 * (identity-guard trip or a rejected bake-lane loader). Distinct from
 * warnNullCaptureOnce: these are not cold-start shapes, the retry is skipped,
 * and the message carries the concrete cause instead of a differential.
 */
function warnCaptureRefusedOnce(key: string, reason: string): void {
  if (warnedRefusedCaptures.has(key)) return;
  warnedRefusedCaptures.add(key);
  console.warn(
    `[rango] Shell capture for "${key}" was refused: ${reason}\n` +
      "The route stays on MISS (axis 1) — the page keeps working, only the shell " +
      "cache is off. See the /ppr skill " +
      "(node_modules/@rangojs/router/skills/ppr/SKILL.md) and " +
      "docs/design/loader-container-bake.md.",
  );
}

/** Keys already warned about untagged bake-lane data baked into the shell. */
const warnedUntaggedShellBakes = new Set<string>();

/**
 * Warn once per shell key that a bake-lane loader baked material into the shell
 * but the capture recorded ZERO tags (no render-collected _requestTags, no
 * static ppr.tags). Such data is frozen in the shared shell until TTL and is
 * un-evictable by tag: a server action refreshes the CLIENT only (rotates Rango
 * state, busts the browser HTTP cache) and never touches the server shell store,
 * and updateTag()/revalidateTag() cannot drop data that was baked WITHOUT a tag.
 *
 * Coarse per-shell-key signal, not per-loader attribution — the tag set is
 * unioned globally at the write barrier, not tracked per loader, so we cannot
 * name the offending loader without adding attribution plumbing (deliberately
 * not done). Dev-only + once-per-key so it never spams production or fires on
 * every capture.
 */
function warnUntaggedShellBakeOnce(key: string): void {
  if (warnedUntaggedShellBakes.has(key)) return;
  warnedUntaggedShellBakes.add(key);
  console.warn(
    `[rango] Shell capture for "${key}" baked bake-lane loader data into the ` +
      "shell with NO cache tag. That data is frozen in the shared shell until " +
      "TTL and cannot be tag-invalidated: a server action refresh touches the " +
      "client only (not the server shell store), and updateTag() cannot evict " +
      "data that was baked without a tag.\n" +
      'Fix: tag the data (cacheTag() / "use cache" / cache({ tags })) so ' +
      "updateTag() drops the shell, or move the volatile read under a loading() " +
      "hole so it stays on the live lane and is never baked. See the /ppr skill " +
      "(node_modules/@rangojs/router/skills/ppr/SKILL.md).",
  );
}

/**
 * Default cap (serialized UTF-8 bytes) on the capture data snapshot riding
 * inside a shell entry, when the route's `ppr` option does not set
 * `maxSnapshotBytes`. 8 MiB: the snapshot shares the stored envelope with the
 * base64 prelude and the postponed blob, and the tightest store value limit is
 * Cloudflare KV's 25 MiB — 8 MiB of snapshot leaves the envelope well under it
 * while still fitting any sane pinned-ring payload. Applied ONLY in
 * captureAndStoreShell (the single defaulting site — resolvePprConfig passes
 * the option through undefaulted), so every producer and direct caller gets
 * the same policy. Over the cap the snapshot is skipped (shell still stored;
 * pinned reads drift — see PartialPrerenderProps.maxSnapshotBytes).
 */
export const DEFAULT_PPR_MAX_SNAPSHOT_BYTES: number = 8 * 1024 * 1024;

/** Cached encoder for the snapshot byte measurement (one per module, not per capture). */
const SNAPSHOT_BYTE_ENCODER = new TextEncoder();

/** Keys already warned about an over-cap snapshot (once per key per isolate). */
const warnedOverCapSnapshots = new Set<string>();

/**
 * Warn once per key that the capture data snapshot exceeded the route's
 * `maxSnapshotBytes` cap and was skipped. The shell entry is still stored and
 * served — only the pinned-read replay is lost, so shell-baked cached content
 * can drift from the frozen prelude between capture and HIT and hydration
 * repairs it client-side (the pre-snapshot behavior). Once per key: the same
 * page recaptures on every TTL roll and would otherwise re-warn forever.
 */
function warnSnapshotOverCapOnce(
  key: string,
  snapshotBytes: number,
  capBytes: number,
): void {
  if (warnedOverCapSnapshots.has(key)) return;
  warnedOverCapSnapshots.add(key);
  console.warn(
    `[rango] Shell capture for "${key}" recorded a ${snapshotBytes}-byte data ` +
      `snapshot, over the ${capBytes}-byte cap — the snapshot was skipped and ` +
      "the shell was stored without it. The page keeps serving, but cached " +
      "content baked into the shell is no longer pinned: if it drifts before " +
      "the shell's TTL, hydration repairs the mismatch client-side. Raise the " +
      "cap via the route's ppr option ({ maxSnapshotBytes }) if the entry " +
      "still fits your store's value limit (Cloudflare KV: 25 MiB per value), " +
      "or shrink the cache()'d data the shell bakes.",
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
   * - stored / redirect / no-shell / refused: one capture ATTEMPT's outcome
   *   (see CaptureAttemptOutcome for the semantics of each)
   * - error: the capture task failed with a genuine error (also routed through
   *   reportCacheError; the key is backed off)
   * - skip-in-flight: scheduleShellCapture found a capture already running for
   *   the key (stampede guard) and scheduled nothing
   * - skip-backoff: the key is inside its refused-capture backoff window and
   *   the capture was not attempted
   * - backoff: the key entered (or escalated) backoff after a terminal
   *   no-shell — carries the new backoff state
   */
  outcome:
    | "stored"
    | "redirect"
    | "no-shell"
    | "refused"
    | "error"
    | "skip-in-flight"
    | "skip-backoff"
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
  /** Consecutive failure count in the key's backoff entry, when one exists. */
  backoffFailures?: number;
  /** Ms remaining in the key's backoff window, when one exists. */
  backoffRemainingMs?: number;
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
  if (event.backoffFailures !== undefined) {
    parts.push(`backoff-failures=${event.backoffFailures}`);
  }
  if (event.backoffRemainingMs !== undefined) {
    parts.push(`backoff-remaining=${event.backoffRemainingMs}ms`);
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
 * `holdUntil` keeps the gate from FREEZING before shell material with real latency
 * has emitted. The hole doctrine bakes TOP-LEVEL pushed handle promises into the
 * shell (resolvedHandleStream awaits them before the handles row emits), but a
 * pushed promise that takes longer than the quiet window would otherwise be frozen
 * out — the handles row would never reach fizz and the prelude would come back
 * trivial. While `holdUntil` is pending, byte-quiet detection keeps running but the
 * gate neither fires nor freezes; once it resolves, the quiet counter restarts so a
 * burst of rows unblocked by it (the resolved handles row) is still captured. It
 * never delays a HOLE from postponing: holes are pending promises that emit no
 * bytes, so holding the gate open longer only ever admits shell rows. Bounded by
 * captureShellHTML's maxWaitMs like every other quiesce input.
 */
export function gateFlightForCapture(
  source: ReadableStream<Uint8Array>,
  quietHops: number = FLIGHT_QUIET_HOPS,
  holdUntil?: Promise<unknown>,
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
  let held = holdUntil !== undefined;
  let heldFirePending = false;

  if (holdUntil !== undefined) {
    const release = (): void => {
      held = false;
      if (heldFirePending && !settled && !disposed) {
        // Quiet elapsed while held: restart the quiet count instead of firing
        // immediately, so rows unblocked by the hold (the baked handles row)
        // still flow before the freeze.
        heldFirePending = false;
        armed = false;
        arm();
      }
    };
    // Resolve OR reject releases the hold (a rejected handle value is dropped by
    // resolveDeferredHandleValues; the capture must not hang on it).
    holdUntil.then(release, release);
  }

  const fire = (): void => {
    if (settled) return;
    if (held) {
      heldFirePending = true;
      return;
    }
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
        if (quiet >= quietHops) {
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
   * resolvePprConfig). Feeds captureShellHTML's maxWaitMs — the ONE deadline
   * bounding the whole capture, so it covers BOTH the fizz prerender AND the
   * deferred-material settle window (the handlesBaked/loader-container
   * holdUntil that keeps the gate from freezing while top-level pushes are
   * pending). Undefined = SHELL_CAPTURE_MAX_WAIT_MS (15_000).
   */
  captureTimeout?: number;
  store?: SegmentCacheStore<any>;
  /** Gates the concise per-attempt capture breadcrumbs (INTERNAL_RANGO_DEBUG). */
  debug?: boolean;
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
}

/**
 * Schedule the background shell capture for a served document. Stampede-guarded:
 * one capture per key per isolate. Runs via runBackground (waitUntil on workerd,
 * fire-and-forget in Node dev), so the served response is never blocked on it. Any
 * error is routed through reportCacheError — capture is best-effort; a failure just
 * means the next request recaptures.
 *
 * Eligibility (nonce/allReady/partial/status/strategy) is decided by the caller
 * (rsc-rendering.ts maybeScheduleShellCapture); this function only owns the
 * stampede guard and the background dispatch.
 */
export function scheduleShellCapture(
  ctx: HandlerContext<any>,
  request: Request,
  env: any,
  url: URL,
  reqCtx: RequestContext<any>,
  ssrModule: SSRModule,
  descriptor: ShellCaptureDescriptor,
): void {
  const key = descriptor.key;
  if (inFlightCaptures.has(key)) {
    publishCaptureDebugEvent(descriptor, { key, outcome: "skip-in-flight" });
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
  inFlightCaptures.add(key);
  const captureTask = async () => {
    try {
      const outcome = await runShellCapture(
        ctx,
        request,
        env,
        url,
        reqCtx,
        ssrModule,
        descriptor,
      );
      // Update the negative cache off the terminal outcome. A stored shell clears
      // any prior backoff; a `no-shell` (after the in-place retry) backs the key
      // off so the next requests don't re-probe it. A `redirect` has no shell but
      // is not a doomed render — leave the backoff untouched.
      if (outcome === "stored") clearCaptureBackoff(key);
      else if (outcome === "no-shell") {
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
      publishCaptureDebugEvent(descriptor, {
        key,
        outcome: "error",
        ...backoffFields(key),
      });
      reportCacheError(error, "cache-write", "[ShellCache] capture", reqCtx);
    } finally {
      inFlightCaptures.delete(key);
    }
  };
  // Serialize capture EXECUTION per isolate (capture-queue.ts): concurrent
  // captures starve each other's task-quantized quiet windows — one grinding
  // capture makes the sibling freeze a trivial prelude and store nothing
  // (rotating eternal-MISS victims on GH runners). The stampede guard above
  // stays per-key (dedupe while queued); the queue is cross-key.
  const serializedTask = () => enqueueSerializedCapture(captureTask);
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
 * The outcome of one capture attempt.
 * - `stored`: a usable shell was captured (and a putShell was attempted; a store
 *   I/O failure is reported separately and does NOT make the attempt retryable —
 *   the capture itself worked).
 * - `redirect`: the matched route redirects, so there is no shell to capture.
 * - `no-shell`: the prelude came back trivial (no <body>) OR captureShellHTML
 *   rejected with our own abort. This is the only RETRYABLE outcome.
 */
type CaptureAttemptOutcome = "stored" | "redirect" | "no-shell" | "refused";

/**
 * Per-attempt observability fields, filled along the capture path (barrier in
 * attemptCapture, the rest in captureAndStoreShell) and folded into the
 * attempt's {@link ShellCaptureDebugEvent} by runShellCapture. A plain mutable
 * bag, not a return value: captureAndStoreShell's outcome type stays a string
 * union its existing callers (producer B, tests) consume unchanged.
 */
interface CaptureAttemptStats {
  barrierWaitMs?: number;
  writeSettleMs?: number;
  preludeBytes?: number;
  snapshotBytes?: number;
  snapshotSkipped?: boolean;
}

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
 * several HTTP requests before a capture stuck. We retry ONLY on `no-shell` (and a
 * defensively-caught abort); a genuine render error is NOT retried — it propagates
 * to scheduleShellCapture's reportCacheError. See docs/design/ppr-shell-resume.md.
 *
 * `retryDelayMs` is a parameter (defaulting to the module const) so unit tests can
 * drive the retry without a real 400ms wall-clock wait.
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
): Promise<CaptureAttemptOutcome> {
  const log = descriptor.debug
    ? (message: string) => console.log(message)
    : () => {};

  // One attempt + its structured debug event: the stats object rides through
  // attemptCapture/captureAndStoreShell collecting the observability fields
  // (barrier wait, write-settle wait, prelude/snapshot bytes), and the event
  // folds them with the outcome. A genuine render error skips the attempt
  // event — scheduleShellCapture's catch publishes the terminal `error` event.
  const timedAttempt = async (
    attempt: number,
  ): Promise<CaptureAttemptOutcome> => {
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
    publishCaptureDebugEvent(descriptor, {
      key: descriptor.key,
      outcome,
      attempt,
      attemptMs: Math.round(performance.now() - start),
      ...stats,
    });
    return outcome;
  };

  const first = await timedAttempt(1);
  // "refused" is deterministic (identity guard / rejected bake-lane loader —
  // its own warning already fired): no retry, and the caller backs the key off
  // exactly like a structural no-shell.
  if (first === "refused") return "no-shell";
  // "stored" (success) or "redirect" (no shell exists): nothing to retry.
  if (first !== "no-shell") return first;

  // Attempt 1 produced no usable shell. Retry ONCE in place — the first attempt
  // warmed the dev transform graph / cold worker, so attempt 2 typically completes
  // the shell without another HTTP request. The concise line is gated on the
  // middleware's debug flag (threaded via the descriptor) so it replaces the old
  // full DOMException dump with one readable breadcrumb.
  log(
    `[ShellCache] capture attempt 1/2 for ${descriptor.key} aborted before shell completed (cold modules?) — retrying`,
  );
  await delay(retryDelayMs);
  const second = await timedAttempt(2);
  if (second === "refused") return "no-shell";
  if (second !== "no-shell") return second;

  // Both attempts came back with no usable shell. Cold-start would have healed by
  // now, so the eternal-MISS structural shape (a loader route without loading()) is
  // the likely cause — warn once per key. Ordering matters: because the retry
  // absorbs cold-start, cold-start routes almost never reach this warning. The
  // caller (scheduleShellCapture) reads this `no-shell` return to back the key off.
  log(
    `[ShellCache] capture attempt 2/2 for ${descriptor.key} aborted — giving up until next request`,
  );
  warnNullCaptureOnce(descriptor.key);
  return "no-shell";
}

/** Fold the capture's handle-liveness record into the entry flag (true | undefined). */
function handlerLayerIsLive(
  liveness: RequestContext["_shellCaptureHandleLiveness"],
): true | undefined {
  if (!liveness) return undefined;
  return liveness.holes ||
    liveness.pendingPushes > 0 ||
    liveness.handlerInvokedLoader
    ? true
    : undefined;
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
 *   - _transitionWhen: a fresh [] so the capture's transition gating is its own.
 *   - _shellCaptureRun: true — the switch loaders/cookies/headers guards read.
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

  const { derivedCtx, freshHandleStore } = deriveShellCaptureContext(
    reqCtx,
    descriptor,
  );

  return runWithRequestContext(derivedCtx, async () => {
    const match = await ctx.router.match(request, { env });
    // A route that redirects has no shell to capture — bail (no store write, no
    // retry: a redirect is deterministic).
    if (match.redirect) return "redirect";

    setRequestContextParams(match.params, match.routeName);

    const payload = buildFullPayload(
      match,
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
    return captureAndStoreShell(
      ssrModule,
      flightStage.stream,
      freshHandleStore,
      derivedCtx,
      descriptor,
      stats,
    );
  });
}

/**
 * The derived capture context and its fresh (mask-funneled) handle store,
 * shared by BOTH shell producers: the runtime background capture
 * (attemptCapture, producer A) and the build-time prerender shell capture
 * (prerender/build-shell-capture.ts, producer B — issue #699). One
 * implementation so the capture semantics — the nested-thenable mask funnel,
 * handler-liveness bookkeeping, snapshot recording, the implicit doc-cache
 * scope — cannot drift between producers.
 */
export interface CaptureContextDerivation {
  derivedCtx: RequestContext;
  freshHandleStore: HandleStore;
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
): CaptureContextDerivation {
  const freshHandleStore = createHandleStore();
  freshHandleStore.onError = reqCtx._handleStore.onError;
  // Shape = liveness for handles, exactly as for bake-lane loader containers
  // (mask-nested.ts): nested thenables in a pushed handle container are
  // per-request by declaration, so the CAPTURE's copy masks them — the
  // consuming boundary postpones as a hole regardless of settle timing,
  // instead of a fast-settling nested value baking into the shared shell. A
  // TOP-LEVEL promise push keeps its documented bake contract (awaited
  // pre-SSR, gate held open for it), but the container it RESOLVES to gets
  // the same nested masking. Wrapping THIS store's push is the single funnel:
  // the store exists only for this capture attempt, so every push wrapper
  // (setupLoaderAccess, createUseFunction, prerender) inherits the policy and
  // the foreground store is untouched.
  // Shell fast path bookkeeping on the same funnel:
  //  - handleLiveness: a nested thenable in a push made OUTSIDE a DSL loader
  //    scope (attribution read synchronously at push time — handler bodies,
  //    handler-invoked ctx.use(loader) callbacks, defers) declares
  //    handler-layer per-request data. Its mask is a hole only a handler
  //    re-run can fill, so the entry must not serve handler-free
  //    (ShellCacheEntry.handlerLiveHoles). Still-pending top-level handler
  //    pushes at the putShell barrier count too — their liveness is unknowable.
  //  - loaderScopedPushValues: DSL-loader pushes re-run fresh on every HIT, so
  //    their captured values must NOT enter a segment record's handle snapshot
  //    (replay would duplicate the fresh push, and their masked nested
  //    promises would stall the Flight handle encode to its timeout). The set
  //    rides the derived context (_shellCaptureLoaderHandleValues) and is
  //    applied ONLY at the captureHandles cache-write call site — every other
  //    getDataForSegment consumer (the render-barrier snapshot, prerender)
  //    sees every push.
  const handleLiveness = {
    holes: false,
    pendingPushes: 0,
    handlerInvokedLoader: false,
  };
  const loaderScopedPushValues = new WeakSet<object>();
  const rawCapturePush = freshHandleStore.push.bind(freshHandleStore);
  freshHandleStore.push = (
    handleName: string,
    segmentId: string,
    value: unknown,
  ) => {
    const pushedInLoaderScope = isInsideLoaderScope();
    // Single walk: the mask reports whether it masked any nested thenable
    // (the liveness declaration) while building the capture copy.
    const maskWithLiveness = (v: unknown): unknown => {
      const report: MaskReport = { thenable: false };
      const masked = maskNestedContainerThenables(v, undefined, report);
      if (!pushedInLoaderScope && report.thenable) {
        handleLiveness.holes = true;
      }
      return masked;
    };
    let masked: unknown;
    if (isThenable(value)) {
      if (!pushedInLoaderScope) {
        handleLiveness.pendingPushes++;
        const settle = () => handleLiveness.pendingPushes--;
        value.then(settle, settle);
      }
      masked = value.then(maskWithLiveness);
    } else {
      masked = maskWithLiveness(value);
    }
    if (pushedInLoaderScope && typeof masked === "object" && masked !== null) {
      loaderScopedPushValues.add(masked);
    }
    rawCapturePush(handleName, segmentId, masked);
  };

  const derivedCtx: RequestContext = Object.create(reqCtx);
  derivedCtx._handleStore = freshHandleStore;
  // Own render barrier, closure-bound to the derived ctx and the fresh store
  // (issue #684, plan 009). Without this every _renderBarrier* read fell
  // through the prototype to the foreground's ALREADY-RESOLVED barrier: a
  // bake-lane loader's `await ctx.rendered()` resolved instantly and
  // ctx.use(handle) read the FOREGROUND handle snapshot — foreground
  // per-request handle data could bake into the shared shell. wireRenderBarrier
  // also resets _treeHasStreaming (recomputed for the capture's tree) and the
  // deadlock-guard fields as own properties.
  wireRenderBarrier(derivedCtx, freshHandleStore);
  derivedCtx._shellCaptureLoaderHandleValues = loaderScopedPushValues;
  derivedCtx._requestTags = new Set<string>();
  // Own explicit-store registry: cache-store resolutions during the capture
  // (the implicit scope's SnapshotOnlySegmentStore, any per-capture explicit
  // store instance) must NOT register into the handler-lifetime
  // _explicitTaggedStores set — a capture-ephemeral store pinned there would
  // trip the partial-tag-store warning on every later updateTag() and retain
  // the whole capture snapshot in memory. Capture registrations die with this
  // context; module-singleton stores stay registered by normal renders.
  derivedCtx._explicitTaggedStores = new Set();
  derivedCtx._transitionWhen = [];
  derivedCtx._shellCaptureRun = true;
  derivedCtx._metricsStore = undefined;
  // Spans, like perf metrics above, are a FOREGROUND surface: the capture
  // re-render must not emit a second rango.render/loader/ssr set after the
  // foreground rango.request span ended (orphan spans in the trace).
  // _tracing is otherwise inherited through Object.create(reqCtx).
  derivedCtx._tracing = undefined;
  // Bake-lane loader containers (loaders on entries with no renderable
  // loading() execute during capture — docs/design/loader-container-bake.md).
  // resolveLoaderData registers each container promise here; the drain in
  // captureAndStoreShell elides + pins them into the snapshot's loader family.
  derivedCtx._shellCaptureLoaderRecords = new Map();
  // Own onResponse list so the capture's match-middleware callbacks (the ring-3
  // segment cache write registers here) are ISOLATED from the foreground's shared
  // array AND can be fired by captureAndStoreShell. The segment write is gated
  // behind onResponse, which the capture never triggers (it builds no Response) —
  // without firing it, a ring-3 cache() MISS at capture renders fresh into the
  // prelude but is never written, so it is never recorded and drifts on a HIT.
  derivedCtx._onResponseCallbacks = [];

  // Capture data snapshot: read every cache-store hit/write through a recording
  // wrapper on the DERIVED context's store (own property, so the shared
  // reqCtx._cacheStore is untouched — the snapshot is per-capture). Its records
  // ride inside the ShellCacheEntry so a HIT can reproduce the shell's cached
  // content byte-identically. See cache/shell-snapshot.ts and the design doc.
  //
  // Cache writes are deferred (waitUntil): a MISS-at-capture value's setItem/set
  // — hence its record — would otherwise land after the shell quiesces. Override
  // the derived context's waitUntil to COLLECT those write promises (still
  // forwarding to the parent so the write persists and the worker stays alive),
  // then captureAndStoreShell awaits them before draining. Reads that HIT are
  // recorded synchronously during the render and need none of this.
  derivedCtx._shellCaptureHandleLiveness = handleLiveness;
  if (reqCtx._cacheStore) {
    const recordingStore = new RecordingShellStore(reqCtx._cacheStore);
    derivedCtx._cacheStore = recordingStore;
    derivedCtx.waitUntil = (fn: () => Promise<void>): void => {
      const p = Promise.resolve().then(fn);
      recordingStore.trackWrite(p);
      reqCtx.waitUntil(() => p);
    };
    // Shell fast path (capture side): the implicit doc-cache scope makes the
    // capture's match write ALL matched non-loader segments as one doc-keyed
    // segment record — into the snapshot only (SnapshotOnlySegmentStore), so
    // the record dies with the shell entry and the next capture's lookup
    // still misses (handlers re-run on recapture). Routes deriving their own
    // cache scope are untouched (resolveShellImplicitCacheScope).
    derivedCtx._shellImplicitCache = {
      ttl: descriptor.ttl,
      swr: descriptor.swr,
      store: new SnapshotOnlySegmentStore(recordingStore),
    };
  }

  return { derivedCtx, freshHandleStore };
}

/**
 * Seal handles, derive the quiesce signal, prerender + abort via the SSR module's
 * captureShellHTML, and store the result. Returns the attempt outcome (the caller
 * owns retry/warn decisions — this function no longer warns). Never throws out of
 * the store write: a failed putShell is routed through reportCacheError so the
 * background task stays best-effort, and the attempt still counts as `stored` (the
 * capture worked; only the store I/O failed). `ssrModule.captureShellHTML` MUST be
 * present (eligibility is checked before scheduling).
 *
 * A `no-shell` result (trivial prelude, or a defensively-caught abort) is the only
 * retryable outcome; a genuine (non-abort) captureShellHTML error propagates so it
 * reaches reportCacheError and is NOT retried.
 */
async function captureAndStoreShell(
  ssrModule: SSRModule,
  rscStream: ReadableStream<Uint8Array>,
  handleStore: HandleStore,
  reqCtx: RequestContext<any>,
  capture: ShellCaptureDescriptor,
  stats?: CaptureAttemptStats,
): Promise<Exclude<CaptureAttemptOutcome, "redirect">> {
  const captureShellHTML = ssrModule.captureShellHTML!;

  // Seal the handle store so the payload's handles generator (resolvedHandleStream
  // -> handleStore.stream()) converges and completes even though masked loaders
  // never resolve. handleStore.settled gates ONLY on tracked HANDLER promises
  // (handleStore.track, via trackHandler) — NOT on deferred handle VALUES pushed
  // through ctx.use(Handle).defer(), which are plain pushed promises. So seal()
  // does not reject or hang on outstanding defers: settled resolves once the
  // handlers settle, and each deferred slot resolves on its own createDeferred
  // timeout (defer.ts, default 10s) or when its resolver fires. A defer whose
  // resolver depends on a masked loader can never fire, so it stays pending until
  // that 10s timeout — longer than maxWaitMs (5s). At the abort the handles
  // generator has not yielded, SsrRoot suspends at the root (consumeAsyncGenerator
  // sits above every boundary), the prelude comes back trivial, and
  // captureShellHTML's sanity gate returns null: the designed fail-safe no-op, not
  // an error. This mirrors the __prerender_collect seal+settled regime, which also
  // excludes loaders. See docs/design/ppr-shell-resume.md ("Loaders and handles").
  handleStore.seal();

  // Handles contract, shell half ("nesting = liveness"): TOP-LEVEL pushed handle
  // promises are BAKED into the shell — resolvedHandleStream awaits them before
  // the payload's handles row emits. A pushed promise with real latency would lose
  // the byte-quiet race (the pending handles row emits no bytes, the gate freezes,
  // the row is dropped, SsrRoot suspends at the root), so the gate is HELD open
  // until the same await completes: handlesBaked mirrors resolvedHandleStream's
  // resolution (getData waits the tracked-handler barrier; resolveDeferredHandleValues
  // awaits the top-level thenables). NESTED promises inside pushed containers are
  // shallow-skipped by isThenable and never hold the gate — they stay holes.
  // Bounded by maxWaitMs like every quiesce input (a defer hanging on a masked
  // loader still ends in the sanity-gate refusal).
  const handlesBaked = handleStore.getData().then(resolveDeferredHandleValues);
  // Bake-lane loader containers hold the gate the same way (loader-container-
  // bake): a boundary-less container with real latency (a 100ms layout loader)
  // would otherwise lose the 2-hop byte-quiet race — the pending loaderData row
  // emits no bytes, the gate freezes, and the awaiting tree pins above <body>.
  // The records map is fully populated before this point (loader promises are
  // created during the capture's match()), so the hold covers every bake-lane
  // container. allSettled: a REJECTED container releases the hold (the drain
  // below refuses the capture); nested promises INSIDE a container never hold
  // the gate — they stay holes. Bounded by maxWaitMs like every quiesce input.
  const loaderRecordsForHold = reqCtx._shellCaptureLoaderRecords;
  const holdUntil =
    loaderRecordsForHold && loaderRecordsForHold.size > 0
      ? Promise.allSettled([handlesBaked, ...loaderRecordsForHold.values()])
      : handlesBaked;
  const gate = gateFlightForCapture(rscStream, undefined, holdUntil);
  // Quiesce = handles settled AND the Flight shell rows went task-quiet. Either
  // half stalling is bounded by captureShellHTML's maxWaitMs.
  const quiesce = Promise.all([handleStore.settled, gate.quiesce]).then(
    () => {},
  );

  // Deterministic identity-guard refusal, checked at BOTH exits below: the
  // guard error either rejects the prerender itself (boundary-less segment —
  // lands in the catch) or is swallowed into per-loader error UI (the render
  // completes — caught after the try). One helper so the message and the
  // "refused" mapping cannot drift between the two sites.
  const refuseOnGuardTrip = (): "refused" | undefined => {
    const fnName = reqCtx._shellCaptureGuardTripped;
    if (!fnName) return undefined;
    // Name the recorded source instead of hardcoding a lane. Under the
    // consumption-lane rule, handler-INVOKED loader bodies are exempt from
    // the guard (their value is a baked shared copy, mirroring cache()), so a
    // trip can only come from a bake-lane SEGMENT loader or from non-loader
    // handler/render code — the old blanket "bake-lane loader" attribution
    // sent a live-lane debugging session down the wrong lane (issue #672).
    const loaderId = reqCtx._shellCaptureGuardTrippedLoaderId;
    const origin = loaderId
      ? `segment loader "${loaderId}"`
      : "handler/render code (no loader body was executing)";
    warnCaptureRefusedOnce(
      capture.key,
      `${origin} called ${fnName}() during capture. Identity must not bake into a shared shell. ` +
        "For a segment loader (bake lane, no loading()): give its entry a loading() boundary " +
        "(the live lane, masked at capture) or move the identity-dependent part into a nested " +
        "promise. For handler/render code: keep the value live by consuming a loader " +
        'client-side (useLoader in a "use client" component). Note: `await ctx.use(loader)` ' +
        "inside a HANDLER is exempt from this guard — its value bakes into the shared shell " +
        "as a capture-time copy, mirroring cache() semantics (the consumption-lane rule).",
    );
    return "refused";
  };

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
        }),
      );
    } catch (error) {
      // Guard-tripped rejection arrives here (not at the drain) — refuse
      // BEFORE the AbortError-vs-rethrow decision below.
      const refused = refuseOnGuardTrip();
      if (refused) return refused;
      // captureShellHTML normally converts its OWN deliberate abort to a null
      // return (index.tsx). This catch is defensive: if an AbortError still escapes
      // (a runtime where the abort surfaces as a stream rejection outside its
      // guard), treat it as the same retryable "no usable shell" degradation rather
      // than a failure — do NOT report it as an error. A genuine (non-abort) render
      // error is a real failure: rethrow so it reaches reportCacheError (no retry).
      if ((error as { name?: string } | null)?.name === "AbortError") {
        return "no-shell";
      }
      throw error;
    }

    // null = sanity gate refused (trivial/empty prelude, no <body>). Store nothing
    // and report `no-shell` so the caller (runShellCapture) can retry once and, if
    // that also fails, warn once per key. On a cold render this is the shell not
    // yet finished; on a loader route WITHOUT a route-level loading() boundary it is
    // the structural eternal-MISS shape (the masked loader pins the tree above
    // <body> at tree-build). The caller's warning names both.
    // Guard check first — BEFORE the trivial-prelude retry path. A guard trip
    // is deterministic (retrying re-trips it), and when the tripping loader's
    // error UI still completed a shell, storing it would bake the failure into
    // a shared page.
    const refused = refuseOnGuardTrip();
    if (refused) return refused;

    if (result === null) {
      return "no-shell";
    }
    if (stats) stats.preludeBytes = result.prelude.length;

    // Store per the flag's key/ttl/swr/tags, into the flag's store: the middleware
    // threads the SAME store it resolved for its getShell read (options.store ??
    // _cacheStore), so a store-attached middleware writes captures where it reads
    // them. The _cacheStore fallback covers a flag armed without a store (tests).
    // reactVersion is read from the same React.version import the middleware
    // validates reads against, so capture and serve always agree.
    // Fire the capture's isolated onResponse callbacks with a synthetic 200 so
    // the ring-3 segment cache write (cacheScope.cacheRoute, registered via
    // onResponse by the cache-store match-middleware and gated on a 200) runs
    // DURING capture, routed through the recording store. The foreground path
    // never fires for the capture — it builds no Response — so without this a
    // cache() SEGMENT that MISSED at capture would be rendered fresh into the
    // prelude yet never written, hence never recorded, and would drift on a HIT
    // (an item-family "use cache" write already runs inline during the render, so
    // it needs none of this; only segment writes are onResponse-gated). The
    // derived context's own _onResponseCallbacks holds only capture match-
    // middleware callbacks (HTTP middleware never runs for a capture), so firing
    // them is safe. Best-effort: a throwing callback must not fail the capture.
    const responseCallbacks = reqCtx._onResponseCallbacks;
    if (responseCallbacks && responseCallbacks.length > 0) {
      const synthetic = new Response(null, { status: 200 });
      for (const cb of responseCallbacks) {
        try {
          cb(synthetic);
        } catch {
          // A capture-time cache write that throws is degradation, not failure.
        }
      }
    }

    // Drain the capture data snapshot from the recording store on the derived
    // context. Await the deferred cache writes first so a MISS-at-capture value
    // (setItem/set scheduled under waitUntil, including the segment write just
    // fired) is pinned, not just read-hits. When no recording store is installed
    // (unit tests that call this directly), there is simply no snapshot.
    const recording = getRecordingStore(reqCtx._cacheStore);
    let snapshot: ShellSnapshotRecord[] | undefined;
    if (recording) {
      const settleStart = performance.now();
      await recording.settleWrites(SHELL_SNAPSHOT_WRITE_SETTLE_MS);
      if (stats) {
        stats.writeSettleMs = Math.round(performance.now() - settleStart);
      }
      snapshot = recording.drainSnapshot();
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
    // serialization succeeds. Drives the untagged-bake dev warning below.
    let bakedLoaderMaterial = false;
    if (loaderRecords && loaderRecords.size > 0) {
      // The codec import is deferred past the elide probes: a rejected record
      // refuses and a never-settled record is omitted WITHOUT touching Flight
      // (also keeps the virtual @vitejs/plugin-rsc import out of unit configs).
      let serializeContainer:
        | typeof import("../cache/segment-codec.js").serializeResult
        | undefined;
      for (const [segmentKey, containerPromise] of loaderRecords) {
        const elided = await elideLoaderContainer(containerPromise);
        if (elided.state === "rejected") {
          warnCaptureRefusedOnce(
            capture.key,
            `the loader for segment "${segmentKey}" rejected during capture; its error UI must not bake into the shared shell. ` +
              "Fix the loader, or give its entry a loading() boundary so it stays on the live lane.",
          );
          return "refused";
        }
        // The container itself never settled: it is a hole (under an ancestor
        // boundary) or the trivial-prelude gate already fired. Omit — no pin.
        if (isLoaderHoleMarker(elided.value)) continue;
        // Past the hole check: this container settled with real material that
        // bakes into the shell prelude (independent of the snapshot pin below).
        bakedLoaderMaterial = true;
        try {
          // serializeResult (not rscSerialize): null is a valid container and
          // must round-trip; serializeResult preserves it through Flight.
          serializeContainer ??= (await import("../cache/segment-codec.js"))
            .serializeResult;
          const serialized = await serializeContainer(elided.value);
          if (serialized !== null) {
            (snapshot ??= []).push({
              family: "loader",
              key: segmentKey,
              // The hole bit rides with the record so the HIT overlay knows
              // without rescanning whether the pin can resolve immediately
              // (holes: 0) or must wait for the fresh run's live promises
              // (holes: 1). See ShellSnapshotLoaderValue.
              value: { value: serialized, holes: elided.hasHole ? 1 : 0 },
            });
          }
        } catch {
          // Non-serializable container: leave it unpinned (it drifts on a HIT,
          // the pre-snapshot behavior) rather than failing the capture.
        }
      }
    }

    // Snapshot size guard (issue #651): the snapshot duplicates every pinned
    // cache value inside the shell entry, so a page over a large cache()
    // segment can push the stored envelope toward store value limits (KV caps
    // a value at 25 MiB) with no signal — the kv.put rejects deep inside
    // waitUntil. Measure the serialized snapshot (UTF-8 bytes of the JSON that
    // rides in the envelope) AFTER the loader family is appended, and over the
    // cap store the shell WITHOUT it: pinned reads then fall back to the live
    // store on a HIT (documented drift — hydration repairs a mismatch
    // client-side, the pre-snapshot behavior), which beats losing the whole
    // entry to a store-side write rejection. Reported once per key.
    if (snapshot && snapshot.length > 0) {
      const snapshotBytes = SNAPSHOT_BYTE_ENCODER.encode(
        JSON.stringify(snapshot),
      ).length;
      if (stats) stats.snapshotBytes = snapshotBytes;
      const cap = capture.maxSnapshotBytes ?? DEFAULT_PPR_MAX_SNAPSHOT_BYTES;
      if (snapshotBytes > cap) {
        warnSnapshotOverCapOnce(capture.key, snapshotBytes, cap);
        snapshot = undefined;
        if (stats) stats.snapshotSkipped = true;
      }
    }

    // Shell tags snapshot at the WRITE BARRIER, not at stream construction: by
    // here the capture has quiesced and the deferred cache writes were awaited, so
    // tags recorded AFTER an await in async shell content (and by async
    // cache()/"use cache" reads propagating through recordRequestTags) are
    // included — issue #676. Loaders are masked, so loader cache tags — which
    // belong to the holes, not the shell — never execute during capture and cannot
    // contribute. Union with the route's static ppr.tags (capture.tags); the
    // collected set is authoritative, the option only adds what the render cannot
    // know.
    const collected = [...reqCtx._requestTags];
    const union = new Set<string>([...(capture.tags ?? []), ...collected]);
    const shellTags = union.size > 0 ? [...union] : undefined;

    // Untagged-bake diagnostic: a bake-lane loader froze mutable data into the
    // shell but nothing tags the entry, so it is un-invalidatable except by TTL —
    // a read-your-own-writes gap on the document channel (an action refresh skips
    // the server shell; updateTag cannot drop untagged data). Coarse per-shell-key
    // signal; dev-only and once-per-key so it never spams production.
    if (isDevMode() && bakedLoaderMaterial && shellTags === undefined) {
      warnUntaggedShellBakeOnce(capture.key);
    }

    const store = capture.store ?? reqCtx._cacheStore;
    if (store?.putShell) {
      try {
        const entry: ShellCacheEntry = {
          // slice() copies just this view's bytes into a fresh ArrayBuffer, so a
          // prelude that is a subarray of a larger backing buffer encodes only its
          // own region — bufferToBase64 reads the whole ArrayBuffer it is handed.
          prelude: bufferToBase64(result.prelude.slice().buffer as ArrayBuffer),
          postponed: result.postponed,
          reactVersion: React.version,
          buildVersion: capture.buildVersion,
          // The theme this capture's payload was built with (buildFullPayload
          // reads reqCtx.theme off the derived context). The serve tail replays
          // it so the resume tree matches the frozen prelude — see
          // ShellCacheEntry.initialTheme.
          initialTheme: reqCtx.theme,
          snapshot,
          // Handler-layer liveness folded at the barrier: nested thenables in
          // handler-scoped pushes, handler pushes still pending (liveness
          // unknowable), or a handler-invoked loader execution — any of them
          // refuses the FAST PATH, not the capture. See
          // _shellCaptureHandleLiveness.
          handlerLiveHoles: handlerLayerIsLive(
            reqCtx._shellCaptureHandleLiveness,
          ),
          createdAt: Date.now(),
        };
        await store.putShell(
          capture.key,
          entry,
          capture.ttl,
          capture.swr,
          shellTags,
        );
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
    // A shell was captured (the store I/O may have failed, but that is reported,
    // not retried) — so this attempt is `stored` and the caller does not retry.
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
