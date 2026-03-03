import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedEffectFn: (() => (() => void) | void) | null = null;
let capturedEffectDeps: any[] | undefined;

// Simulate React's hook slot persistence across re-renders.
// On the first render, hooks allocate slots. On re-renders, they read existing slots.
let refSlots: Array<{ current: any }> = [];
let refIndex = 0;
let stateSlots: Array<[any, ReturnType<typeof vi.fn>]> = [];
let stateIndex = 0;

function resetHookIndices() {
  refIndex = 0;
  stateIndex = 0;
}

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useContext: vi.fn(),
    useState: vi.fn((init: Function | any) => {
      if (stateIndex < stateSlots.length) {
        return stateSlots[stateIndex++];
      }
      const val = typeof init === "function" ? init() : init;
      const setter = vi.fn();
      const slot: [any, ReturnType<typeof vi.fn>] = [val, setter];
      stateSlots.push(slot);
      stateIndex++;
      return slot;
    }),
    useRef: vi.fn((val: any) => {
      if (refIndex < refSlots.length) {
        return refSlots[refIndex++];
      }
      const ref = { current: val };
      refSlots.push(ref);
      refIndex++;
      return ref;
    }),
    useEffect: vi.fn((fn: () => (() => void) | void, deps?: any[]) => {
      capturedEffectFn = fn;
      capturedEffectDeps = deps;
    }),
  };
});

import { useContext } from "react";
import { useSegments } from "../browser/react/use-segments.js";

const mockedUseContext = vi.mocked(useContext);

function createMockEventController() {
  return {
    getState: () => ({
      location: new URL("http://localhost/shop/products"),
    }),
    getHandleState: () => ({
      segmentOrder: ["L0", "L0L1"],
    }),
    subscribe: vi.fn(() => vi.fn()),
    subscribeToHandles: vi.fn(() => vi.fn()),
  };
}

describe("useSegments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEffectFn = null;
    capturedEffectDeps = undefined;
    refSlots = [];
    refIndex = 0;
    stateSlots = [];
    stateIndex = 0;
  });

  it("subscribes to event controller when context is available", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);

    capturedEffectFn!();

    expect(ec.subscribe).toHaveBeenCalledOnce();
    expect(ec.subscribeToHandles).toHaveBeenCalledOnce();
  });

  it("effect cleanup unsubscribes from both sources", () => {
    const unsubNav = vi.fn();
    const unsubHandles = vi.fn();
    const ec = createMockEventController();
    ec.subscribe.mockReturnValue(unsubNav);
    ec.subscribeToHandles.mockReturnValue(unsubHandles);
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments();

    const cleanup = capturedEffectFn!() as () => void;
    cleanup();

    expect(unsubNav).toHaveBeenCalledOnce();
    expect(unsubHandles).toHaveBeenCalledOnce();
  });

  it("does not subscribe when context is null (SSR)", () => {
    mockedUseContext.mockReturnValue(null);

    const state = useSegments();

    capturedEffectFn!();

    expect(state).toHaveProperty("path");
    expect(state).toHaveProperty("segmentIds");
    expect(state).toHaveProperty("location");
  });

  it("useEffect has empty dependency array (stable subscription)", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);

    expect(capturedEffectDeps).toEqual([]);
  });

  it("eagerly recomputes when selector produces a different result", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    // First render: selector picks path
    useSegments((s) => s.path);
    const setState = stateSlots[0][1];

    // The first render also triggers setState because SSR initial state
    // (empty in Node where typeof document === "undefined") differs from
    // the event controller state. Clear that so we only check the re-render.
    setState.mockClear();

    // Simulate re-render: reset hook indices so useState/useRef return
    // existing slots, then call with a different selector
    resetHookIndices();
    useSegments((s) => s.segmentIds);

    expect(setState).toHaveBeenCalledWith(["L0", "L0L1"]);
  });

  it("does not call setState when selector produces the same result", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    // First render
    useSegments((s) => s.path);
    const setState = stateSlots[0][1];

    // First render triggers setState (SSR → client mismatch). Clear it.
    setState.mockClear();
    // Update prevState to reflect the setState that would have happened
    refSlots[0].current = ["shop", "products"];

    // Re-render with same selector behavior (new identity, same result)
    resetHookIndices();
    useSegments((s) => s.path);

    expect(setState).not.toHaveBeenCalled();
  });
});
