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
import { observePhase, PHASES } from "../router/instrument.js";
import {
  runWithRequestContext,
  setRequestContextParams,
  type RequestContext,
} from "../server/request-context.js";
import { createHandleStore, type HandleStore } from "../server/handle-store.js";
import type { ShellCacheEntry, SegmentCacheStore } from "../cache/types.js";
import type { HandlerContext } from "./handler-context.js";
import type { RscPayload, SSRModule } from "./types.js";
import { buildFullPayload } from "./full-payload.js";
import { resolveDeferredHandleValues } from "../handles/deferred-resolution.js";

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

/** Default upper bound on the capture prerender wait before forcing the abort. */
const SHELL_CAPTURE_MAX_WAIT_MS = 5000;

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
 * failure count: `min(BASE * 2^(failures-1), MAX)` — 1s, 2s, 4s, … capped at 60s.
 *
 * Why exponential and not a flat 60s: a flat long window conflates two very
 * different failures. A STRUCTURALLY ineligible route (no loading(), a cookie
 * reader) fails forever and wants the long 60s cap. But a cold-but-ELIGIBLE route
 * can also fail the in-place retry under a truly cold graph (dev module transform,
 * or a cold worker under parallel load) — and it must recover FAST, on the next
 * request or two, not be frozen for 60s (that would re-break the very cold-start DX
 * the retry fixes; it bit the cloudflare dev e2e). Escalating from 1s means the
 * eligible route re-probes almost immediately (warm now → HIT and clear), while the
 * doomed route ramps to the 60s cap within a handful of failures. Either way an
 * app-wide mount never re-renders a doomed route on EVERY request.
 */
const REFUSED_CAPTURE_BASE_MS = 1_000;
const REFUSED_CAPTURE_MAX_MS = 60_000;

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

/** Record a refused/failed capture, escalating the backoff window exponentially. */
function markCaptureBackoff(key: string): void {
  const failures = (refusedCaptures.get(key)?.failures ?? 0) + 1;
  const window = Math.min(
    REFUSED_CAPTURE_BASE_MS * 2 ** (failures - 1),
    REFUSED_CAPTURE_MAX_MS,
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
      "retry; nothing was stored, so this request stays on MISS. Two things cause this, " +
      "told apart by whether the route ever flips to HIT:\n" +
      "  1. Cold-start warmup (dev module transform, or a cold worker): the capture raced " +
      "an unfinished shell render. This SELF-HEALS — the route flips to HIT once a later " +
      "request warms the modules. Usually nothing to do.\n" +
      "  2. A loader route WITHOUT a route-level loading() boundary: its loader data is " +
      "awaited at tree-build, so under capture's masked loaders no shell exists above " +
      "<body>, and the route NEVER flips to HIT. Add loading() to the loader route (and " +
      "keep shell material in a layout) to make it PPR-capturable.\n" +
      'See the /ppr skill (node_modules/@rangojs/router/skills/ppr/SKILL.md), "The hole ' +
      'contract", or the design doc: ' +
      "https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/design/ppr-shell-resume.md",
  );
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
 * tags from its derived render (the collected set stays authoritative). `store`
 * is the same store the serve path resolved for its getShell read
 * (requestCtx._cacheStore), so the capture writes where the serve reads.
 */
export interface ShellCaptureDescriptor {
  key: string;
  ttl?: number;
  swr?: number;
  tags?: string[];
  store?: SegmentCacheStore<any>;
  /** Gates the concise per-attempt capture breadcrumbs (INTERNAL_RANGO_DEBUG). */
  debug?: boolean;
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
  if (inFlightCaptures.has(key)) return;
  // Refused/failed within the window → skip the doomed re-render (one probe per
  // key per window per isolate). Expired entries self-evict inside the check.
  if (isCaptureBackedOff(key)) return;
  inFlightCaptures.add(key);
  runBackground(reqCtx, async () => {
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
      else if (outcome === "no-shell") markCaptureBackoff(key);
    } catch (error) {
      // Detached background task — pass reqCtx so onError still fires when the ALS
      // context is gone. A genuine failure recurs, so back it off too (re-probe
      // once per window, not every request) and report it once.
      markCaptureBackoff(key);
      reportCacheError(error, "cache-write", "[ShellCache] capture", reqCtx);
    } finally {
      inFlightCaptures.delete(key);
    }
  });
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
type CaptureAttemptOutcome = "stored" | "redirect" | "no-shell";

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

  const first = await attemptCapture(
    ctx,
    request,
    env,
    url,
    reqCtx,
    ssrModule,
    descriptor,
  );
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
  const second = await attemptCapture(
    ctx,
    request,
    env,
    url,
    reqCtx,
    ssrModule,
    descriptor,
  );
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
): Promise<CaptureAttemptOutcome> {
  const freshHandleStore = createHandleStore();
  freshHandleStore.onError = reqCtx._handleStore.onError;

  const derivedCtx: RequestContext = Object.create(reqCtx);
  derivedCtx._handleStore = freshHandleStore;
  derivedCtx._requestTags = new Set<string>();
  derivedCtx._transitionWhen = [];
  derivedCtx._shellCaptureRun = true;
  derivedCtx._metricsStore = undefined;

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
    const rscStream = ctx.renderToReadableStream<RscPayload>(payload, {
      onError: (error: unknown) => {
        ctx.callOnError(error, "rendering", { request, url, env });
      },
    });

    // Shell tags = the non-loader request tags the capture render recorded on its
    // own fresh _requestTags (loaders are masked, so loader cache tags — which
    // belong to the holes, not the shell — are correctly excluded), UNIONED with
    // the middleware's operational `tags` option (descriptor.tags). The collected
    // set is authoritative; the option only adds tags the render cannot know.
    const collected = [...derivedCtx._requestTags];
    const union = new Set<string>([...(descriptor.tags ?? []), ...collected]);
    const tags = union.size > 0 ? [...union] : undefined;

    return captureAndStoreShell(
      ssrModule,
      rscStream,
      freshHandleStore,
      derivedCtx,
      {
        ...descriptor,
        tags,
      },
    );
  });
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
  const gate = gateFlightForCapture(rscStream, undefined, handlesBaked);
  // Quiesce = handles settled AND the Flight shell rows went task-quiet. Either
  // half stalling is bounded by captureShellHTML's maxWaitMs.
  const quiesce = Promise.all([handleStore.settled, gate.quiesce]).then(
    () => {},
  );

  try {
    // captureShellHTML CONSUMES the (gated) stream — it is not also SSR'd.
    let result: Awaited<ReturnType<typeof captureShellHTML>>;
    try {
      result = await observePhase(PHASES.ssr, () =>
        captureShellHTML(gate.stream, {
          quiesce,
          maxWaitMs: SHELL_CAPTURE_MAX_WAIT_MS,
        }),
      );
    } catch (error) {
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
    if (result === null) {
      return "no-shell";
    }

    // Store per the flag's key/ttl/swr/tags, into the flag's store: the middleware
    // threads the SAME store it resolved for its getShell read (options.store ??
    // _cacheStore), so a store-attached middleware writes captures where it reads
    // them. The _cacheStore fallback covers a flag armed without a store (tests).
    // reactVersion is read from the same React.version import the middleware
    // validates reads against, so capture and serve always agree.
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
          createdAt: Date.now(),
        };
        await store.putShell(
          capture.key,
          entry,
          capture.ttl,
          capture.swr,
          capture.tags,
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

// Exported for unit tests that drive the capture core directly.
export { runShellCapture, captureAndStoreShell };
