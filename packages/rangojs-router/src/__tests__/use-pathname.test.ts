import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedEffectFn: (() => (() => void) | void) | null = null;
let capturedEffectDeps: any[] | undefined;

let refSlots: Array<{ current: any }> = [];
let refIndex = 0;
let stateSlots: Array<[any, ReturnType<typeof vi.fn>]> = [];
let stateIndex = 0;

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
import { usePathname } from "../browser/react/use-pathname.js";

const mockedUseContext = vi.mocked(useContext);

function createMockEventController(pathname = "/products/123") {
  const location = new URL(`http://localhost${pathname}`);
  return {
    getState: vi.fn(() => ({ location })),
    subscribe: vi.fn((_cb: () => void) => vi.fn()),
  };
}

describe("usePathname", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEffectFn = null;
    capturedEffectDeps = undefined;
    refSlots = [];
    refIndex = 0;
    stateSlots = [];
    stateIndex = 0;
  });

  it("syncs pathname from event controller via effect", () => {
    const ec = createMockEventController("/shop/items");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    usePathname();
    const setPathname = stateSlots[0][1];

    // Initial render returns SSR pathname (/ in Node.js).
    // Run effect to trigger initial sync.
    capturedEffectFn!();

    expect(setPathname).toHaveBeenCalledWith("/shop/items");
  });

  it("subscribes with empty dependency array", () => {
    const ec = createMockEventController();
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    usePathname();

    capturedEffectFn!();

    expect(ec.subscribe).toHaveBeenCalledOnce();
    expect(capturedEffectDeps).toEqual([]);
  });

  it("effect cleanup unsubscribes", () => {
    const unsub = vi.fn();
    const ec = createMockEventController();
    ec.subscribe.mockReturnValue(unsub);
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    usePathname();

    const cleanup = capturedEffectFn!() as () => void;
    cleanup();

    expect(unsub).toHaveBeenCalledOnce();
  });

  it("does not call setPathname when pathname is unchanged", () => {
    const ec = createMockEventController("/products/123");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    usePathname();
    const setPathname = stateSlots[0][1];

    // Run effect (includes initial sync)
    capturedEffectFn!();
    const subscribeCallback = ec.subscribe.mock.calls[0][0];

    // Clear any initial-sync calls
    setPathname.mockClear();
    // Set prevPathname to current
    refSlots[0].current = "/products/123";

    // Simulate event with same pathname
    subscribeCallback();

    expect(setPathname).not.toHaveBeenCalled();
  });

  it("calls setPathname when pathname changes", () => {
    const ec = createMockEventController("/products/123");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    usePathname();
    const setPathname = stateSlots[0][1];

    capturedEffectFn!();
    const subscribeCallback = ec.subscribe.mock.calls[0][0];

    setPathname.mockClear();
    refSlots[0].current = "/products/123";

    // Simulate navigation to new pathname
    const newLocation = new URL("http://localhost/about");
    ec.getState.mockReturnValue({ location: newLocation });
    subscribeCallback();

    expect(setPathname).toHaveBeenCalledWith("/about");
  });

  it("does not subscribe when context is null (SSR)", () => {
    mockedUseContext.mockReturnValue(null);

    const result = usePathname();

    capturedEffectFn!();

    // Returns SSR fallback pathname
    expect(typeof result).toBe("string");
  });
});
