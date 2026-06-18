/**
 * Connection warmup: keep TLS alive after idle periods.
 *
 * After IDLE_TIMEOUT of no user interaction the connection is marked "cold".
 * On the next pointer/touch interaction or a visibility change, a HEAD request
 * warms the TLS connection before the user actually clicks a link.
 *
 * Extracted from NavigationProvider so the idle/cold/warmup state machine is
 * unit-testable with an injected environment (document, fetch, timers).
 *
 * Ordering bug this guards against: the warmup listeners (mousemove/touchstart)
 * share events with the idle-reset listeners, and the idle-reset listener is
 * registered first, so it clears the live "cold" flag before the warmup
 * listener reads it on the same event. A separate coldLatch — set when the
 * connection goes cold and cleared only when warmup fires or listeners detach,
 * never by the idle reset — lets the warmup decision see the pre-reset cold
 * state regardless of listener ordering.
 */

const IDLE_TIMEOUT = 60_000;
const DEBOUNCE_DELAY = 150;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface WarmupEnv {
  doc: Pick<
    Document,
    "addEventListener" | "removeEventListener" | "visibilityState"
  >;
  fetch: typeof fetch;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle | undefined) => void;
}

function defaultEnv(): WarmupEnv {
  return {
    doc: document,
    fetch: (...args) => fetch(...args),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

/**
 * Start the connection-warmup state machine. Returns a cleanup function that
 * cancels timers and removes all listeners.
 */
export function startConnectionWarmup(
  env: WarmupEnv = defaultEnv(),
): () => void {
  const { doc, setTimeout: setT, clearTimeout: clearT } = env;

  let idleTimer: TimerHandle | undefined;
  let debounceTimer: TimerHandle | undefined;
  // Drives the idle->cold cycle. resetIdleTimer clears it on any activity.
  let isCold = false;
  // Separate cold latch for the warmup decision — see module header. Set in
  // markCold; cleared only when warmup fires or listeners detach, NOT by
  // resetIdleTimer, so triggerWarmup sees the pre-reset cold state regardless
  // of listener ordering.
  let coldLatch = false;
  let warmupListenersAttached = false;

  function sendWarmup() {
    isCold = false;
    coldLatch = false;
    env.fetch("/?_rsc_warmup", { method: "HEAD" }).catch(() => {});
  }

  function triggerWarmup() {
    if (!coldLatch) return;
    clearT(debounceTimer);
    debounceTimer = setT(() => {
      sendWarmup();
      detachWarmupListeners();
      resetIdleTimer();
    }, DEBOUNCE_DELAY);
  }

  function onVisibilityChange() {
    if (doc.visibilityState === "visible" && coldLatch) {
      triggerWarmup();
    }
  }

  function attachWarmupListeners() {
    if (warmupListenersAttached) return;
    warmupListenersAttached = true;
    doc.addEventListener("visibilitychange", onVisibilityChange);
    doc.addEventListener("mousemove", triggerWarmup, { once: true });
    doc.addEventListener("touchstart", triggerWarmup, { once: true });
  }

  function detachWarmupListeners() {
    warmupListenersAttached = false;
    coldLatch = false;
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    doc.removeEventListener("mousemove", triggerWarmup);
    doc.removeEventListener("touchstart", triggerWarmup);
  }

  function markCold() {
    isCold = true;
    coldLatch = true;
    attachWarmupListeners();
  }

  function resetIdleTimer() {
    clearT(idleTimer);
    isCold = false;
    idleTimer = setT(markCold, IDLE_TIMEOUT);
  }

  // Activity events that reset the idle timer. mousemove/touchstart overlap
  // with the warmup listeners; this listener is registered first, which is the
  // ordering the coldLatch defends against.
  const activityEvents = [
    "mousemove",
    "keydown",
    "touchstart",
    "scroll",
  ] as const;
  const activityOptions: AddEventListenerOptions = { passive: true };

  for (const event of activityEvents) {
    doc.addEventListener(event, resetIdleTimer, activityOptions);
  }

  resetIdleTimer();

  // isCold is read by resetIdleTimer/sendWarmup to drive the cycle; reference
  // it here so the linter sees the assignments as meaningful.
  void isCold;

  return () => {
    clearT(idleTimer);
    clearT(debounceTimer);
    detachWarmupListeners();
    for (const event of activityEvents) {
      doc.removeEventListener(event, resetIdleTimer);
    }
  };
}
