/**
 * Per-isolate shell-capture serialization.
 *
 * Captures are CPU-bound background renders whose quiet detection is
 * task-quantized (FLIGHT_QUIET_HOPS macrotask hops with zero new bytes). Two
 * captures running concurrently starve each other: one grinding capture —
 * e.g. a prerender+ppr route whose capture round-trips the dev
 * /__rsc_prerender endpoint, whose per-request module re-import can peg a
 * slow CI runner for seconds — keeps the sibling's render byte-silent past
 * its abort budget, so the sibling freezes a trivial prelude and stores
 * nothing. Observed on GH runners as ROTATING eternal-MISS victims (the
 * warmup on one shard, a composition probe, then /ppr-shell?probe=stream once
 * the first was quieted) while every local run passed.
 *
 * Serializing capture execution removes the cross-talk: each capture's quiet
 * window observes only its own work. Captures are TTL-scale background work,
 * so queueing costs latency-to-HIT only — never a served response. On workerd
 * a queued capture rides the scheduling request's waitUntil, whose lifetime
 * is bounded; a capture killed mid-queue by that bound simply recaptures on a
 * later request (the existing best-effort contract).
 *
 * The chain link resolves in `finally` and the prior link is awaited with a
 * swallow, so one rejected capture can never wedge every later one.
 */
let captureQueue: Promise<void> = Promise.resolve();
let admittedCaptures = 0;

/** Bound queued/running capture closures retained by one isolate. */
export const MAX_ADMITTED_CAPTURES: number = 32;

/** The caller may drop this best-effort capture and retry on a later request. */
export class CaptureQueueFullError extends Error {
  constructor() {
    super(`shell capture queue is full (${MAX_ADMITTED_CAPTURES})`);
    this.name = "CaptureQueueFullError";
  }
}

/**
 * Upper bound on how long one queue link may hold the queue. A capture task
 * normally settles well inside this (attempt + in-place retry + writes), but
 * a task wedged on never-settling I/O — a workerd waitUntil fetch that pends
 * instead of rejecting (seen on GH runners with the dev prerender store
 * before its fetch was time-bounded) — must not block every later capture in
 * the isolate. At the cap the QUEUE is released; the wedged task itself stays
 * detached (its own per-key guards clean up when/if it settles).
 */
const QUEUE_LINK_CAP_MS = 60_000;

/**
 * Run `task` after every previously enqueued capture has settled. Returns a
 * promise for THIS task's completion (rejections propagate to the caller —
 * the queue itself is insulated).
 */
export function enqueueSerializedCapture(
  task: () => Promise<void>,
): Promise<void> {
  if (admittedCaptures >= MAX_ADMITTED_CAPTURES) {
    return Promise.reject(new CaptureQueueFullError());
  }
  admittedCaptures++;
  const prior = captureQueue;
  let releaseQueue!: () => void;
  captureQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  return (async () => {
    await prior.catch(() => {});
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const taskPromise = Promise.resolve()
      .then(task)
      .finally(() => {
        // A timed-out link releases serialization, but its detached task still
        // counts against admission until it actually settles.
        admittedCaptures--;
      });
    try {
      await Promise.race([
        taskPromise,
        new Promise<void>((resolve) => {
          capTimer = setTimeout(resolve, QUEUE_LINK_CAP_MS);
          (capTimer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (capTimer) clearTimeout(capTimer);
      releaseQueue();
    }
  })();
}
