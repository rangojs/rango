/**
 * PPR shell capture orchestration (Axis 2, see docs/design/ppr-shell-resume.md).
 *
 * Capture does NOT flow through the HTTP middleware pipeline. The shell-cache
 * middleware sets a `_shellCapture` DESCRIPTOR before its single foreground
 * next(); the render layer (rsc-rendering.ts) reads it after building the served
 * response and calls scheduleShellCapture. The capture then runs as a background
 * task that re-derives the shell via `ctx.router.match()` under its OWN derived
 * request context — fresh handle store, `_shellCaptureRun: true` so loaders mask
 * (loader-mask.ts) and every loader-consuming subtree postpones. It drives the
 * static prerender to a quiescent shell, aborts to freeze the prelude + postponed
 * state, and stores the pair via putShell. Because it uses match() rather than a
 * second next(), the middleware chain (auth, logging, the single-use next() latch)
 * never re-runs — and the capture inherits the foreground's post-middleware
 * context state (variables, cache store) it delegates to.
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
import type { ShellCacheEntry } from "../cache/types.js";
import type { HandlerContext } from "./handler-context.js";
import type { RscPayload, SSRModule } from "./types.js";
import { buildFullPayload } from "./full-payload.js";

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
 * per-request data in loaders or behind live(). See docs/design/ppr-shell-resume.md.
 */
const FLIGHT_QUIET_HOPS = 2;

/** Default upper bound on the capture prerender wait before forcing the abort. */
const SHELL_CAPTURE_MAX_WAIT_MS = 5000;

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
 * Keys already warned about a refused (null) capture, so the eternal-MISS shape
 * logs once per key per isolate instead of on every request.
 */
const warnedNullCaptures = new Set<string>();

function warnNullCaptureOnce(key: string): void {
  if (warnedNullCaptures.has(key)) return;
  warnedNullCaptures.add(key);
  console.warn(
    `[rango] Shell capture for "${key}" produced no usable shell (empty or ` +
      "not-ready prelude); nothing was stored, so this request stays on MISS. A later " +
      "request re-captures - if the route NEVER flips to HIT, the most common cause is " +
      "a loader route without a route-level loading() boundary: its loader data is " +
      "awaited at tree-build, so under capture's masked loaders no shell exists above " +
      "<body>. Add loading() to the loader route (and keep shell material in a layout) " +
      "to make it PPR-capturable. See docs/design/ppr-shell-resume.md.",
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
 */
export function gateFlightForCapture(
  source: ReadableStream<Uint8Array>,
  quietHops: number = FLIGHT_QUIET_HOPS,
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
  descriptor: NonNullable<RequestContext["_shellCapture"]>,
): void {
  const key = descriptor.key;
  if (inFlightCaptures.has(key)) return;
  inFlightCaptures.add(key);
  runBackground(reqCtx, async () => {
    try {
      await runShellCapture(
        ctx,
        request,
        env,
        url,
        reqCtx,
        ssrModule,
        descriptor,
      );
    } catch (error) {
      // Detached background task — pass reqCtx so onError still fires when the ALS
      // context is gone. Best-effort: a failure just means the next request
      // recaptures.
      reportCacheError(error, "cache-write", "[ShellCache] capture", reqCtx);
    } finally {
      inFlightCaptures.delete(key);
    }
  });
}

/**
 * Run the shell capture in a DERIVED request context, then store the result.
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
 *   - _shellCapture: the descriptor (informational; putShell target/ttl/swr).
 *   - _metricsStore: undefined so the capture never appends to the foreground's
 *     (already-finalized) metrics.
 */
async function runShellCapture(
  ctx: HandlerContext<any>,
  request: Request,
  env: any,
  url: URL,
  reqCtx: RequestContext<any>,
  ssrModule: SSRModule,
  descriptor: NonNullable<RequestContext["_shellCapture"]>,
): Promise<void> {
  const freshHandleStore = createHandleStore();
  freshHandleStore.onError = reqCtx._handleStore.onError;

  const derivedCtx: RequestContext = Object.create(reqCtx);
  derivedCtx._handleStore = freshHandleStore;
  derivedCtx._requestTags = new Set<string>();
  derivedCtx._transitionWhen = [];
  derivedCtx._shellCaptureRun = true;
  derivedCtx._shellCapture = descriptor;
  derivedCtx._metricsStore = undefined;

  await runWithRequestContext(derivedCtx, async () => {
    const match = await ctx.router.match(request, { env });
    // A route that redirects has no shell to capture — bail (no store write).
    if (match.redirect) return;
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
    // own fresh _requestTags. Loaders are masked, so loader cache tags (which
    // belong to the holes, not the shell) are correctly excluded.
    const tags =
      derivedCtx._requestTags.size > 0
        ? [...derivedCtx._requestTags]
        : undefined;

    await captureAndStoreShell(
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
 * captureShellHTML, and store the result. Never throws out of the store write: a
 * failed putShell is routed through reportCacheError so the background task stays
 * best-effort. `ssrModule.captureShellHTML` MUST be present (eligibility is
 * checked before scheduling).
 */
async function captureAndStoreShell(
  ssrModule: SSRModule,
  rscStream: ReadableStream<Uint8Array>,
  handleStore: HandleStore,
  reqCtx: RequestContext<any>,
  capture: NonNullable<RequestContext["_shellCapture"]>,
): Promise<void> {
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

  const gate = gateFlightForCapture(rscStream);
  // Quiesce = handles settled AND the Flight shell rows went task-quiet. Either
  // half stalling is bounded by captureShellHTML's maxWaitMs.
  const quiesce = Promise.all([handleStore.settled, gate.quiesce]).then(
    () => {},
  );

  try {
    // captureShellHTML CONSUMES the (gated) stream — it is not also SSR'd.
    const result = await observePhase(PHASES.ssr, () =>
      captureShellHTML(gate.stream, {
        quiesce,
        maxWaitMs: SHELL_CAPTURE_MAX_WAIT_MS,
      }),
    );

    // null = sanity gate refused (trivial/empty prelude, no <body>). Store
    // nothing; the route stays on axis 1 and every future request re-captures to
    // the same refusal, so surface it once per key: the dominant cause is a
    // route shape with no capturable shell — a loader route WITHOUT a route-level
    // loading() boundary awaits its loader data at tree-build (renderSegments'
    // loading-less branch), so the masked loader pins the whole tree above
    // <body>. Silent refusal made that shape an undiagnosable eternal MISS.
    if (result === null) {
      warnNullCaptureOnce(capture.key);
      return;
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
  } finally {
    // Stop the hop loop for the pathological never-quiets path (quiesce never
    // fired, capture returned via maxWaitMs). On the normal path the loop already
    // stopped when it fired quiesce; dispose() is then a no-op.
    gate.dispose();
  }
}

// Exported for unit tests that drive the capture core directly.
export { runShellCapture, captureAndStoreShell };
