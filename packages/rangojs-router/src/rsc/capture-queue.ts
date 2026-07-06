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

/**
 * Run `task` after every previously enqueued capture has settled. Returns a
 * promise for THIS task's completion (rejections propagate to the caller —
 * the queue itself is insulated).
 */
export function enqueueSerializedCapture(
  task: () => Promise<void>,
): Promise<void> {
  const prior = captureQueue;
  let releaseQueue!: () => void;
  captureQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  return (async () => {
    await prior.catch(() => {});
    try {
      await task();
    } finally {
      releaseQueue();
    }
  })();
}
