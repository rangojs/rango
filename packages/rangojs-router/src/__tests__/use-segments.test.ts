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
  const location = new URL("http://localhost/shop/products");
  // Stable references — real controller only swaps these on setHandleData.
  // useSegments() reads `routeSegmentIds`; `segmentOrder` is exposed for the
  // handle-collection consumer and may include parallel slot ids.
  const segmentOrder = ["L0", "L0L1"];
  const routeSegmentIds = ["L0", "L0L1"];
  return {
    getState: () => ({ location }),
    getLocation: vi.fn(() => location),
    getHandleState: vi.fn(() => ({ segmentOrder, routeSegmentIds })),
    getHydrationSnapshot: vi.fn(() => undefined),
    subscribe: vi.fn((_listener: () => void) => vi.fn()),
    subscribeToHandles: vi.fn((_listener: () => void) => vi.fn()),
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

  it("a re-render with a new selector reads nothing from the store", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);
    const setState = stateSlots[0][1];
    ec.getLocation.mockClear();
    ec.getHandleState.mockClear();

    resetHookIndices();
    useSegments((s) => s.segmentIds);

    expect(ec.getLocation).not.toHaveBeenCalled();
    expect(ec.getHandleState).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it("the next store change applies the current selector", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);
    const setState = stateSlots[0][1];
    capturedEffectFn!();
    setState.mockClear();

    resetHookIndices();
    useSegments((s) => s.segmentIds);
    const onStoreChange = ec.subscribe.mock.calls[0][0];
    onStoreChange();

    expect(setState).toHaveBeenCalledOnce();
    expect(setState).toHaveBeenCalledWith(["L0", "L0L1"]);
  });

  it("the next store change applies a removed selector as the full state", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);
    const setState = stateSlots[0][1];
    capturedEffectFn!();
    setState.mockClear();

    resetHookIndices();
    useSegments();
    const onStoreChange = ec.subscribeToHandles.mock.calls[0][0];
    onStoreChange();

    expect(setState).toHaveBeenCalledOnce();
    expect(setState).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ["shop", "products"],
        segmentIds: ["L0", "L0L1"],
      }),
    );
  });

  /**
   * Regression: useSegments().segmentIds is documented as "layouts and routes
   * only" but historically read from the same controller field that drives
   * handle collection. After the parallel-slot fix the handle order retains
   * parallel ids so per-bucket merge works; useSegments must not leak those
   * to consumers — its contract is unchanged.
   */
  it("segmentIds excludes parallel slot ids and loader sub-ids", () => {
    const location = new URL("http://localhost/inbox/email-1");
    const ec = {
      getState: () => ({ location }),
      getLocation: () => location,
      getHandleState: () => ({
        segmentOrder: ["L0", "L0.@panel", "R0", "R0.@meta"],
        routeSegmentIds: ["L0", "R0"],
      }),
      getHydrationSnapshot: vi.fn(() => undefined),
      subscribe: vi.fn(() => vi.fn()),
      subscribeToHandles: vi.fn(() => vi.fn()),
    };
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    const state = useSegments() as { segmentIds: readonly string[] };

    expect(state.segmentIds).toEqual(["L0", "R0"]);
  });

  it("a store change with an unchanged selection does not set state", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    // A composite selector returns a new object each call; the cached
    // SegmentsState keeps `path` the same reference, so it compares equal.
    useSegments((s) => ({ path: s.path }));
    const setState = stateSlots[0][1];
    capturedEffectFn!();
    setState.mockClear();

    const onStoreChange = ec.subscribe.mock.calls[0][0];
    onStoreChange();

    expect(setState).not.toHaveBeenCalled();
  });
});
