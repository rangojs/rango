import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createEventController,
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

    it("recordRevalidatedSegments tracks segments for consolidation", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#a", []);
      const second = ctrl.startAction("hash#b", []);

      first.recordRevalidatedSegments(["seg1", "seg2"]);
      second.recordRevalidatedSegments(["seg2", "seg3"]);

      // Can't consolidate while any action is still fetching
      expect(second.getConsolidationSegments()).toBeNull();

      // Complete both so none are fetching
      first.complete();
      second.complete();

      // Now consolidation returns all revalidated segments
      const segments = second.getConsolidationSegments();
      expect(segments).toContain("seg1");
      expect(segments).toContain("seg2");
      expect(segments).toContain("seg3");
    });

    it("getConsolidationSegments returns null when no concurrent actions", () => {
      const ctrl = createController();
      const handle = ctrl.startAction("hash#a", []);
      expect(handle.getConsolidationSegments()).toBeNull();
    });

    it("getConsolidationSegments returns null when segments are empty", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#a", []);
      const second = ctrl.startAction("hash#b", []);
      first.complete();
      // No segments were recorded
      expect(second.getConsolidationSegments()).toBeNull();
    });

    it("clearConsolidation resets tracking", () => {
      const ctrl = createController();
      const first = ctrl.startAction("hash#a", []);
      const second = ctrl.startAction("hash#b", []);

      first.recordRevalidatedSegments(["seg1"]);
      first.complete();
      second.clearConsolidation();

      expect(second.getConsolidationSegments()).toBeNull();
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

    it("filterSegmentOrder excludes parallels (.@) and loaders (D digit)", () => {
      const ctrl = createController();
      ctrl.setHandleData({}, [
        "root",
        "layout.@sidebar",
        "page",
        "D1.loader",
        "content",
      ]);

      const state = ctrl.getHandleState();
      expect(state.segmentOrder).toEqual(["root", "page", "content"]);
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
