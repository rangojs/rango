import type { Debugger } from "../debug.js";

/**
 * Manifest-readiness gate + rediscovery scheduler.
 *
 * Owns the four pieces of state that cooperate to keep
 * `s.discoveryDone` (the promise the manifest virtual module's `load()`
 * hook awaits) consistent across HMR fan-out:
 *
 *   - **gatePending**: a Promise has been issued and not yet resolved.
 *     Workerd's manifest virtual module load() is blocked on it.
 *   - **inProgress**: a refresh's work callback is currently executing.
 *   - **queued**: a refresh was attempted while one was already in
 *     flight; the active run consumes this in its `finally` and
 *     recurses.
 *   - **pendingEvents**: a route-file event has been received (gate
 *     already reset) but the corresponding refresh's work hasn't started
 *     yet — i.e. the debounce hasn't fired. Set in `noteRouteEvent`,
 *     cleared at the start of each refresh cycle. Refresh's finally MUST
 *     hold the gate if this is true even when `queued` is false,
 *     otherwise an event whose debounce fires AFTER the active refresh
 *     completes (the "tail-race" window) would observe a resolved gate.
 *
 * The HMR-event flow (cloudflare-stress repro):
 *
 *   t=0    Touch 1  → noteRouteEvent  → pendingEvents=true, beginGate
 *                                      (gate1 pending)
 *          → debounce 100ms
 *   t=100  runRefreshCycle(work)      → clear pendingEvents, work starts
 *   t=750  Touch 2  → noteRouteEvent  → pendingEvents=true (no-op gate)
 *                                      → debounce fires at t=850
 *   t=800  refresh A's finally        → queued=false, pendingEvents=true
 *                                      → HOLD gate (don't resolve)
 *   t=850  runRefreshCycle (debounce) → clear pendingEvents, work starts
 *   t=1500 refresh B's finally        → queued=false, pendingEvents=false
 *                                      → resolveGate (gate1 resolves)
 *
 * @internal Exported only for unit tests.
 */
export interface DiscoveryGate {
  /**
   * Reset the gate to a fresh pending Promise via `s.discoveryDone`.
   * No-op when a gate is already pending — file watchers can fire
   * multiple events for one save, and replacing the resolver would
   * orphan the original promise (workerd's manifest load() would hang).
   */
  beginGate(): void;
  /**
   * Resolve the current pending gate. No-op when no gate is pending.
   * Called at the tail of the last refresh cycle in a burst.
   */
  resolveGate(): void;
  /**
   * Record that a route-file event has arrived. Sets `pendingEvents`
   * and begins the gate. Idempotent for both flags.
   */
  noteRouteEvent(): void;
  /**
   * Run one refresh cycle, managing queue + pending state around it.
   * If a cycle is already in flight, sets `queued=true` and returns.
   * Otherwise clears `pendingEvents`, runs `work`, and in `finally`:
   *
   *   - queued        → recurse, gate stays pending
   *   - pendingEvents → hold gate (next debounced cycle resolves)
   *   - neither       → resolveGate
   */
  runRefreshCycle(work: () => Promise<void>): Promise<void>;
  /** Snapshot of internal state. Test-only. */
  readonly state: () => Readonly<{
    gatePending: boolean;
    inProgress: boolean;
    queued: boolean;
    pendingEvents: boolean;
  }>;
}

/** State container the gate writes `discoveryDone` into. */
export interface GateOwner {
  discoveryDone: Promise<void> | null | undefined;
}

export function createDiscoveryGate(
  s: GateOwner,
  debug?: Debugger,
): DiscoveryGate {
  let gatePending = false;
  let gateResolver: () => void = () => {};
  let inProgress = false;
  let queued = false;
  let pendingEvents = false;

  const beginGate = (): void => {
    if (gatePending) return;
    s.discoveryDone = new Promise<void>((resolve) => {
      gateResolver = resolve;
    });
    gatePending = true;
  };

  const resolveGate = (): void => {
    if (!gatePending) return;
    // Defer resolution while a refresh cycle is in flight or queued, or
    // while an unprocessed route-file event is pending its debounce.
    // Without this guard, cold-start's `discover().then(resolveGate)`
    // could fire while an HMR-triggered runRefreshCycle is mid-flight,
    // prematurely unblocking workerd's manifest load() against the
    // stale cold-start gen. The active cycle's `finally` calls
    // resolveGate again at the tail and finishes the resolution then.
    if (inProgress || queued || pendingEvents) {
      debug?.(
        "hmr: resolveGate deferred — work in flight (inProgress=%s queued=%s pendingEvents=%s)",
        inProgress,
        queued,
        pendingEvents,
      );
      return;
    }
    gatePending = false;
    debug?.("hmr: discoveryDone resolved");
    gateResolver();
  };

  const noteRouteEvent = (): void => {
    pendingEvents = true;
    beginGate();
  };

  const runRefreshCycle = async (work: () => Promise<void>): Promise<void> => {
    if (inProgress) {
      queued = true;
      debug?.("hmr: rediscovery in flight — queued for a follow-up cycle");
      return;
    }
    // Snapshot the current pendingEvents into "we're about to process";
    // events arriving from now on re-set it.
    pendingEvents = false;
    inProgress = true;
    try {
      await work();
    } finally {
      inProgress = false;
      if (queued) {
        queued = false;
        debug?.("hmr: consuming queued rediscovery");
        runRefreshCycle(work).catch((err: unknown) => {
          debug?.(
            "hmr: queued cycle rejected — releasing gate (%s)",
            err instanceof Error ? err.message : String(err),
          );
          // Belt-and-suspenders: even if the queued cycle's own try/catch
          // missed something, ensure workerd doesn't hang.
          resolveGate();
        });
      } else if (pendingEvents) {
        debug?.(
          "hmr: holding gate for pending events (debounce not yet fired)",
        );
      } else {
        resolveGate();
      }
    }
  };

  return {
    beginGate,
    resolveGate,
    noteRouteEvent,
    runRefreshCycle,
    state: () => ({ gatePending, inProgress, queued, pendingEvents }),
  };
}
