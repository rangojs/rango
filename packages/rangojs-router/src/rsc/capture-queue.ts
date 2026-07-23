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
 * Document shells outrank queued navigation-only snapshots. Production Link
 * prefetching can enqueue several expensive navigation captures at once; a
 * strict FIFO made the requesting page's document capture wait
 * behind speculative work until its queue budget expired. The active capture
 * is never interrupted, and each priority remains FIFO.
 */
let admittedCaptures = 0;
let captureRunning = false;

interface QueuedCapture {
  waitStart: number;
  state: "waiting" | "running" | "settled";
  signalStart: () => void;
}

const documentCaptures: QueuedCapture[] = [];
const navigationCaptures: QueuedCapture[] = [];

/** Bound queued/running capture closures retained by one isolate. */
export const MAX_ADMITTED_CAPTURES: number = 32;

/** Point-in-time queue occupancy, for capture-scheduling telemetry. */
export interface CaptureQueueDepths {
  /** A capture is currently executing (never preempted). */
  running: boolean;
  /** Waiting document-priority captures (run before every navigation capture). */
  document: number;
  /** Waiting navigation-priority captures. */
  navigation: number;
}

/**
 * Snapshot the queue's waiting/running state. Wait-timed-out entries still
 * sitting in the arrays (pruned lazily by takeNextCapture) are excluded — they
 * will never run, so counting them would overstate the backlog.
 */
export function captureQueueDepths(): CaptureQueueDepths {
  const waiting = (queue: QueuedCapture[]): number => {
    let count = 0;
    for (const queued of queue) if (queued.state === "waiting") count++;
    return count;
  };
  return {
    running: captureRunning,
    document: waiting(documentCaptures),
    navigation: waiting(navigationCaptures),
  };
}

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
 * Upper bound on how long one running capture may hold the queue. A capture task
 * normally settles well inside this (attempt + in-place retry + writes), but
 * a task wedged on never-settling I/O — a workerd waitUntil fetch that pends
 * instead of rejecting (seen on GH runners with the dev prerender store
 * before its fetch was time-bounded) — must not block every later capture in
 * the isolate. At the cap the QUEUE is released; the wedged task itself stays
 * detached (its own per-key guards clean up when/if it settles).
 */
const QUEUE_LINK_CAP_MS = 60_000;

/**
 * Run `task` after the active capture and every higher/equal-priority capture
 * ahead of it have settled. Returns a promise for THIS task's completion
 * (rejections propagate to the caller — the queue itself is insulated).
 */
export function enqueueSerializedCapture(
  task: () => Promise<void>,
  opts?: {
    maxQueueWaitMs?: number;
    priority?: "document" | "navigation";
  },
): Promise<void> {
  if (admittedCaptures >= MAX_ADMITTED_CAPTURES) {
    return Promise.reject(new CaptureQueueFullError());
  }
  admittedCaptures++;

  let signalStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  const queued: QueuedCapture = {
    waitStart: performance.now(),
    state: "waiting",
    signalStart,
  };

  const completion = (async () => {
    const budget = opts?.maxQueueWaitMs ?? CAPTURE_QUEUE_WAIT_BUDGET_MS;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const waitTimedOut = await Promise.race([
      startGate.then(() => false),
      new Promise<boolean>((resolve) => {
        waitTimer = setTimeout(() => {
          if (queued.state !== "waiting") return;
          queued.state = "settled";
          admittedCaptures--;
          resolve(true);
        }, budget);
        (waitTimer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (waitTimer) clearTimeout(waitTimer);
    if (waitTimedOut) {
      throw new CaptureQueueWaitTimeoutError(
        performance.now() - queued.waitStart,
      );
    }

    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const taskPromise = Promise.resolve()
      .then(task)
      .finally(() => {
        // A capped capture releases serialization, but its detached task still
        // counts against admission until it actually settles.
        admittedCaptures--;
      });
    const cap = new Promise<void>((resolve) => {
      capTimer = setTimeout(resolve, QUEUE_LINK_CAP_MS);
      (capTimer as { unref?: () => void }).unref?.();
    });

    try {
      await Promise.race([taskPromise, cap]);
    } finally {
      if (capTimer) clearTimeout(capTimer);
      queued.state = "settled";
      captureRunning = false;
      // Handoff must happen before this caller's waitUntil promise settles.
      // Resolving first lets workerd terminate the context with the queue lock
      // still held, permanently parking later captures in the isolate.
      startNextCapture();
    }
  })();

  const queue =
    opts?.priority === "document" ? documentCaptures : navigationCaptures;
  queue.push(queued);
  startNextCapture();
  return completion;
}

function takeNextCapture(): QueuedCapture | undefined {
  for (const queue of [documentCaptures, navigationCaptures]) {
    let queued: QueuedCapture | undefined;
    while ((queued = queue.shift())) {
      if (queued.state === "waiting") return queued;
    }
  }
  return undefined;
}

function startNextCapture(): void {
  if (captureRunning) return;
  const queued = takeNextCapture();
  if (!queued) return;

  captureRunning = true;
  queued.state = "running";
  queued.signalStart();
}
