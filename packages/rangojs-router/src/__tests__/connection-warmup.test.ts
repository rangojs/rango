import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startConnectionWarmup,
  type WarmupEnv,
} from "../browser/connection-warmup";

const IDLE_TIMEOUT = 60_000;
const DEBOUNCE_DELAY = 150;

interface Listener {
  type: string;
  handler: EventListener;
  options?: AddEventListenerOptions | boolean;
}

/**
 * Fake document that records listeners in registration order and dispatches
 * to them in that same order. This is what reproduces the production bug: the
 * idle-reset listener for "mousemove" is registered BEFORE the warmup listener
 * for "mousemove", so it runs first on a dispatched mousemove.
 */
function createFakeDoc() {
  let listeners: Listener[] = [];
  let visibilityState: DocumentVisibilityState = "visible";

  const doc = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener(
      type: string,
      handler: EventListener,
      options?: AddEventListenerOptions | boolean,
    ) {
      listeners.push({ type, handler, options });
    },
    removeEventListener(type: string, handler: EventListener) {
      listeners = listeners.filter(
        (l) => !(l.type === type && l.handler === handler),
      );
    },
  };

  function dispatch(type: string) {
    // Snapshot so { once } removals during dispatch don't skip siblings.
    const matching = listeners.filter((l) => l.type === type);
    for (const l of matching) {
      const once = typeof l.options === "object" && l.options?.once === true;
      if (once) {
        listeners = listeners.filter((x) => x !== l);
      }
      l.handler(new Event(type));
    }
  }

  return {
    doc: doc as unknown as WarmupEnv["doc"],
    dispatch,
    setVisibility(v: DocumentVisibilityState) {
      visibilityState = v;
    },
    listenerCount(type?: string) {
      return type
        ? listeners.filter((l) => l.type === type).length
        : listeners.length;
    },
  };
}

describe("startConnectionWarmup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const fakeDoc = createFakeDoc();
    const fetchMock = vi.fn(() => Promise.resolve(new Response()));
    const env: WarmupEnv = {
      doc: fakeDoc.doc,
      fetch: fetchMock as unknown as typeof fetch,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as any),
    };
    const cleanup = startConnectionWarmup(env);
    return { fakeDoc, fetchMock, cleanup };
  }

  it("does not warm before the idle timeout elapses", () => {
    const { fakeDoc, fetchMock, cleanup } = setup();
    // Not yet cold: a mousemove should not warm.
    fakeDoc.dispatch("mousemove");
    vi.advanceTimersByTime(DEBOUNCE_DELAY + 1);
    expect(fetchMock).not.toHaveBeenCalled();
    cleanup();
  });

  /**
   * Core regression (F1). After going idle->cold, a mousemove must fire the
   * warmup HEAD request. The idle-reset listener runs first on the same
   * mousemove and clears the live cold flag; without the separate coldLatch the
   * warmup listener reads the already-cleared flag and bails, so warmup never
   * fires on pointer/touch — only visibilitychange could warm.
   */
  it("warms on mousemove after going cold (idle-reset runs first)", () => {
    const { fakeDoc, fetchMock, cleanup } = setup();

    // Go cold.
    vi.advanceTimersByTime(IDLE_TIMEOUT);

    // Single mousemove: idle-reset listener (registered first) then warmup.
    fakeDoc.dispatch("mousemove");
    expect(fetchMock).not.toHaveBeenCalled(); // debounced

    vi.advanceTimersByTime(DEBOUNCE_DELAY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/?_rsc_warmup", { method: "HEAD" });
    cleanup();
  });

  it("warms on touchstart after going cold", () => {
    const { fakeDoc, fetchMock, cleanup } = setup();
    vi.advanceTimersByTime(IDLE_TIMEOUT);

    fakeDoc.dispatch("touchstart");
    vi.advanceTimersByTime(DEBOUNCE_DELAY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("warms on visibilitychange when cold and visible", () => {
    const { fakeDoc, fetchMock, cleanup } = setup();
    vi.advanceTimersByTime(IDLE_TIMEOUT);

    fakeDoc.setVisibility("visible");
    fakeDoc.dispatch("visibilitychange");
    vi.advanceTimersByTime(DEBOUNCE_DELAY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("does not warm on visibilitychange while hidden", () => {
    const { fakeDoc, fetchMock, cleanup } = setup();
    vi.advanceTimersByTime(IDLE_TIMEOUT);

    fakeDoc.setVisibility("hidden");
    fakeDoc.dispatch("visibilitychange");
    vi.advanceTimersByTime(DEBOUNCE_DELAY);

    expect(fetchMock).not.toHaveBeenCalled();
    cleanup();
  });

  it("only warms once per cold period (mousemove listener is once)", () => {
    const { fakeDoc, fetchMock, cleanup } = setup();
    vi.advanceTimersByTime(IDLE_TIMEOUT);

    fakeDoc.dispatch("mousemove");
    vi.advanceTimersByTime(DEBOUNCE_DELAY);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second mousemove (now warm again) must not re-warm.
    fakeDoc.dispatch("mousemove");
    vi.advanceTimersByTime(DEBOUNCE_DELAY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("cleanup removes all listeners and cancels timers", () => {
    const { fakeDoc, fetchMock, cleanup } = setup();
    vi.advanceTimersByTime(IDLE_TIMEOUT);
    cleanup();

    expect(fakeDoc.listenerCount()).toBe(0);

    // No pending warmup fires after cleanup.
    fakeDoc.dispatch("mousemove");
    vi.advanceTimersByTime(DEBOUNCE_DELAY);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
