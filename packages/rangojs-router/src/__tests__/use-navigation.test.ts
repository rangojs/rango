import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedEffectFn: (() => (() => void) | void) | null = null;
let capturedEffectDeps: any[] | undefined;

let refSlots: Array<{ current: any }> = [];
let refIndex = 0;
let stateSlots: Array<[any, ReturnType<typeof vi.fn>]> = [];
let stateIndex = 0;
let optimisticValue: any = undefined;
let setOptimistic = vi.fn();

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
    useOptimistic: vi.fn((base: any) => {
      optimisticValue = base;
      return [base, setOptimistic];
    }),
    startTransition: vi.fn((fn: () => void) => fn()),
  };
});

import { useContext } from "react";
import { useNavigation } from "../browser/react/use-navigation.js";

const mockedUseContext = vi.mocked(useContext);

function createMockEventController(overrides?: {
  state?: string;
  inflightSize?: number;
}) {
  const location = new URL("http://localhost/shop");
  return {
    getState: vi.fn(() => ({
      state: overrides?.state ?? "idle",
      location,
      inflightActions: new Map(),
    })),
    getInflightActions: vi.fn(
      () => new Map(overrides?.inflightSize ? [["a", {}]] : []),
    ),
    subscribe: vi.fn((_cb: () => void) => vi.fn()),
  };
}

describe("useNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEffectFn = null;
    capturedEffectDeps = undefined;
    refSlots = [];
    refIndex = 0;
    stateSlots = [];
    stateIndex = 0;
    optimisticValue = undefined;
    setOptimistic = vi.fn();
  });

  it("throws when used outside NavigationProvider", () => {
    mockedUseContext.mockReturnValue(null);
    expect(() => useNavigation()).toThrow(
      "useNavigation must be used within NavigationProvider",
    );
  });

  it("subscribes to event controller with empty dependency array", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useNavigation();

    capturedEffectFn!();

    expect(ec.subscribe).toHaveBeenCalledOnce();
    expect(capturedEffectDeps).toEqual([]);
  });

  it("effect cleanup unsubscribes", () => {
    const unsub = vi.fn();
    const ec = createMockEventController();
    ec.subscribe.mockReturnValue(unsub);
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useNavigation();

    const cleanup = capturedEffectFn!() as () => void;
    cleanup();

    expect(unsub).toHaveBeenCalledOnce();
  });

  it("applies selector on initial render", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    const result = useNavigation((nav) => nav.state);

    expect(result).toBe("idle");
  });

  it("selector ref prevents re-subscription on selector identity change", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useNavigation((nav) => nav.state);

    capturedEffectFn!();
    expect(ec.subscribe).toHaveBeenCalledOnce();

    // Re-render with new selector identity
    resetHookIndices();
    useNavigation((nav) => nav.location);

    // Effect should not re-run (deps are [])
    expect(capturedEffectDeps).toEqual([]);
  });

  it("subscription callback uses latest selector via ref", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    // First render picks state
    useNavigation((nav) => nav.state);
    const setBaseValue = stateSlots[0][1];

    // Run effect to get the subscription callback
    capturedEffectFn!();
    const subscribeCallback = ec.subscribe.mock.calls[0][0];

    // Clear initial setState and set prevState to current value
    setBaseValue.mockClear();
    // refSlots[0] = prevState, refSlots[1] = selectorRef
    refSlots[0].current = "idle";

    // Re-render with different selector (picks location)
    resetHookIndices();
    useNavigation((nav) => nav.location);

    // Simulate event: subscription callback should use the NEW selector
    subscribeCallback();

    expect(setBaseValue).toHaveBeenCalledWith(new URL("http://localhost/shop"));
  });
});
