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
 * Budget on how long a capture may WAIT in the queue before it is dropped
 * instead of run. On workerd a queued capture rides the scheduling request's
 * waitUntil, whose post-response lifetime is bounded (~30s): a capture that
 * already burned 15s+ parked behind a slow predecessor would start its own
 * up-to-15s attempt (captureTimeout) with no budget left and risk being
 * killed mid-store-write. Dropping at the budget is safe — captures are
 * best-effort by contract, and a later request re-probes the key (the drop
 * does NOT mark backoff: the route is not doomed, the isolate was busy).
 * Matches one attempt's SHELL_CAPTURE_MAX_WAIT_MS so wait + attempt fits the
 * platform budget. Field-observed: a navigation-shell capture parked ~24s
 * behind a predecessor's two-attempt cycle.
 */
export const CAPTURE_QUEUE_WAIT_BUDGET_MS: number = 15_000;

/** Thrown (async) when the queue wait exceeded the budget; the task never ran. */
export class CaptureQueueWaitTimeoutError extends Error {
  readonly waitedMs: number;
  constructor(waitedMs: number) {
    super(
      `shell capture waited ${Math.round(waitedMs)}ms in the queue ` +
        `(budget ${CAPTURE_QUEUE_WAIT_BUDGET_MS}ms)`,
    );
    this.name = "CaptureQueueWaitTimeoutError";
    this.waitedMs = waitedMs;
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
  opts?: { maxQueueWaitMs?: number },
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
    const waitStart = performance.now();
    const budget = opts?.maxQueueWaitMs ?? CAPTURE_QUEUE_WAIT_BUDGET_MS;
    // The wait itself is budget-raced: the drop fires AT the budget, not once
    // the predecessor eventually settles — a waiter parked behind a wedged
    // link must not stay pending until that link's 60s cap just to learn it
    // was already over budget.
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const waitTimedOut = await Promise.race([
      prior.catch(() => {}).then(() => false),
      new Promise<boolean>((resolve) => {
        waitTimer = setTimeout(() => resolve(true), budget);
        (waitTimer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (waitTimer) clearTimeout(waitTimer);
    if (waitTimedOut) {
      // Never started: hand the admission slot back here (the taskPromise
      // finally below does it for tasks that ran). Serialization stays
      // intact: THIS link releases only once the predecessor settles —
      // releasing now would let a successor run concurrently with it.
      admittedCaptures--;
      prior.catch(() => {}).then(releaseQueue, releaseQueue);
      throw new CaptureQueueWaitTimeoutError(performance.now() - waitStart);
    }
    try {
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
      }
    } finally {
      releaseQueue();
    }
  })();
}
