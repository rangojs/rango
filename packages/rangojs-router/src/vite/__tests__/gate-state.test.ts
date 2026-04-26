import { describe, it, expect } from "vitest";
import { createDiscoveryGate } from "../discovery/gate-state.js";

/**
 * Deterministic regression tests for the manifest-readiness gate state
 * machine. These cover the same windows the cf-stress e2e tests cover
 * (cold-start, queued, pending tail-race) but without spawning a dev
 * server — chokidar/Vite/workerd timing variation that made the e2e
 * tests probabilistic for the tail-race window doesn't apply here.
 *
 * Each test drives the machine through a specific sequence of events
 * and asserts the user-visible invariant: `s.discoveryDone` is held
 * pending until ALL queued+pending work for a burst has completed.
 */

interface Owner {
  discoveryDone: Promise<void> | null | undefined;
}

/**
 * Helper: probe whether a promise has settled without awaiting it.
 * Attaches a `.then` and flushes the microtask queue once. If the
 * promise was already settled, the `.then` callback fires inside that
 * flush; otherwise it remains pending.
 */
async function isSettled(
  p: Promise<unknown> | null | undefined,
): Promise<boolean> {
  if (!p) return false;
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // Flush microtasks. setImmediate (Node) yields after the entire
  // microtask queue, so any already-fulfilled promise's continuation
  // has run by the time this returns.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return settled;
}

describe("createDiscoveryGate", () => {
  it("beginGate creates a pending promise; resolveGate settles it", async () => {
    const s: Owner = { discoveryDone: null };
    const gate = createDiscoveryGate(s);

    gate.beginGate();
    expect(gate.state().gatePending).toBe(true);
    expect(await isSettled(s.discoveryDone)).toBe(false);

    gate.resolveGate();
    expect(gate.state().gatePending).toBe(false);
    expect(await isSettled(s.discoveryDone)).toBe(true);
  });

  it("beginGate is a no-op when already pending — preserves the existing resolver", async () => {
    // Regression: file watchers can fire multiple change/add events for
    // a single save (chokidar polling, atomic-save flows). If the second
    // beginGate replaced the resolver, the original promise would become
    // un-resolvable and workerd's manifest load() would hang.
    const s: Owner = { discoveryDone: null };
    const gate = createDiscoveryGate(s);

    gate.beginGate();
    const firstPromise = s.discoveryDone;
    gate.beginGate(); // second call must be a no-op
    expect(s.discoveryDone).toBe(firstPromise);

    gate.resolveGate();
    expect(await isSettled(firstPromise)).toBe(true);
  });

  it("resolveGate is a no-op when no gate is pending", () => {
    const s: Owner = { discoveryDone: null };
    const gate = createDiscoveryGate(s);
    expect(() => gate.resolveGate()).not.toThrow();
    expect(gate.state().gatePending).toBe(false);
  });

  it("runRefreshCycle: clean run with no events resolves the gate at the tail", async () => {
    const s: Owner = { discoveryDone: null };
    const gate = createDiscoveryGate(s);
    gate.beginGate();

    await gate.runRefreshCycle(async () => {
      // simulate work
    });

    expect(gate.state().gatePending).toBe(false);
    expect(await isSettled(s.discoveryDone)).toBe(true);
  });

  it("runRefreshCycle: noteRouteEvent during work does NOT prematurely resolve the gate (tail-race)", async () => {
    // The exact bug `pendingEvents` was added to fix. Reviewer flagged
    // that the cf-stress e2e couldn't deterministically exercise this
    // because chokidar latency could push handleRouteFileChange past
    // refresh A's finally; this unit test proves the invariant
    // synchronously.
    const s: Owner = { discoveryDone: null };
    const gate = createDiscoveryGate(s);
    gate.noteRouteEvent(); // touch 1: gate1 pending, pendingEvents=true
    expect(gate.state().pendingEvents).toBe(true);

    let finishWork: () => void;
    const workPromise = new Promise<void>((resolve) => {
      finishWork = resolve;
    });

    const cycleA = gate.runRefreshCycle(() => workPromise);
    // Inside refreshCycle.start: pendingEvents cleared, inProgress=true.
    expect(gate.state().inProgress).toBe(true);
    expect(gate.state().pendingEvents).toBe(false);

    // Touch 2 arrives DURING work. handleRouteFileChange's noteRouteEvent
    // re-sets pendingEvents.
    gate.noteRouteEvent();
    expect(gate.state().pendingEvents).toBe(true);
    // Note: queued is NOT set because the second event's debounce hasn't
    // fired yet — runRefreshCycle is only called when the debounce fires.

    // Refresh A completes.
    finishWork!();
    await cycleA;

    // Gate MUST still be pending: pendingEvents=true, queued=false.
    // Without the pendingEvents check in finally, the gate would resolve
    // here and workerd could read stale gen.
    expect(gate.state().gatePending).toBe(true);
    expect(gate.state().pendingEvents).toBe(true);
    expect(await isSettled(s.discoveryDone)).toBe(false);

    // Now simulate touch 2's debounce firing: refresh B starts.
    await gate.runRefreshCycle(async () => {
      // simulate work
    });

    // Refresh B's finally: pendingEvents=false, queued=false → resolveGate.
    expect(gate.state().gatePending).toBe(false);
    expect(await isSettled(s.discoveryDone)).toBe(true);
  });

  it("runRefreshCycle: overlap (queued path) — second call during in-flight is queued and consumed at tail", async () => {
    // Stateful work fn: each call enqueues a fresh resolver so the
    // recursive (queued) cycle has its own pending work to wait on
    // (rather than reusing an already-settled promise from A).
    const s: Owner = { discoveryDone: null };
    const gate = createDiscoveryGate(s);
    gate.noteRouteEvent();

    const resolvers: Array<() => void> = [];
    let workCallCount = 0;
    const work = () =>
      new Promise<void>((resolve) => {
        workCallCount++;
        resolvers.push(resolve);
      });

    const cycleA = gate.runRefreshCycle(work);
    expect(workCallCount).toBe(1);
    expect(gate.state().inProgress).toBe(true);

    // Second cycle attempt while A is in flight → queued=true, return.
    // The work fn is NOT called again here — the recursion will call it.
    gate.runRefreshCycle(work);
    expect(gate.state().queued).toBe(true);
    expect(workCallCount).toBe(1);

    // Finish work #1.
    resolvers[0]!();
    await cycleA;

    // A's finally consumed the queue and fire-and-forget recursed. The
    // recursion called work() again (work #2) which is now pending —
    // so we should see inProgress=true and a fresh promise in flight.
    // Flush microtasks so the recursion's start runs.
    await new Promise((r) => setImmediate(r));

    expect(workCallCount).toBe(2);
    expect(gate.state().queued).toBe(false);
    expect(gate.state().inProgress).toBe(true);
    expect(gate.state().gatePending).toBe(true);
    expect(await isSettled(s.discoveryDone)).toBe(false);

    // Finish work #2 — the recursion's finally resolves the gate.
    resolvers[1]!();
    await new Promise((r) => setImmediate(r));

    expect(gate.state().gatePending).toBe(false);
    expect(gate.state().inProgress).toBe(false);
    expect(await isSettled(s.discoveryDone)).toBe(true);
  });

  it("runRefreshCycle: combined queued + pendingEvents flows through correctly", async () => {
    // Cycle A in flight → queue cycle B → pending event arrives →
    // A's finally consumes queue (recurse) → recursion's start clears
    // pendingEvents and runs work → recursion's finally resolves gate.
    const s: Owner = { discoveryDone: null };
    const gate = createDiscoveryGate(s);
    gate.noteRouteEvent();

    let finishA: () => void;
    const aWork = new Promise<void>((r) => {
      finishA = r;
    });
    const cycleA = gate.runRefreshCycle(() => aWork);

    // Queue B by attempting another runRefreshCycle.
    gate.runRefreshCycle(async () => {});
    expect(gate.state().queued).toBe(true);

    // Fire a pending event during work too — both flags now set.
    gate.noteRouteEvent();
    expect(gate.state().pendingEvents).toBe(true);
    expect(gate.state().queued).toBe(true);

    finishA!();
    await cycleA;

    // Recursion drains queued + pending in one go.
    await new Promise((r) => setTimeout(r, 0));

    expect(gate.state().gatePending).toBe(false);
  });

  it("runRefreshCycle: thrown work still releases gate at the tail", async () => {
    const s: Owner = { discoveryDone: null };
    const gate = createDiscoveryGate(s);
    gate.noteRouteEvent();

    // Work throws; catch propagation is in caller — runRefreshCycle's
    // finally runs regardless and resolves the gate (no events queued).
    await expect(
      gate.runRefreshCycle(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(gate.state().gatePending).toBe(false);
    expect(await isSettled(s.discoveryDone)).toBe(true);
  });

  it("runRefreshCycle: thrown work in a queued cycle still releases the gate", async () => {
    // The recursive queued cycle uses fire-and-forget. If its work throws,
    // the .catch handler in the implementation must release the gate.
    const s: Owner = { discoveryDone: null };
    const gate = createDiscoveryGate(s);
    gate.noteRouteEvent();

    let finishA: () => void;
    let aResolved = false;
    const aWork = new Promise<void>((r) => {
      finishA = () => {
        aResolved = true;
        r();
      };
    });

    let throwOnNextCall = false;
    const work = () =>
      throwOnNextCall ? Promise.reject(new Error("queued boom")) : aWork;

    const cycleA = gate.runRefreshCycle(work);
    // Queue another with the same work fn — but switch to "throw on
    // next call" before the recursion happens.
    gate.runRefreshCycle(work);
    throwOnNextCall = true;

    finishA!();
    await cycleA;
    expect(aResolved).toBe(true);

    // Drain microtasks for the queued recursion's catch.
    await new Promise((r) => setTimeout(r, 0));

    expect(gate.state().gatePending).toBe(false);
    expect(await isSettled(s.discoveryDone)).toBe(true);
  });
});
