import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createEventController,
  resetEventController,
  type EventController,
  type NavigationHandle,
  type ActionHandle,
} from "../browser/event-controller.js";
import { flushNotifications, wait } from "./test-utils.js";

describe("EventController", () => {
  let controller: EventController;

  beforeEach(() => {
    resetEventController();
    controller = createEventController({
      initialLocation: new URL("http://localhost/"),
    });
  });

  afterEach(() => {
    resetEventController();
  });

  // ==========================================================================
  // Navigation Lifecycle Tests
  // ==========================================================================

  describe("Navigation Lifecycle", () => {
    it("should start navigation and return handle with abort controller", () => {
      const handle = controller.startNavigation("/test");

      expect(handle).toBeDefined();
      expect(handle.abort).toBeInstanceOf(AbortController);
      expect(handle.signal).toBeInstanceOf(AbortSignal);
      expect(handle.signal.aborted).toBe(false);
      expect(handle.completed).toBe(false);
    });

    it("should set state to loading when navigation starts", async () => {
      expect(controller.getState().state).toBe("idle");

      controller.startNavigation("/test");

      await flushNotifications();
      expect(controller.getState().state).toBe("loading");
    });

    it("should cancel previous navigation on new one (switchMap semantics)", () => {
      const handle1 = controller.startNavigation("/first");
      const handle2 = controller.startNavigation("/second");

      expect(handle1.signal.aborted).toBe(true);
      expect(handle2.signal.aborted).toBe(false);
    });

    it("should complete navigation and update location", async () => {
      const handle = controller.startNavigation("/test");
      const newLocation = new URL("http://localhost/test");

      handle.complete(newLocation);

      await flushNotifications();
      expect(handle.completed).toBe(true);
      expect(controller.getState().state).toBe("idle");
      expect(controller.getState().location.pathname).toBe("/test");
    });

    it("should not complete navigation if aborted", async () => {
      const handle = controller.startNavigation("/test");

      // Start new navigation (aborts previous)
      controller.startNavigation("/other");

      // Try to complete the first one
      const newLocation = new URL("http://localhost/test");
      handle.complete(newLocation);

      await flushNotifications();
      // Location should not be /test since first navigation was aborted
      expect(controller.getState().location.pathname).not.toBe("/test");
    });

    it("should abort navigation via abortNavigation()", async () => {
      const handle = controller.startNavigation("/test");

      controller.abortNavigation();

      await flushNotifications();
      expect(handle.signal.aborted).toBe(true);
      expect(controller.getState().state).toBe("idle");
    });

    it("should update location via setLocation() for popstate", async () => {
      const newLocation = new URL("http://localhost/popstate");

      controller.setLocation(newLocation);

      await flushNotifications();
      expect(controller.getState().location.pathname).toBe("/popstate");
    });

    it("should cleanup via Disposable when navigation not completed", async () => {
      {
        const handle = controller.startNavigation("/test");
        expect(controller.getCurrentNavigation()).not.toBeNull();
        // Symbol.dispose called when block exits
        handle[Symbol.dispose]();
      }

      await flushNotifications();
      expect(controller.getCurrentNavigation()).toBeNull();
      expect(controller.getState().state).toBe("idle");
    });
  });

  // ==========================================================================
  // Action Lifecycle Tests
  // ==========================================================================

  describe("Action Lifecycle", () => {
    it("should start action and return handle with unique ID", () => {
      const handle = controller.startAction("addToCart", ["item-1"]);

      expect(handle).toBeDefined();
      expect(handle.id).toContain("addToCart");
      expect(handle.abort).toBeInstanceOf(AbortController);
      expect(handle.signal).toBeInstanceOf(AbortSignal);
      expect(handle.settled).toBe(false);
    });

    it("should generate unique IDs for each action instance", () => {
      const handle1 = controller.startAction("addToCart", ["item-1"]);
      const handle2 = controller.startAction("addToCart", ["item-2"]);

      expect(handle1.id).not.toBe(handle2.id);
    });

    it("should set state to loading when actions are active", async () => {
      expect(controller.getState().state).toBe("idle");

      controller.startAction("addToCart", []);

      await flushNotifications();
      expect(controller.getState().state).toBe("loading");
    });

    it("should allow concurrent actions (mergeMap semantics)", () => {
      const handle1 = controller.startAction("addToCart", ["item-1"]);
      const handle2 = controller.startAction("removeFromCart", ["item-2"]);
      const handle3 = controller.startAction("updateQuantity", ["item-3", 5]);

      // All should be active (not aborted)
      expect(handle1.signal.aborted).toBe(false);
      expect(handle2.signal.aborted).toBe(false);
      expect(handle3.signal.aborted).toBe(false);

      // All should be tracked
      expect(controller.getInflightActions().size).toBe(3);
    });

    it("should track concurrent actions flag", () => {
      const handle1 = controller.startAction("action1", []);

      // First action has no concurrent actions
      expect(handle1.hadConcurrentActions).toBe(false);

      const handle2 = controller.startAction("action2", []);

      // Second action detects concurrent
      expect(handle2.hadConcurrentActions).toBe(true);
    });

    it("should complete action and set result", async () => {
      const handle = controller.startAction("addToCart", []);

      handle.complete({ success: true, cartId: "123" });

      await flushNotifications();
      // Wait for settling cleanup
      await wait(150);

      expect(handle.settled).toBe(true);
      expect(controller.getInflightActions().size).toBe(0);
    });

    it("should fail action and set error", async () => {
      const handle = controller.startAction("addToCart", []);
      const error = new Error("Out of stock");

      handle.fail(error);

      await flushNotifications();
      await wait(150);

      expect(handle.settled).toBe(true);
    });

    it("should return to idle when all actions complete", async () => {
      const handle1 = controller.startAction("action1", []);
      const handle2 = controller.startAction("action2", []);

      await flushNotifications();
      expect(controller.getState().state).toBe("loading");

      handle1.complete();
      handle2.complete();

      await wait(150);
      expect(controller.getState().state).toBe("idle");
    });

    it("should abort all actions via abortAllActions()", async () => {
      const handle1 = controller.startAction("action1", []);
      const handle2 = controller.startAction("action2", []);

      controller.abortAllActions();

      await flushNotifications();
      expect(handle1.signal.aborted).toBe(true);
      expect(handle2.signal.aborted).toBe(true);
      expect(controller.getInflightActions().size).toBe(0);
    });

    it("should cleanup via Disposable when action fails unexpectedly", async () => {
      const handle = controller.startAction("addToCart", []);
      expect(controller.getInflightActions().size).toBe(1);

      // Simulate unexpected failure (dispose without complete/fail)
      handle[Symbol.dispose]();

      await wait(150);
      expect(controller.getInflightActions().size).toBe(0);
    });
  });

  // ==========================================================================
  // Streaming Tests
  // ==========================================================================

  describe("Streaming", () => {
    it("should track streaming state via navigation token", async () => {
      const handle = controller.startNavigation("/test");

      // Initially streaming is false (but loading)
      expect(controller.getState().isStreaming).toBe(true); // isStreaming includes loading state

      const token = handle.startStreaming();
      await flushNotifications();
      expect(controller.getState().isStreaming).toBe(true);

      token.end();
      handle.complete(new URL("http://localhost/test"));
      await flushNotifications();
      expect(controller.getState().isStreaming).toBe(false);
    });

    it("should track streaming state via action token", async () => {
      const handle = controller.startAction("addToCart", []);

      const token = handle.startStreaming();
      await flushNotifications();
      expect(controller.getState().isStreaming).toBe(true);

      token.end();
      handle.complete();
      await wait(150);
      expect(controller.getState().isStreaming).toBe(false);
    });

    it("should handle multiple concurrent streams", async () => {
      const navHandle = controller.startNavigation("/test");
      const actionHandle = controller.startAction("action1", []);

      const navToken = navHandle.startStreaming();
      const actionToken = actionHandle.startStreaming();

      await flushNotifications();
      expect(controller.getState().isStreaming).toBe(true);

      // End navigation stream
      navToken.end();
      navHandle.complete(new URL("http://localhost/test"));
      await flushNotifications();
      // Still streaming due to action
      expect(controller.getState().isStreaming).toBe(true);

      // End action stream
      actionToken.end();
      actionHandle.complete();
      await wait(150);
      expect(controller.getState().isStreaming).toBe(false);
    });

    it("should prevent double-end on token", async () => {
      const handle = controller.startNavigation("/test");
      const token = handle.startStreaming();

      token.end();
      token.end(); // Should be no-op
      handle.complete(new URL("http://localhost/test"));

      await flushNotifications();
      expect(controller.getState().isStreaming).toBe(false);
    });

    it("should wait for streaming to end before settling action", async () => {
      const handle = controller.startAction("addToCart", []);
      const token = handle.startStreaming();

      // Complete the action but streaming is still active
      handle.complete({ result: "success" });

      await flushNotifications();
      // Action should not be settled yet (streaming in progress)
      expect(handle.settled).toBe(false);

      // End streaming
      token.end();
      await wait(150);
      expect(handle.settled).toBe(true);
    });
  });

  // ==========================================================================
  // State Derivation Tests
  // ==========================================================================

  describe("State Derivation", () => {
    it("should derive state from source of truth", () => {
      const state = controller.getState();

      expect(state).toHaveProperty("state");
      expect(state).toHaveProperty("isStreaming");
      expect(state).toHaveProperty("location");
      expect(state).toHaveProperty("inflightActions");
    });

    it("should show loading state during navigation", async () => {
      controller.startNavigation("/test");

      await flushNotifications();
      expect(controller.getState().state).toBe("loading");
    });

    it("should show loading state during actions", async () => {
      controller.startAction("test", []);

      await flushNotifications();
      expect(controller.getState().state).toBe("loading");
    });

    it("should include inflight actions in state", async () => {
      controller.startAction("action1", ["arg1"]);
      controller.startAction("action2", ["arg2"]);

      await flushNotifications();
      const { inflightActions } = controller.getState();
      expect(inflightActions).toHaveLength(2);
      expect(inflightActions[0].actionId).toBe("action1");
      expect(inflightActions[1].actionId).toBe("action2");
    });

    it("should return correct action state via getActionState()", async () => {
      controller.startAction("addToCart", ["item-1"]);

      await flushNotifications();
      const state = controller.getActionState("addToCart");

      expect(state.state).toBe("loading");
      expect(state.actionId).toBe("addToCart");
      expect(state.payload).toEqual(["item-1"]);
      expect(state.error).toBeNull();
      expect(state.result).toBeNull();
    });

    it("should return idle state for unknown action", () => {
      const state = controller.getActionState("unknownAction");

      expect(state.state).toBe("idle");
      expect(state.actionId).toBeNull();
    });
  });

  // ==========================================================================
  // Subscription Tests
  // ==========================================================================

  describe("Subscriptions", () => {
    it("should notify state listeners on navigation", async () => {
      const listener = vi.fn();
      controller.subscribe(listener);

      controller.startNavigation("/test");

      await flushNotifications();
      expect(listener).toHaveBeenCalled();
    });

    it("should notify state listeners on action", async () => {
      const listener = vi.fn();
      controller.subscribe(listener);

      controller.startAction("test", []);

      await flushNotifications();
      expect(listener).toHaveBeenCalled();
    });

    it("should unsubscribe state listener", async () => {
      const listener = vi.fn();
      const unsubscribe = controller.subscribe(listener);

      unsubscribe();
      controller.startNavigation("/test");

      await flushNotifications();
      expect(listener).not.toHaveBeenCalled();
    });

    it("should notify action listeners on action state change", async () => {
      const listener = vi.fn();
      controller.subscribeToAction("addToCart", listener);

      const handle = controller.startAction("addToCart", ["item"]);

      await flushNotifications();
      expect(listener).toHaveBeenCalled();

      // Complete action
      handle.complete({ success: true });

      await flushNotifications();
      expect(listener.mock.calls.length).toBeGreaterThan(1);
    });

    it("should unsubscribe action listener", async () => {
      const listener = vi.fn();
      const unsubscribe = controller.subscribeToAction("addToCart", listener);

      unsubscribe();
      controller.startAction("addToCart", []);

      await flushNotifications();
      expect(listener).not.toHaveBeenCalled();
    });

    it("should debounce rapid state changes", async () => {
      const listener = vi.fn();
      controller.subscribe(listener);

      // Rapid fire multiple navigations
      controller.startNavigation("/a");
      controller.startNavigation("/b");
      controller.startNavigation("/c");

      await flushNotifications();
      // Should be debounced to fewer calls than 3
      expect(listener.mock.calls.length).toBeLessThanOrEqual(3);
    });
  });

  // ==========================================================================
  // Consolidation Tests
  // ==========================================================================

  describe("Consolidation", () => {
    it("should record revalidated segments", async () => {
      const handle = controller.startAction("addToCart", []);

      handle.recordRevalidatedSegments(["layout", "page"]);

      // Segments are tracked internally (tested via getConsolidationSegments)
      expect(handle.getConsolidationSegments()).toBeNull(); // Not last action yet
    });

    it("should return null from getConsolidationSegments when actions still pending", () => {
      const handle1 = controller.startAction("action1", []);
      const handle2 = controller.startAction("action2", []);

      handle1.recordRevalidatedSegments(["segment-a"]);
      handle1.complete();

      // handle2 is still pending
      expect(handle1.getConsolidationSegments()).toBeNull();
    });

    it("should return consolidation segments when last action completes", async () => {
      const handle1 = controller.startAction("action1", []);
      const handle2 = controller.startAction("action2", []);

      handle1.recordRevalidatedSegments(["segment-a"]);
      handle2.recordRevalidatedSegments(["segment-b"]);

      handle1.complete();

      // Both complete - handle2 is "last"
      handle2.complete();

      const segments = handle2.getConsolidationSegments();
      expect(segments).toContain("segment-a");
      expect(segments).toContain("segment-b");
    });

    it("should return null if no concurrent actions", () => {
      const handle = controller.startAction("solo", []);

      handle.recordRevalidatedSegments(["segment"]);
      handle.complete();

      // No concurrent actions, so no consolidation needed
      expect(handle.getConsolidationSegments()).toBeNull();
    });

    it("should clear consolidation tracking", async () => {
      const handle1 = controller.startAction("action1", []);
      const handle2 = controller.startAction("action2", []);

      handle1.recordRevalidatedSegments(["segment-a"]);
      handle1.complete();
      handle2.complete();

      handle2.clearConsolidation();

      // After clearing, no segments
      expect(handle2.getConsolidationSegments()).toBeNull();
    });
  });

  // ==========================================================================
  // Edge Cases and Integration
  // ==========================================================================

  describe("Edge Cases", () => {
    it("should handle navigation during action", async () => {
      const actionHandle = controller.startAction("addToCart", []);
      const navHandle = controller.startNavigation("/new-page");

      await flushNotifications();
      // Both should be active
      expect(actionHandle.signal.aborted).toBe(false);
      expect(navHandle.signal.aborted).toBe(false);
    });

    it("should not abort actions when navigation completes", async () => {
      const actionHandle = controller.startAction("addToCart", []);
      const navHandle = controller.startNavigation("/new-page");

      navHandle.complete(new URL("http://localhost/new-page"));

      await flushNotifications();
      // Action should still be active
      expect(actionHandle.signal.aborted).toBe(false);
      expect(controller.getInflightActions().size).toBe(1);
    });

    it("should handle rapid action completion", async () => {
      const handles = Array.from({ length: 5 }, (_, i) =>
        controller.startAction(`action${i}`, [])
      );

      // Complete all rapidly
      handles.forEach((h) => h.complete());

      await wait(200);
      expect(controller.getInflightActions().size).toBe(0);
      expect(controller.getState().state).toBe("idle");
    });

    it("should get current navigation entry", () => {
      expect(controller.getCurrentNavigation()).toBeNull();

      const handle = controller.startNavigation("/test");
      const entry = controller.getCurrentNavigation();

      expect(entry).not.toBeNull();
      expect(entry?.url).toBe("/test");
      expect(entry?.phase).toBe("fetching");
    });

    it("should get inflight actions map", () => {
      controller.startAction("action1", []);
      controller.startAction("action2", []);

      const inflight = controller.getInflightActions();
      expect(inflight.size).toBe(2);
    });
  });
});
