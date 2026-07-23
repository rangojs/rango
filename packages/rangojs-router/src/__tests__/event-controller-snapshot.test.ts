import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEventController } from "../browser/event-controller.js";

function createController(path = "/") {
  return createEventController({
    initialLocation: new URL(path, "http://localhost"),
  });
}

// The controller debounces notifications and settles actions after 100ms.
describe("event-controller derived-state snapshot (B4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the SAME object reference across calls while state is unchanged", () => {
    const ctrl = createController();
    const a = ctrl.getState();
    const b = ctrl.getState();
    expect(b).toBe(a);
  });

  it("recomputes a new snapshot after a mutation, then is stable again", () => {
    const ctrl = createController();
    const before = ctrl.getState();

    ctrl.startNavigation("/x");
    const after = ctrl.getState();

    expect(after).not.toBe(before);
    expect(after.state).toBe("loading");
    // Stable until the next mutation.
    expect(ctrl.getState()).toBe(after);
  });

  it("hands back one shared empty inflightActions array when idle", () => {
    const c1 = createController();
    const c2 = createController();
    // Module-level shared reference: stable across calls AND across controllers.
    expect(c1.getState().inflightActions).toBe(c2.getState().inflightActions);
    expect(c1.getState().inflightActions).toHaveLength(0);
  });

  it("invalidates the memo through the action lifecycle and returns to the shared idle array", () => {
    const ctrl = createController();
    const idle = ctrl.getState();
    expect(idle.inflightActions).toHaveLength(0);

    const handle = ctrl.startAction("hash#save", [1]);
    const loading = ctrl.getState();
    expect(loading).not.toBe(idle);
    expect(loading.state).toBe("loading");
    expect(loading.inflightActions).toHaveLength(1);

    handle.complete("ok"); // phase -> settling
    vi.advanceTimersByTime(100); // settlement cleanup deletes the entry

    const back = ctrl.getState();
    expect(back.state).toBe("idle");
    // Idle again -> the exact shared empty array reference from before.
    expect(back.inflightActions).toBe(idle.inflightActions);
  });

  it("getActionState returns the shared idle snapshot when nothing is inflight", () => {
    const ctrl = createController();
    const a = ctrl.getActionState("save");
    const b = ctrl.getActionState("other");
    // Same reference — the shared idle default, not a fresh object each call.
    expect(a).toBe(b);
    expect(a.state).toBe("idle");
    expect(a.actionId).toBeNull();
  });

  it("getActionState still reports a live inflight action (short-circuit only applies when empty)", () => {
    const ctrl = createController();
    ctrl.startAction("hash#save", ["item"]);
    const state = ctrl.getActionState("save");
    expect(state.state).toBe("loading");
    expect(state.actionId).toBe("hash#save");
    expect(state.payload).toEqual(["item"]);
  });
});
