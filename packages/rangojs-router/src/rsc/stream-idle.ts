/**
 * Stream-idle timeout — the enforcement for `timeouts.streamIdleMs` (the
 * "stream-idle" TimeoutPhase, reserved since the timeout API landed).
 *
 * WHY: nothing else bounds a streaming response body's lifetime.
 * `renderStartMs` only bounds time-to-Response-construction; once the body is
 * streaming, a single never-settling promise embedded in the payload (a
 * deferred loader that never resolves, an orphaned ctx.rendered() barrier)
 * holds the Flight/HTML stream — and the client's connection — open forever.
 * Deferred HANDLES have a 10s auto-resolve net (defer.ts); loader promises
 * and everything else have none. Field-observed as multi-second dead
 * connections only closed by client cancellation.
 *
 * SEMANTICS — end-to-end idle flow, deliberately: the watchdog re-arms on
 * every chunk that flows THROUGH to the client, so "idle" means "no bytes
 * reached the wire for N ms". A stalled slow client counts as idle the same
 * as a wedged producer — the two are indistinguishable here without buffering,
 * and buffering is banned on the streaming path. Pick budgets accordingly
 * (generous, seconds not millis); the feature is OPT-IN (unset = today's
 * unbounded behavior, and the `timeout` shorthand deliberately does not apply
 * to streamIdleMs — see resolveTimeouts).
 *
 * ON TRIP: the client-facing stream is errored with a RouterTimeoutError
 * ("stream-idle") — the host terminates the response visibly (truncated
 * chunked encoding), which is debuggable, unlike a silent clean close that
 * would present a half-document as complete. Erroring the transform makes the
 * pipe cancel its SOURCE, which aborts React's fizz/flight render — but only
 * when the watchdog's branch is the sole consumer. When an upstream layer
 * teed or cloned the body first (the document-cache MISS drain,
 * response-cache clones), the watchdog holds one tee branch: tee semantics
 * cancel the underlying source only once EVERY branch cancels, so the cache
 * branch keeps the wedged render alive, bounded only by the platform's
 * waitUntil budget — exactly as it was before this feature. The client-facing
 * bound is unconditional; source teardown is best-effort. `onTimeout` does
 * NOT apply: the response already left the handler, so no replacement
 * Response can be served — the trip is reported via onError + the
 * request.timeout telemetry event instead.
 *
 * COST: one identity TransformStream hop per chunk, only when the timeout is
 * enabled. Never buffers, never reads ahead, adds no work when disabled.
 */

import { RouterTimeoutError } from "../router/timeout.js";

/** What the watchdog observed when it tripped. */
export interface StreamIdleTrip {
  /** ms since the watchdog armed (response handoff) — the stream's lifetime. */
  totalMs: number;
  /** Chunks forwarded before the trip. */
  chunks: number;
  /** The error the client-facing stream was terminated with. */
  error: RouterTimeoutError;
}

/**
 * Wrap `response`'s body in an idle watchdog. Returns a NEW Response with the
 * same status/headers whose body errors (and cancels the source) once no chunk
 * has flowed for `idleMs`. Callers gate on isTimeoutEnabled + body presence +
 * NOT a websocket upgrade (a 101/webSocket response must never be
 * reconstructed); this function assumes those checks were made. `onTrip` fires
 * at most once, after the client-facing stream has been errored.
 */
export function applyStreamIdleTimeout(
  response: Response,
  idleMs: number,
  onTrip: (trip: StreamIdleTrip) => void,
): Response {
  const source = response.body;
  if (!source) return response;

  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chunks = 0;
  let settled = false;
  let controllerRef!: TransformStreamDefaultController<unknown>;

  const disarm = () => {
    settled = true;
    if (timer) clearTimeout(timer);
  };

  const trip = () => {
    if (settled) return;
    const error = new RouterTimeoutError(
      "stream-idle",
      performance.now() - start,
    );
    try {
      controllerRef.error(error);
    } catch {
      // The stream already terminated (raced a close/cancel) — nothing was
      // interrupted, so do not report a timeout.
      return;
    }
    // Erroring the transform makes the pipe abort and CANCEL the source
    // stream (React aborts the wedged render). Mark settled AFTER the error
    // took, then report.
    disarm();
    onTrip({ totalMs: error.durationMs, chunks, error });
  };

  const arm = () => {
    if (settled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(trip, idleMs);
    (timer as { unref?: () => void }).unref?.();
  };

  // `cancel` is the spec's newer transformer hook (client-side cancellation);
  // TS's lib.dom Transformer type lags it, hence the intersection. Runtimes
  // without it fall back to the settled/try-catch guards in trip().
  const transformer: Transformer<unknown, unknown> & { cancel?: () => void } = {
    start(controller) {
      controllerRef = controller;
      arm();
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
      chunks++;
      arm();
    },
    flush() {
      // Natural end of the source stream.
      disarm();
    },
    cancel() {
      disarm();
    },
  };
  const watchdog = new TransformStream<unknown, unknown>(transformer);

  return new Response(source.pipeThrough(watchdog) as ReadableStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
