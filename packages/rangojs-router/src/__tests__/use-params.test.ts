import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedEffectFn: (() => (() => void) | void) | null = null;
let capturedEffectDeps: any[] | undefined;

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
import { useParams } from "../browser/react/use-params.js";

const mockedUseContext = vi.mocked(useContext);

function createMockEventController() {
  const params = { productId: "123", slug: "test-item" };
  return {
    getState: vi.fn(() => ({
      state: "idle",
      location: new URL("http://localhost/products/123"),
    })),
    getParams: vi.fn(() => params),
    subscribe: vi.fn((_cb: () => void) => vi.fn()),
  };
}

describe("useParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEffectFn = null;
    capturedEffectDeps = undefined;
    refSlots = [];
    refIndex = 0;
    stateSlots = [];
    stateIndex = 0;
  });

  it("returns full params from event controller on initial render", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    const result = useParams();
    const setValue = stateSlots[0][1];

    expect(result).toEqual({
      productId: "123",
      slug: "test-item",
    });

    // Effect sync sees no change and should not enqueue an update.
    capturedEffectFn!();
    expect(setValue).not.toHaveBeenCalled();
  });

  it("applies selector on initial render", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    const result = useParams((p) => p.productId);
    const setValue = stateSlots[0][1];

    expect(result).toBe("123");

    // Effect sync sees no change and should not enqueue an update.
    capturedEffectFn!();
    expect(setValue).not.toHaveBeenCalled();
  });

  it("subscribes to event controller with empty dependency array", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useParams();

    capturedEffectFn!();

    expect(ec.subscribe).toHaveBeenCalledOnce();
    expect(capturedEffectDeps).toEqual([]);
  });

  it("effect cleanup unsubscribes", () => {
    const unsub = vi.fn();
    const ec = createMockEventController();
    ec.subscribe.mockReturnValue(unsub);
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useParams();

    const cleanup = capturedEffectFn!() as () => void;
    cleanup();

    expect(unsub).toHaveBeenCalledOnce();
  });

  it("does not subscribe when context is null (SSR)", () => {
    mockedUseContext.mockReturnValue(null);

    const result = useParams();

    capturedEffectFn!();

    // Returns SSR params (empty by default)
    expect(result).toEqual({});
  });

  it("selector ref prevents re-subscription on identity change", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useParams((p) => p.productId);

    capturedEffectFn!();
    expect(ec.subscribe).toHaveBeenCalledOnce();

    // Re-render with new selector identity
    resetHookIndices();
    useParams((p) => p.slug);

    // Effect deps still empty, no re-subscription
    expect(capturedEffectDeps).toEqual([]);
  });

  it("subscription callback uses latest selector via ref", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    // First render picks productId
    useParams((p) => p.productId);
    const setValue = stateSlots[0][1];

    // Run effect to get the subscription callback
    capturedEffectFn!();
    const subscribeCallback = ec.subscribe.mock.calls[0][0];

    // Clear initial-sync setState
    setValue.mockClear();
    // Update prevValue to current value
    refSlots[0].current = "123";

    // Re-render with different selector (picks slug)
    resetHookIndices();
    useParams((p) => p.slug);

    // Simulate event: subscription callback should use the NEW selector
    subscribeCallback();

    expect(setValue).toHaveBeenCalledWith("test-item");
  });
});
