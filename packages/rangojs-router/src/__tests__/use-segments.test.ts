import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedEffectFn: (() => (() => void) | void) | null = null;
let capturedEffectDeps: any[] | undefined;

// Mock react to track useEffect calls (subscription stability)
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useContext: vi.fn(),
    useState: vi.fn((init: Function | any) => {
      const val = typeof init === "function" ? init() : init;
      return [val, vi.fn()];
    }),
    useRef: vi.fn((val: any) => ({ current: val })),
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
  });

  it("subscribes to event controller when context is available", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);

    // Run the captured effect
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

    // Effect should still be captured but shouldn't subscribe
    capturedEffectFn!();

    expect(state).toHaveProperty("path");
    expect(state).toHaveProperty("segmentIds");
    expect(state).toHaveProperty("location");
  });

  it("useEffect has empty dependency array (selectorRef pattern)", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSegments((s) => s.path);

    // The key assertion: deps should be [] not [selector]
    // This ensures inline selectors don't cause re-subscription
    expect(capturedEffectDeps).toEqual([]);
  });
});
