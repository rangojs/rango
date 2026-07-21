import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createEventController,
  subscribeToLocationChange,
  type EventController,
} from "../browser/event-controller.js";

// All tests use fake timers because the controller debounces notifications
// via setTimeout(0) and settles actions after 100ms.

function loc(path = "/"): URL {
  return new URL(path, "http://localhost");
}

function createController(path = "/") {
  return createEventController({ initialLocation: loc(path) });
}

describe("createEventController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ======================================================================
  // Initial State
  // ======================================================================

  describe("initial state", () => {
    it("starts idle with no pending navigation or actions", () => {
      const ctrl = createController();
      const state = ctrl.getState();
      expect(state.state).toBe("idle");
      expect(state.isStreaming).toBe(false);
      expect(state.pendingUrl).toBeNull();
      expect(state.inflightActions).toEqual([]);
    });

    it("uses provided initialLocation", () => {
      const ctrl = createController("/products");
      expect(ctrl.getState().location.pathname).toBe("/products");
    });

    it("returns idle action state for unknown action", () => {
      const ctrl = createController();
      const actionState = ctrl.getActionState("unknown");
      expect(actionState.state).toBe("idle");
      expect(actionState.actionId).toBeNull();
      expect(actionState.payload).toBeNull();
      expect(actionState.error).toBeNull();
      expect(actionState.result).toBeNull();
    });
  });

  describe("location subscriptions", () => {
    it("fans out through one controller subscription", () => {
      let location = loc("/");
      const controllerListeners = new Set<() => void>();
      const unsubscribe = vi.fn();
      const subscribe = vi.fn((listener: () => void) => {
        controllerListeners.add(listener);
        return unsubscribe;
      });
      const controller = {
        getState: () => ({ location }),
        subscribe,
      } as unknown as Pick<EventController, "getState" | "subscribe">;
      const first = vi.fn();
      const second = vi.fn();

      const stopFirst = subscribeToLocationChange(controller, first);
      const stopSecond = subscribeToLocationChange(controller, second);
      expect(subscribe).toHaveBeenCalledOnce();

      location = loc("/next");
      controllerListeners.forEach((listener) => listener());
      expect(first).toHaveBeenCalledWith(location.href);
      expect(second).toHaveBeenCalledWith(location.href);

      stopFirst();
      expect(unsubscribe).not.toHaveBeenCalled();
      stopSecond();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it("tracks each registration baseline and cleanup independently", () => {
      let location = loc("/");
      const controllerListeners = new Set<() => void>();
      const unsubscribe = vi.fn();
      const subscribe = vi.fn((listener: () => void) => {
        controllerListeners.add(listener);
        return unsubscribe;
      });
      const controller = {
        getState: () => ({ location }),
        subscribe,
      } as unknown as Pick<EventController, "getState" | "subscribe">;
      const listener = vi.fn();

      const stopFirst = subscribeToLocationChange(controller, listener);
      location = loc("/next");
      const stopSecond = subscribeToLocationChange(controller, listener);
      controllerListeners.forEach((current) => current());
      expect(listener).toHaveBeenCalledOnce();

      stopFirst();
      stopFirst();
      expect(unsubscribe).not.toHaveBeenCalled();
      location = loc("/last");
      controllerListeners.forEach((current) => current());
      expect(listener).toHaveBeenCalledTimes(2);

      stopSecond();
      stopSecond();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it("does not notify a registration removed during fan-out", () => {
      let location = loc("/");
      let notifyController!: () => void;
      const unsubscribe = vi.fn();
      const controller = {
        getState: () => ({ location }),
        subscribe: vi.fn((listener: () => void) => {
          notifyController = listener;
          return unsubscribe;
        }),
      } as unknown as Pick<EventController, "getState" | "subscribe">;
      let stopSecond!: () => void;
      const first = vi.fn(() => stopSecond());
      const second = vi.fn();

      const stopFirst = subscribeToLocationChange(controller, first);
      stopSecond = subscribeToLocationChange(controller, second);
      location = loc("/next");
      notifyController();

      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
      stopFirst();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it("does not regress later listeners after a nested notification", () => {
      let location = loc("/");
      let notifyController!: () => void;
      const controller = {
        getState: () => ({ location }),
        subscribe: vi.fn((listener: () => void) => {
          notifyController = listener;
          return vi.fn();
        }),
      } as unknown as Pick<EventController, "getState" | "subscribe">;
      const first = vi.fn((href: string) => {
        if (href === loc("/next").href) {
          location = loc("/last");
          notifyController();
        }
      });
      const second = vi.fn();

      const stopFirst = subscribeToLocationChange(controller, first);
      const stopSecond = subscribeToLocationChange(controller, second);
      location = loc("/next");
      notifyController();

      expect(first).toHaveBeenNthCalledWith(1, loc("/next").href);
      expect(first).toHaveBeenNthCalledWith(2, loc("/last").href);
      expect(second).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledWith(loc("/last").href);
      stopFirst();
      stopSecond();
    });

    it("notifies later registrations when an earlier listener throws", () => {
      let location = loc("/");
      let notifyController!: () => void;
      const controller = {
        getState: () => ({ location }),
        subscribe: vi.fn((listener: () => void) => {
          notifyController = listener;
          return vi.fn();
        }),
      } as unknown as Pick<EventController, "getState" | "subscribe">;
      const second = vi.fn();
      const error = new Error("first failed");
      const stopFirst = subscribeToLocationChange(controller, () => {
        throw error;
      });
      const stopSecond = subscribeToLocationChange(controller, second);

      location = loc("/next");
      let thrown: unknown;
      try {
        notifyController();
      } catch (current) {
        thrown = current;
      }
      expect(thrown).toBe(error);
      expect(second).toHaveBeenCalledWith(location.href);

      stopFirst();
      stopSecond();
    });

    it("aggregates every location-listener error after fan-out", () => {
      let location = loc("/");
      let notifyController!: () => void;
      const controller = {
        getState: () => ({ location }),
        subscribe: vi.fn((listener: () => void) => {
          notifyController = listener;
          return vi.fn();
        }),
      } as unknown as Pick<EventController, "getState" | "subscribe">;
      const firstError = new Error("first failed");
      const secondError = new Error("second failed");
      const third = vi.fn();
      subscribeToLocationChange(controller, () => {
        throw firstError;
      });
      subscribeToLocationChange(controller, () => {
        throw secondError;
      });
      subscribeToLocationChange(controller, third);

      location = loc("/next");
      let thrown: unknown;
      try {
        notifyController();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([
        firstError,
        secondError,
      ]);
      expect(third).toHaveBeenCalledOnce();
    });

    it("notifies raw controller subscribers after a location listener throws", () => {
      const controller = createController();
      const stopLocation = subscribeToLocationChange(controller, () => {
        throw new Error("location failed");
      });
      const rawListener = vi.fn();
      const stopRaw = controller.subscribe(rawListener);

      controller.setLocation(loc("/next"));
      expect(() => vi.runOnlyPendingTimers()).toThrow("location failed");
      expect(rawListener).toHaveBeenCalledOnce();

      stopLocation();
      stopRaw();
    });

    it("does not notify a raw subscriber removed during dispatch", () => {
      const controller = createController();
      let stopSecond!: () => void;
      const first = vi.fn(() => stopSecond());
      const second = vi.fn();
      const stopFirst = controller.subscribe(first);
      stopSecond = controller.subscribe(second);

      controller.setLocation(loc("/next"));
      vi.runOnlyPendingTimers();

      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
      stopFirst();
    });
  });

  // ======================================================================
  // Navigation Operations
  // ======================================================================

  describe("navigation", () => {
    it("startNavigation transitions state to loading with pendingUrl", () => {
      const ctrl = createController();
      ctrl.startNavigation("/about");
      const state = ctrl.getState();
      expect(state.state).toBe("loading");
      expect(state.pendingUrl).toBe("/about");
    });

    it("complete updates location and returns to idle", () => {
      const ctrl = createController();
      const handle = ctrl.startNavigation("/about");
      handle.complete(loc("/about"));

      const state = ctrl.getState();
      expect(state.state).toBe("idle");
      expect(state.location.pathname).toBe("/about");
      expect(state.pendingUrl).toBeNull();
      expect(handle.completed).toBe(true);
    });

    it("switchMap: new navigation aborts previous", () => {
      const ctrl = createController();
      const first = ctrl.startNavigation("/page1");
      const second = ctrl.startNavigation("/page2");

      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(false);
      expect(ctrl.getState().pendingUrl).toBe("/page2");
    });

    it("abortNavigation clears current navigation", () => {
      const ctrl = createController();
      ctrl.startNavigation("/about");
      ctrl.abortNavigation();

      expect(ctrl.getState().state).toBe("idle");
      expect(ctrl.getState().pendingUrl).toBeNull();
      expect(ctrl.getCurrentNavigation()).toBeNull();
    });

    it("abortNavigation is a no-op when idle", () => {
      const ctrl = createController();
      ctrl.abortNavigation(); // should not throw
      expect(ctrl.getState().state).toBe("idle");
    });

    it("streaming token increments/decrements active streams", () => {
      const ctrl = createController();
      const handle = ctrl.startNavigation("/about");
      const token = handle.startStreaming();

      // pendingUrl is null during streaming (already fetched)
      // but isStreaming is true
      expect(ctrl.getState().isStreaming).toBe(true);

      token.end();
      handle.complete(loc("/about"));
      expect(ctrl.getState().isStreaming).toBe(false);
    });

    it("streaming token end is idempotent", () => {
      const ctrl = createController();
      const handle = ctrl.startNavigation("/about");
      const token = handle.startStreaming();
      token.end();
      token.end(); // second call should be a no-op
      handle.complete(loc("/about"));
      expect(ctrl.getState().state).toBe("idle");
    });

    it("Symbol.dispose cleans up if not completed", () => {
      const ctrl = createController();
      const handle = ctrl.startNavigation("/about");
      handle[Symbol.dispose]();

      expect(ctrl.getState().state).toBe("idle");
      expect(ctrl.getCurrentNavigation()).toBeNull();
    });

    it("Symbol.dispose is a no-op if navigation was aborted by another", () => {
      const ctrl = createController();
      const first = ctrl.startNavigation("/page1");
      ctrl.startNavigation("/page2"); // aborts first

      first[Symbol.dispose](); // should not clear second navigation
      expect(ctrl.getState().pendingUrl).toBe("/page2");
    });

    it("Symbol.dispose is a no-op if already completed", () => {
      const ctrl = createController();
      const handle = ctrl.startNavigation("/about");
      handle.complete(loc("/about"));
      handle[Symbol.dispose](); // should not reset state
      expect(ctrl.getState().location.pathname).toBe("/about");
    });

    it("complete is a no-op if navigation was replaced", () => {
      const ctrl = createController();
      const first = ctrl.startNavigation("/page1");
      ctrl.startNavigation("/page2");

      first.complete(loc("/page1")); // should not update location
      expect(ctrl.getState().location.pathname).toBe("/");
    });
  });

  // ======================================================================
  // setLocation
  // ======================================================================

  describe("setLocation", () => {
    it("updates location without navigation", () => {
      const ctrl = createController();
      ctrl.setLocation(loc("/popstate-target"));
      expect(ctrl.getState().location.pathname).toBe("/popstate-target");
    });
  });

  // ======================================================================
  // Action Operations
  // ======================================================================

  describe("actions", () => {
    it("startAction creates an inflight action in loading state", () => {
      const ctrl = createController();
      ctrl.startAction("hash#addToCart", [1]);

      const state = ctrl.getState();
      expect(state.state).toBe("loading");
      expect(state.inflightActions).toHaveLength(1);
      expect(state.inflightActions[0].actionId).toBe("hash#addToCart");
      expect(state.inflightActions[0].payload).toEqual([1]);
    });

    it("getActionState returns loading for fetching action", () => {
      const ctrl = createController();
      ctrl.startAction("hash#addToCart", ["item-1"]);

      const actionState = ctrl.getActionState("hash#addToCart");
      expect(actionState.state).toBe("loading");
      expect(actionState.actionId).toBe("hash#addToCart");
      expect(actionState.payload).toEqual(["item-1"]);
    });

    it("getActionState suffix matching: 'addToCart' matches 'hash#addToCart'", () => {
      const ctrl = createController();
      ctrl.startAction("hash#addToCart", []);

      const actionState = ctrl.getActionState("addToCart");
      expect(actionState.state).toBe("loading");
      expect(actionState.actionId).toBe("hash#addToCart");
    });

    it("getActionState exact matching when subscription has #", () => {
      const ctrl = createController();
      ctrl.startAction("hash#addToCart", []);
      ctrl.startAction("other#addToCart", []);

      // Exact match: only gets the matching action
      const state = ctrl.getActionState("hash#addToCart");
      expect(state.actionId).toBe("hash#addToCart");
    });

    it("action streaming lifecycle", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);

      // Start streaming
      const token = handle.startStreaming();
      expect(ctrl.getActionState("save").state).toBe("streaming");

      // End streaming, then complete
      token.end();
      handle.complete("saved!");

      // After settlement delay (100ms), action is cleaned up
      vi.advanceTimersByTime(100);
      expect(ctrl.getActionState("save").state).toBe("idle");
    });

    it("action complete without streaming finalizes immediately", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#delete", [42]);
      handle.complete("deleted");

      // Phase is settling, but result is accessible
      const actionState = ctrl.getActionState("delete");
      expect(actionState.result).toBe("deleted");
      expect(actionState.state).toBe("idle"); // settling maps to idle

      // After 100ms, entry is removed
      vi.advanceTimersByTime(100);
      expect(ctrl.getInflightActions().size).toBe(0);
    });

    it("action fail sets error", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);
      handle.fail(new Error("network error"));

      const actionState = ctrl.getActionState("save");
      expect(actionState.error).toBeInstanceOf(Error);
      expect(actionState.state).toBe("idle"); // settling

      vi.advanceTimersByTime(100);
      expect(ctrl.getInflightActions().size).toBe(0);
    });

    it("complete and fail are no-ops after settlement", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);
      handle.complete("first");
      vi.advanceTimersByTime(100); // settle

      handle.complete("second"); // no-op
      handle.fail("error"); // no-op
      expect(ctrl.getInflightActions().size).toBe(0);
    });

    it("action complete waits for streaming to end before finalizing", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);
      const token = handle.startStreaming();

      handle.complete("result");

      // Action is complete but streaming hasn't ended - should still be streaming
      expect(ctrl.getActionState("save").state).toBe("streaming");
      expect(handle.settled).toBe(false);

      // End streaming - now it finalizes
      token.end();
      expect(ctrl.getActionState("save").state).toBe("idle"); // settling
      expect(handle.settled).toBe(true);
    });

    it("action fail waits for streaming to end before finalizing", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);
      const token = handle.startStreaming();

      handle.fail(new Error("fail"));

      // Still streaming
      expect(ctrl.getActionState("save").state).toBe("streaming");

      token.end();
      expect(ctrl.getActionState("save").error).toBeInstanceOf(Error);
    });

    it("Symbol.dispose force-finalizes if action was not completed", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);
      handle[Symbol.dispose]();

      // Action should be settling
      const state = ctrl.getActionState("save");
      expect(state.state).toBe("idle"); // settling maps to idle

      vi.advanceTimersByTime(100);
      expect(ctrl.getInflightActions().size).toBe(0);
    });

    it("Symbol.dispose is a no-op if action was already completed", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);
      handle.complete("ok");
      handle[Symbol.dispose](); // should not throw or double-settle
      expect(handle.settled).toBe(true);
    });

    it("Symbol.dispose cleans up immediately if aborted", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);
      handle.abort.abort();
      handle[Symbol.dispose]();

      // Action removed immediately, no settlement
      expect(ctrl.getInflightActions().size).toBe(0);
    });

    it("streaming token end is idempotent for actions", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);
      const token = handle.startStreaming();
      token.end();
      token.end(); // no-op
      handle.complete("ok");
      vi.advanceTimersByTime(100);
      expect(ctrl.getInflightActions().size).toBe(0);
    });
  });

  // ======================================================================
  // Concurrent Actions & Consolidation
  // ======================================================================

  describe("concurrent actions", () => {
    it("tracks hadConcurrentActions when multiple actions overlap", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#a", []);
      const second = ctrl.startAction("hash#b", []);

      expect(first.hadConcurrentActions).toBe(false); // first had no prior
      expect(second.hadConcurrentActions).toBe(true); // second saw first
    });

    // #675: a completed action lingers in inflightActions for the 100ms
    // doSettle window. An action starting inside that window is sequential,
    // not concurrent — latching hadAnyConcurrentActions here made the second
    // action classify as consolidation-needed, and its consolidation refetch
    // re-ran revalidate-gated loaders as "new-segment" on a plain GET.
    it("action starting during a completed action's settle window is not concurrent (#675)", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#target", []);
      first.recordRevalidatedSegments(["R0D0.loaderA", "R0"]);
      first.complete("done");

      // Inside the 100ms settle window: first is completed but still in the map.
      vi.advanceTimersByTime(50);
      expect(ctrl.getInflightActions().size).toBe(1);

      const second = ctrl.startAction("hash#decoy", []);
      expect(second.hadConcurrentActions).toBe(false);
      expect(ctrl.hadAnyConcurrentActions()).toBe(false);
    });

    it("action starting after complete() but before stream end is not concurrent (#675)", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#target", []);
      const token = first.startStreaming();
      // Response fully processed and applied; the Flight stream's EOF is
      // still draining (token not ended) — entry.completed is set, phase is
      // still "streaming".
      first.complete("done");

      const second = ctrl.startAction("hash#decoy", []);
      expect(second.hadConcurrentActions).toBe(false);
      expect(ctrl.hadAnyConcurrentActions()).toBe(false);

      token.end();
      vi.advanceTimersByTime(100);
    });

    it("action starting while another is still fetching stays concurrent", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#a", []);

      const second = ctrl.startAction("hash#b", []);
      expect(second.hadConcurrentActions).toBe(true);
      expect(ctrl.hadAnyConcurrentActions()).toBe(true);

      first.complete();
      second.complete();
    });

    it("recordRevalidatedSegments accumulates into shared set", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#a", []);
      const second = ctrl.startAction("hash#b", []);

      first.recordRevalidatedSegments(["seg1", "seg2"]);
      second.recordRevalidatedSegments(["seg2", "seg3"]);

      // getRevalidatedSegments returns the raw shared set
      const segments = second.getRevalidatedSegments();
      expect(segments.has("seg1")).toBe(true);
      expect(segments.has("seg2")).toBe(true);
      expect(segments.has("seg3")).toBe(true);
      expect(segments.size).toBe(3);
    });

    it("getRevalidatedSegments returns empty set when no segments recorded", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#a", []);
      expect(handle.getRevalidatedSegments().size).toBe(0);
    });

    it("clearConsolidation resets tracking", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#a", []);
      const second = ctrl.startAction("hash#b", []);

      first.recordRevalidatedSegments(["seg1"]);
      first.complete();
      second.clearConsolidation();

      expect(second.getRevalidatedSegments().size).toBe(0);
    });

    it("settlement of last action resets concurrent tracking", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#a", []);
      const second = ctrl.startAction("hash#b", []);

      first.recordRevalidatedSegments(["seg1"]);
      first.complete();
      second.complete();

      vi.advanceTimersByTime(100); // settle first
      vi.advanceTimersByTime(100); // settle second

      // All actions cleaned up, concurrent tracking reset
      expect(ctrl.getInflightActions().size).toBe(0);
    });

    it("abortAllActions clears all inflight actions and tracking", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#a", []);
      const second = ctrl.startAction("hash#b", []);

      first.recordRevalidatedSegments(["seg1"]);

      ctrl.abortAllActions();

      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(true);
      expect(ctrl.getInflightActions().size).toBe(0);
      expect(ctrl.getState().state).toBe("idle");
    });

    describe("location-state claim (dispatch-order wins, cohort-scoped)", () => {
      // Same cohort (history key) for the same-entry concurrency cases; passed
      // to startAction so arbitration is scoped to that entry.
      const K = "kA";

      it("claims distinct keys for every concurrent action", () => {
        const ctrl = createController();
        const a = ctrl.startAction("hash#a", [], K);
        const b = ctrl.startAction("hash#b", [], K);

        expect(a.claimLocationState({ __rsc_ls_x: 1 })).toEqual({
          __rsc_ls_x: 1,
        });
        expect(b.claimLocationState({ __rsc_ls_y: 2 })).toEqual({
          __rsc_ls_y: 2,
        });
      });

      it("same key: last-initiated wins even when it claims first (settles first)", () => {
        const ctrl = createController();
        const first = ctrl.startAction("hash#a", [], K); // initiated first
        const second = ctrl.startAction("hash#b", [], K); // initiated later

        // last-initiated settles first -> claims and wins the key.
        expect(second.claimLocationState({ __rsc_ls_k: "second" })).toEqual({
          __rsc_ls_k: "second",
        });
        // first-initiated settles last -> must NOT reclaim it (dispatch-order,
        // not settle-order, decides the winner).
        expect(first.claimLocationState({ __rsc_ls_k: "first" })).toEqual({});
      });

      it("same key: last-initiated wins when it claims last (settles last)", () => {
        const ctrl = createController();
        const first = ctrl.startAction("hash#a", [], K);
        const second = ctrl.startAction("hash#b", [], K);

        // first-initiated settles first -> provisionally wins (transiently).
        expect(first.claimLocationState({ __rsc_ls_k: "first" })).toEqual({
          __rsc_ls_k: "first",
        });
        // last-initiated settles last -> still wins on arrival (overrides).
        expect(second.claimLocationState({ __rsc_ls_k: "second" })).toEqual({
          __rsc_ls_k: "second",
        });
      });

      it("a partial claim keeps winning distinct keys and drops only lost keys", () => {
        const ctrl = createController();
        const first = ctrl.startAction("hash#a", [], K);
        const second = ctrl.startAction("hash#b", [], K);

        // last-initiated wins the shared key.
        second.claimLocationState({ __rsc_ls_shared: "second" });
        // first-initiated wins its own distinct key but loses the shared one.
        expect(
          first.claimLocationState({
            __rsc_ls_shared: "first",
            __rsc_ls_own: "kept",
          }),
        ).toEqual({ __rsc_ls_own: "kept" });
      });

      it("scopes arbitration by cohort: same slot on different entries does not compete", () => {
        const ctrl = createController();
        const onEntry1 = ctrl.startAction("hash#a", [], "kEntry1"); // initiated first
        const onEntry2 = ctrl.startAction("hash#b", [], "kEntry2"); // initiated later

        // Newer action on entry 2 claims the slot in its own cohort.
        expect(onEntry2.claimLocationState({ __rsc_ls_k: "from-2" })).toEqual({
          __rsc_ls_k: "from-2",
        });
        // Older action on entry 1 writes the SAME slot key but in a DIFFERENT
        // cohort -> it still wins (no cross-entry suppression). This is the P1
        // regression guard.
        expect(onEntry1.claimLocationState({ __rsc_ls_k: "from-1" })).toEqual({
          __rsc_ls_k: "from-1",
        });
      });

      it("frees a cohort's arbitration once its last action settles", () => {
        const ctrl = createController();
        // Two cohorts overlap; cohort 2 drains first while cohort 1 lingers.
        const e1 = ctrl.startAction("hash#a", [], "k1");
        const e2 = ctrl.startAction("hash#b", [], "k2");

        e1.claimLocationState({ __rsc_ls_k: "1" });
        e2.claimLocationState({ __rsc_ls_k: "2" });

        // Settle cohort 2's only action; cohort 1 is still inflight.
        e2.complete();
        vi.advanceTimersByTime(100); // cohort 2 cleanup fires
        // Cohort 1's action is still inflight, so cohort 1 retains its key but
        // a fresh action re-entering cohort 2 starts clean (last-initiated wins
        // trivially). The observable invariant is that nothing throws and both
        // cohorts remain independent.
        const e3 = ctrl.startAction("hash#c", [], "k2");
        expect(e3.claimLocationState({ __rsc_ls_k: "3" })).toEqual({
          __rsc_ls_k: "3",
        });
        // Cohort 1 still isolated.
        expect(e1.claimLocationState({ __rsc_ls_other: "x" })).toEqual({
          __rsc_ls_other: "x",
        });
      });

      it("a stale settlement does not break a newer cohort generation's arbitration", () => {
        const ctrl = createController();
        // Gen 1 in cohort k1 settles, scheduling a 100ms cleanup; abortAllActions
        // then clears the map while that cleanup is still pending.
        const g1 = ctrl.startAction("hash#g1", [], "k1");
        g1.complete();
        ctrl.abortAllActions();

        // Gen 2: two concurrent actions recreate cohort k1.
        const a = ctrl.startAction("hash#a", [], "k1"); // initiated first
        const b = ctrl.startAction("hash#b", [], "k1"); // initiated later

        // last-initiated wins the shared key.
        expect(b.claimLocationState({ __rsc_ls_k: "b" })).toEqual({
          __rsc_ls_k: "b",
        });

        // The stale gen-1 settlement fires now. Pre-fix it deleted gen-2's
        // arbitration by id, after which gen-2 claims saw no map and accepted
        // every key (so `a` would wrongly win below). A monotonic-sequence test
        // alone cannot catch this; the loser must be a LOWER-sequence sibling.
        vi.advanceTimersByTime(100);

        // first-initiated must STILL lose the shared key.
        expect(a.claimLocationState({ __rsc_ls_k: "a" })).toEqual({});
      });
    });

    it("fail() before abortAllActions() delivers error to subscribers", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);
      const error = new Error("action error");

      // Subscribe to capture notifications
      const observed: { error: unknown }[] = [];
      ctrl.subscribeToAction("save", (s) => {
        observed.push({ error: s.error });
      });

      // Fail the handle first (while it's still in inflightActions)
      handle.fail(error);

      // abortAllActions preserves settling entries so the debounced
      // notification can still find the entry and deliver the error
      ctrl.abortAllActions();

      // Settling entry should survive abort
      expect(ctrl.getInflightActions().size).toBe(1);
      expect(handle.settled).toBe(true);

      // Flush debounced notification — subscriber should see the error
      vi.advanceTimersByTime(0);
      expect(observed.some((s) => s.error === error)).toBe(true);

      // After settlement timeout, entry is cleaned up
      vi.advanceTimersByTime(100);
      expect(ctrl.getInflightActions().size).toBe(0);
    });

    it("fail() after abortAllActions() is a no-op (entry already removed)", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);

      // Abort first — removes the entry from the map
      ctrl.abortAllActions();

      // Fail after abort — should be a no-op, not throw
      handle.fail(new Error("late error"));
      expect(handle.settled).toBe(false);
    });

    it("abortAllActions notifies short-name subscribers (suffix match)", () => {
      const ctrl = createController();
      ctrl.startAction("hash#save", []);

      const observed: unknown[] = [];
      ctrl.subscribeToAction("save", (s) => {
        observed.push(s.state);
      });

      // Flush the startAction notification first
      vi.advanceTimersByTime(0);
      observed.length = 0;

      ctrl.abortAllActions();

      // abortAllActions should notify "save" subscribers immediately
      // (not via debounced notifyAction which would fail suffix matching)
      expect(observed.length).toBeGreaterThan(0);
      expect(observed).toContain("idle");
    });

    it("aggregates action-listener errors after debounced fan-out", () => {
      const ctrl = createController();
      const firstError = new Error("first action listener failed");
      const secondError = new Error("second action listener failed");
      const third = vi.fn();
      ctrl.subscribeToAction("save", () => {
        throw firstError;
      });
      ctrl.subscribeToAction("save", () => {
        throw secondError;
      });
      ctrl.subscribeToAction("save", third);

      ctrl.startAction("hash#save", []);
      let thrown: unknown;
      try {
        vi.advanceTimersByTime(0);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([
        firstError,
        secondError,
      ]);
      expect(third).toHaveBeenCalledOnce();
    });

    it("aggregates action-listener errors during abortAllActions", () => {
      const ctrl = createController();
      ctrl.startAction("hash#save", []);
      vi.advanceTimersByTime(0);
      const firstError = new Error("first abort listener failed");
      const secondError = new Error("second abort listener failed");
      const third = vi.fn();
      ctrl.subscribeToAction("save", () => {
        throw firstError;
      });
      ctrl.subscribeToAction("save", () => {
        throw secondError;
      });
      ctrl.subscribeToAction("save", third);

      let thrown: unknown;
      try {
        ctrl.abortAllActions();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([
        firstError,
        secondError,
      ]);
      expect(third).toHaveBeenCalledOnce();
    });
  });

  // ======================================================================
  // Derived State
  // ======================================================================

  describe("derived state", () => {
    it("state is loading when navigation OR actions are active", () => {
      const ctrl = createController();
      expect(ctrl.getState().state).toBe("idle");

      ctrl.startNavigation("/a");
      expect(ctrl.getState().state).toBe("loading");

      ctrl.abortNavigation();
      expect(ctrl.getState().state).toBe("idle");

      ctrl.startAction("hash#x", []);
      expect(ctrl.getState().state).toBe("loading");
    });

    it("pendingUrl is only set during fetching phase", () => {
      const ctrl = createController();
      const handle = ctrl.startNavigation("/about");
      expect(ctrl.getState().pendingUrl).toBe("/about");

      // Once streaming starts, phase transitions to "streaming" and
      // pendingUrl should clear (URL is no longer pending — data is arriving)
      const token = handle.startStreaming();
      expect(ctrl.getState().pendingUrl).toBeNull();

      token.end();
      handle.complete(loc("/about"));
      expect(ctrl.getState().pendingUrl).toBeNull();
    });

    it("pendingUrl is null for skipLoadingState navigations (background revalidations)", () => {
      const ctrl = createController();
      ctrl.startNavigation("/slow", { skipLoadingState: true });
      // Background revalidations don't expose pendingUrl
      expect(ctrl.getState().pendingUrl).toBeNull();
      expect(ctrl.getState().state).toBe("idle");
    });

    it("inflightActions excludes settling actions", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#save", []);
      expect(ctrl.getState().inflightActions).toHaveLength(1);

      handle.complete("ok"); // phase becomes settling
      expect(ctrl.getState().inflightActions).toHaveLength(0);
    });

    it("isStreaming reflects active stream count", () => {
      const ctrl = createController();
      expect(ctrl.getState().isStreaming).toBe(false);

      const navHandle = ctrl.startNavigation("/x");
      // loading implies streaming
      expect(ctrl.getState().isStreaming).toBe(true);

      const token1 = navHandle.startStreaming();
      navHandle.complete(loc("/x"));
      // Still streaming because token hasn't ended
      expect(ctrl.getState().isStreaming).toBe(true);

      token1.end();
      expect(ctrl.getState().isStreaming).toBe(false);
    });
  });

  // ======================================================================
  // Handle Operations
  // ======================================================================

  describe("handle data", () => {
    it("setHandleData full update replaces all data", () => {
      const ctrl = createController();
      const data = { title: { "seg.1": ["Page 1"] } };
      ctrl.setHandleData(data, ["seg.1"]);

      const state = ctrl.getHandleState();
      expect(state.data).toEqual(data);
      expect(state.segmentOrder).toEqual(["seg.1"]);
    });

    it("setHandleData partial update merges new data", () => {
      const ctrl = createController();
      ctrl.setHandleData({ title: { "seg.1": ["Page 1"] } }, ["seg.1"]);

      // Partial: add seg.2 data
      ctrl.setHandleData(
        { title: { "seg.2": ["Page 2"] } },
        ["seg.1", "seg.2"],
        true,
      );

      const state = ctrl.getHandleState();
      expect(state.data.title["seg.1"]).toEqual(["Page 1"]);
      expect(state.data.title["seg.2"]).toEqual(["Page 2"]);
    });

    it("partial update removes data for segments not in matched list", () => {
      const ctrl = createController();
      ctrl.setHandleData({ title: { "seg.1": ["A"], "seg.2": ["B"] } }, [
        "seg.1",
        "seg.2",
      ]);

      // Navigate: seg.2 replaced with seg.3
      ctrl.setHandleData(
        { title: { "seg.3": ["C"] } },
        ["seg.1", "seg.3"],
        true,
      );

      const state = ctrl.getHandleState();
      expect(state.data.title["seg.1"]).toEqual(["A"]);
      expect(state.data.title["seg.2"]).toBeUndefined();
      expect(state.data.title["seg.3"]).toEqual(["C"]);
    });

    it("filterSegmentOrder keeps parallels (.@) and drops loaders (D digit)", () => {
      const ctrl = createController();
      ctrl.setHandleData({}, [
        "root",
        "root.@sidebar",
        "page",
        "page.@modal",
        "M0L0D1.loader",
        "content",
      ]);

      const state = ctrl.getHandleState();
      expect(state.segmentOrder).toEqual([
        "root",
        "root.@sidebar",
        "page",
        "page.@modal",
        "content",
      ]);
    });

    /**
     * Regression: route-mounted parallels emit BEFORE the route segment in
     * matched order ([R0.@panel, R0]). filterSegmentOrder must reorder so
     * the slot id appears AFTER the route id, otherwise collectHandleData's
     * later-wins semantics let the route's Meta override the slot's.
     */
    it("route-mounted slot id is normalized to follow the route id", () => {
      const ctrl = createController();
      ctrl.setHandleData({}, ["L0", "R0.@panel", "R0"]);
      const state = ctrl.getHandleState();
      expect(state.segmentOrder).toEqual(["L0", "R0", "R0.@panel"]);
    });

    it("setRouteSegmentIds updates routeSegmentIds (useSegments) WITHOUT touching data/segmentOrder (deferred hold)", () => {
      const ctrl = createController();
      // Route A applied.
      ctrl.setHandleData({ Crumbs: { A0: ["a"] } }, ["A0"]);
      const before = ctrl.getHandleState();
      expect(before.routeSegmentIds).toEqual(["A0"]);

      // Soft-nav to route B with a deferred handle: the route changed, so
      // useSegments must see B's segment ids, but useHandle still holds A's value
      // (data + segmentOrder untouched) until the deferred snapshot lands. This
      // decoupling is what lets the simpler await-then-apply model keep
      // useSegments correct while holding useHandle.
      ctrl.setRouteSegmentIds(["B0"]);
      const held = ctrl.getHandleState();
      expect(held.routeSegmentIds).toEqual(["B0"]); // useSegments sees B
      expect(held.data).toEqual(before.data); // useHandle data held
      expect(held.segmentOrder).toEqual(before.segmentOrder); // collect order held
    });

    /**
     * Regression: a layout-mounted parallel slot must not stomp the parent
     * layout's handle data on a slot-only revalidation.
     *
     * Original repro shape: layout pushes a Meta title-template under "L0";
     * a parallel slot mounted at the same layout (e.g. an email panel) pushes
     * the email-detail Meta. When the user soft-navs between two emails, only
     * the slot revalidates — the layout is cached and does not rerun. The
     * partial-update payload therefore contains only the slot's push.
     *
     * If parent and slot share the segment id "L0", the per-bucket merge
     * replaces the L0 array entirely with the slot's push, dropping the
     * layout's title template/default. With slot-keyed pushes ("L0.@panel"),
     * the layout's L0 bucket is preserved while the slot's bucket updates.
     *
     * For this contract to hold, filterSegmentOrder() must retain parallel
     * slot ids (otherwise the cleanup phase deletes them, defeating the
     * separation).
     */
    it("layout-mounted slot revalidation preserves layout's bucket (separate slot identity)", () => {
      const ctrl = createController();

      // Initial load: layout (L0) pushes the title template; slot (L0.@panel)
      // pushes the email-detail title.
      ctrl.setHandleData(
        {
          Meta: {
            L0: [{ title: { template: "%s | Inbox", default: "Inbox" } }],
            "L0.@panel": [{ title: "Email A subject" }],
          },
        },
        ["L0", "L0.@panel"],
      );

      // Slot-only revalidation (parent layout cached, did not rerun): the
      // partial payload contains only the slot's new push.
      ctrl.setHandleData(
        { Meta: { "L0.@panel": [{ title: "Email B subject" }] } },
        ["L0", "L0.@panel"],
        true,
      );

      const state = ctrl.getHandleState();
      expect(state.data.Meta.L0).toEqual([
        { title: { template: "%s | Inbox", default: "Inbox" } },
      ]);
      expect(state.data.Meta["L0.@panel"]).toEqual([
        { title: "Email B subject" },
      ]);
      // Slot id must survive the filter so cleanup doesn't drop it.
      expect(state.segmentOrder).toEqual(["L0", "L0.@panel"]);
    });

    /**
     * Regression: a parallel slot that re-resolves on revalidation but
     * pushes nothing (e.g. emailDetailHandler returns null when :emailId is
     * absent) leaves its previous bucket in place — the response carries no
     * entry to replace it with, and the existing match-list cleanup keeps
     * the id because the slot is still matched.
     *
     * The fix: setHandleData receives `resolvedIds` (server's `diff`) and
     * additionally clears any (handle, segmentId) where segmentId was
     * re-resolved this request but produced no incoming data for that
     * handle.
     */
    it("partial update clears stale buckets for re-resolved segments that pushed nothing", () => {
      const ctrl = createController();

      // Initial load: layout pushes its template; slot pushes Email A title.
      ctrl.setHandleData(
        {
          Meta: {
            L0: [{ title: { template: "%s | Inbox", default: "Inbox" } }],
            "L0.@panel": [{ title: "Email A subject" }],
          },
        },
        ["L0", "L0.@panel"],
      );

      // Soft-nav to a path with no :emailId. Slot revalidates but the
      // handler returns null without pushing. Server response has nothing
      // for the slot; diff still includes the slot id (it WAS re-resolved).
      ctrl.setHandleData({}, ["L0", "L0.@panel"], true, ["L0.@panel"]);

      const state = ctrl.getHandleState();
      // Layout's bucket preserved — not in resolvedIds, layout was cached.
      expect(state.data.Meta.L0).toEqual([
        { title: { template: "%s | Inbox", default: "Inbox" } },
      ]);
      // Slot's bucket cleared — was re-resolved but pushed nothing.
      expect(state.data.Meta["L0.@panel"]).toBeUndefined();
    });

    it("partial update without resolvedIds keeps the existing match-only cleanup behavior", () => {
      // Backwards-compat: callers that don't supply resolvedIds (e.g. the
      // initial bootstrap) still get the previous semantics — only segments
      // that fell out of the matched list are cleaned up.
      const ctrl = createController();
      ctrl.setHandleData(
        { Meta: { L0: [{ title: "A" }], "L0.@panel": [{ title: "Slot" }] } },
        ["L0", "L0.@panel"],
      );
      ctrl.setHandleData({}, ["L0", "L0.@panel"], true);
      const state = ctrl.getHandleState();
      expect(state.data.Meta.L0).toEqual([{ title: "A" }]);
      expect(state.data.Meta["L0.@panel"]).toEqual([{ title: "Slot" }]);
    });

    it("resolvedIds for a layout that re-runs but stops pushing a handle clears that handle's bucket", () => {
      // Wider applicability: not specific to parallel slots. If a layout
      // previously pushed Breadcrumbs but on revalidation only pushes Meta,
      // its Breadcrumbs bucket should be cleared.
      const ctrl = createController();
      ctrl.setHandleData(
        {
          Meta: { L0: [{ title: "Old" }] },
          Breadcrumbs: { L0: [{ label: "Home" }] },
        },
        ["L0"],
      );
      ctrl.setHandleData({ Meta: { L0: [{ title: "New" }] } }, ["L0"], true, [
        "L0",
      ]);
      const state = ctrl.getHandleState();
      expect(state.data.Meta.L0).toEqual([{ title: "New" }]);
      expect(state.data.Breadcrumbs?.L0).toBeUndefined();
    });
  });

  // ======================================================================
  // Subscriptions & Debounced Notifications
  // ======================================================================

  describe("subscriptions", () => {
    it("subscribe notifies on state changes (debounced)", () => {
      const ctrl = createController();
      const listener = vi.fn();
      ctrl.subscribe(listener);

      ctrl.startNavigation("/about");
      expect(listener).not.toHaveBeenCalled(); // debounced

      vi.advanceTimersByTime(0);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("multiple rapid changes are batched into one notification", () => {
      const ctrl = createController();
      const listener = vi.fn();
      ctrl.subscribe(listener);

      ctrl.startNavigation("/a");
      ctrl.abortNavigation();
      ctrl.startNavigation("/b");

      vi.advanceTimersByTime(0);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("flushes pending route-state notifications synchronously", () => {
      const ctrl = createController();
      const stateListener = vi.fn();
      const handleListener = vi.fn();
      ctrl.subscribe(stateListener);
      ctrl.subscribeToHandles(handleListener);

      ctrl.startNavigation("/about");
      ctrl.setHandleData({}, ["R0"]);
      expect(stateListener).not.toHaveBeenCalled();
      expect(handleListener).not.toHaveBeenCalled();

      ctrl.flushRouteState();
      expect(stateListener).toHaveBeenCalledOnce();
      expect(handleListener).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(0);
      expect(stateListener).toHaveBeenCalledOnce();
      expect(handleListener).toHaveBeenCalledOnce();
    });

    it("aggregates every state-listener error after fan-out", () => {
      const ctrl = createController();
      const firstError = new Error("first state listener failed");
      const secondError = new Error("second state listener failed");
      const third = vi.fn();
      ctrl.subscribe(() => {
        throw firstError;
      });
      ctrl.subscribe(() => {
        throw secondError;
      });
      ctrl.subscribe(third);

      ctrl.startNavigation("/about");
      let thrown: unknown;
      try {
        vi.advanceTimersByTime(0);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([
        firstError,
        secondError,
      ]);
      expect(third).toHaveBeenCalledOnce();
    });

    it("unsubscribe stops notifications", () => {
      const ctrl = createController();
      const listener = vi.fn();
      const unsub = ctrl.subscribe(listener);

      unsub();
      ctrl.startNavigation("/about");
      vi.advanceTimersByTime(0);

      expect(listener).not.toHaveBeenCalled();
    });

    it("subscribeToAction notifies for matching action (suffix match)", () => {
      const ctrl = createController();
      const listener = vi.fn();
      ctrl.subscribeToAction("addToCart", listener);

      ctrl.startAction("hash#addToCart", []);
      vi.advanceTimersByTime(0);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "loading",
          actionId: "hash#addToCart",
        }),
      );
    });

    it("reads each subscription state when its fan-out begins", () => {
      const ctrl = createController();
      const observed: unknown[] = [];
      ctrl.subscribeToAction("hash#save", () => {
        vi.setSystemTime(new Date(Date.now() + 1));
        ctrl.startAction("new#save", ["new"]);
      });
      ctrl.subscribeToAction("save", (state) => {
        observed.push(state.payload);
      });

      ctrl.startAction("hash#save", ["old"]);
      vi.advanceTimersByTime(0);

      expect(observed[0]).toEqual(["new"]);
    });

    it("subscribeToAction does not notify for non-matching action", () => {
      const ctrl = createController();
      const listener = vi.fn();
      ctrl.subscribeToAction("removeFromCart", listener);

      ctrl.startAction("hash#addToCart", []);
      vi.advanceTimersByTime(0);

      expect(listener).not.toHaveBeenCalled();
    });

    it("subscribeToAction unsubscribe cleans up listener set", () => {
      const ctrl = createController();
      const listener = vi.fn();
      const unsub = ctrl.subscribeToAction("save", listener);

      unsub();
      ctrl.startAction("hash#save", []);
      vi.advanceTimersByTime(0);

      expect(listener).not.toHaveBeenCalled();
    });

    it("subscribeToHandles notifies on handle data changes", () => {
      const ctrl = createController();
      const listener = vi.fn();
      ctrl.subscribeToHandles(listener);

      ctrl.setHandleData({ title: { s: ["T"] } }, ["s"]);
      vi.advanceTimersByTime(0);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("subscribeToHandles unsubscribe stops notifications", () => {
      const ctrl = createController();
      const listener = vi.fn();
      const unsub = ctrl.subscribeToHandles(listener);

      unsub();
      ctrl.setHandleData({ title: { s: ["T"] } }, ["s"]);
      vi.advanceTimersByTime(0);

      expect(listener).not.toHaveBeenCalled();
    });

    it("aggregates every handle-listener error after fan-out", () => {
      const ctrl = createController();
      const firstError = new Error("first handle listener failed");
      const secondError = new Error("second handle listener failed");
      const third = vi.fn();
      ctrl.subscribeToHandles(() => {
        throw firstError;
      });
      ctrl.subscribeToHandles(() => {
        throw secondError;
      });
      ctrl.subscribeToHandles(third);

      ctrl.setHandleData({ title: { s: ["T"] } }, ["s"]);
      let thrown: unknown;
      try {
        vi.advanceTimersByTime(0);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([
        firstError,
        secondError,
      ]);
      expect(third).toHaveBeenCalledOnce();
    });
  });

  // ======================================================================
  // Direct Access
  // ======================================================================

  describe("direct access", () => {
    it("getCurrentNavigation returns entry during navigation", () => {
      const ctrl = createController();
      expect(ctrl.getCurrentNavigation()).toBeNull();

      ctrl.startNavigation("/about");
      const nav = ctrl.getCurrentNavigation();
      expect(nav).not.toBeNull();
      expect(nav!.url).toBe("/about");
      expect(nav!.phase).toBe("fetching");
    });

    it("getInflightActions returns the internal map", () => {
      const ctrl = createController();
      expect(ctrl.getInflightActions().size).toBe(0);

      ctrl.startAction("hash#save", []);
      expect(ctrl.getInflightActions().size).toBe(1);
    });
  });
});
