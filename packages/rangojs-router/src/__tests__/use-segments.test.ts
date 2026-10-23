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
    useLayoutEffect: vi.fn(),
  };
});

import { useContext } from "react";
import { useSegments } from "../browser/react/use-segments.js";
import { makeEventController } from "./kit/index.js";

const mockedUseContext = vi.mocked(useContext);

const SHOP_PAGE = {
  location: "/shop/products",
  segmentIds: ["L0", "L0L1"],
};

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
    const ec = makeEventController(SHOP_PAGE);
    const subscribe = vi.spyOn(ec, "subscribe");
    const subscribeToHandles = vi.spyOn(ec, "subscribeToHandles");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);

    capturedEffectFn!();

    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribeToHandles).toHaveBeenCalledOnce();
  });

  it("effect cleanup unsubscribes from both sources", () => {
    const unsubNav = vi.fn();
    const unsubHandles = vi.fn();
    const ec = makeEventController(SHOP_PAGE);
    vi.spyOn(ec, "subscribe").mockReturnValue(unsubNav);
    vi.spyOn(ec, "subscribeToHandles").mockReturnValue(unsubHandles);
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
    const ec = makeEventController(SHOP_PAGE);
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);

    expect(capturedEffectDeps).toEqual([]);
  });

  it("a re-render with a new selector reads nothing from the store", () => {
    const ec = makeEventController(SHOP_PAGE);
    const getLocation = vi.spyOn(ec, "getLocation");
    const getHandleState = vi.spyOn(ec, "getHandleState");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);
    const setState = stateSlots[0][1];
    getLocation.mockClear();
    getHandleState.mockClear();

    resetHookIndices();
    useSegments((s) => s.segmentIds);

    expect(getLocation).not.toHaveBeenCalled();
    expect(getHandleState).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it("the next store change applies the current selector", () => {
    const ec = makeEventController(SHOP_PAGE);
    const subscribe = vi.spyOn(ec, "subscribe");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);
    const setState = stateSlots[0][1];
    capturedEffectFn!();
    setState.mockClear();

    resetHookIndices();
    useSegments((s) => s.segmentIds);
    const onStoreChange = subscribe.mock.calls[0][0];
    onStoreChange();

    expect(setState).toHaveBeenCalledOnce();
    // The hook sets through an updater (useCommitAnchoredState).
    expect(setState.mock.calls[0][0]()).toEqual(["L0", "L0L1"]);
  });

  it("the next store change applies a removed selector as the full state", () => {
    const ec = makeEventController(SHOP_PAGE);
    const subscribeToHandles = vi.spyOn(ec, "subscribeToHandles");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);
    const setState = stateSlots[0][1];
    capturedEffectFn!();
    setState.mockClear();

    resetHookIndices();
    useSegments();
    const onStoreChange = subscribeToHandles.mock.calls[0][0];
    onStoreChange();

    expect(setState).toHaveBeenCalledOnce();
    expect(setState.mock.calls[0][0]()).toEqual(
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
    const ec = makeEventController({
      location: "/inbox/email-1",
      segmentIds: ["L0", "L0.@panel", "R0", "R0.@meta"],
    });
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    const state = useSegments() as { segmentIds: readonly string[] };

    expect(state.segmentIds).toEqual(["L0", "R0"]);
  });

  it("a store change with an unchanged selection does not set state", () => {
    const ec = makeEventController(SHOP_PAGE);
    const subscribe = vi.spyOn(ec, "subscribe");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    // A composite selector returns a new object each call; the cached
    // SegmentsState keeps `path` the same reference, so it compares equal.
    useSegments((s) => ({ path: s.path }));
    const setState = stateSlots[0][1];
    capturedEffectFn!();
    setState.mockClear();

    const onStoreChange = subscribe.mock.calls[0][0];
    onStoreChange();

    expect(setState).not.toHaveBeenCalled();
  });
});
