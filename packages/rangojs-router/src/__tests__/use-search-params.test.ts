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
import { useSearchParams } from "../browser/react/use-search-params.js";

const mockedUseContext = vi.mocked(useContext);

function createMockEventController(search = "?q=react&page=2") {
  const location = new URL(`http://localhost/products${search}`);
  return {
    getState: vi.fn(() => ({ location })),
    subscribe: vi.fn((_cb: () => void) => vi.fn()),
  };
}

describe("useSearchParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEffectFn = null;
    capturedEffectDeps = undefined;
    refSlots = [];
    refIndex = 0;
    stateSlots = [];
    stateIndex = 0;
  });

  /**
   * SSR-empty-seed contract: unlike usePathname (which seeds FROM ctx),
   * useSearchParams deliberately seeds with an empty URLSearchParams() on the
   * initial render even when ctx exists. The server only sends the pathname, so
   * seeding from anything else would risk a hydration mismatch. The hook syncs
   * the real query string on mount.
   */
  it("seeds with empty params on initial render even when ctx has search", () => {
    const ec = createMockEventController("?q=react&page=2");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    const result = useSearchParams();

    // Initial render: empty, NOT seeded from ctx's "?q=react&page=2".
    expect(result.toString()).toBe("");
    expect(result.get("q")).toBeNull();
  });

  /**
   * Mount catch-up: the effect reads location.searchParams and, when the query
   * differs from the seeded empty value, enqueues setSearchParams with the
   * real params. Mirrors usePathname's catch-up.
   */
  it("catches up to the real search params in the mount effect", () => {
    const ec = createMockEventController("?q=react&page=2");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSearchParams();
    const setSearchParams = stateSlots[0][1];

    capturedEffectFn!();

    expect(setSearchParams).toHaveBeenCalledTimes(1);
    const enqueued = setSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(enqueued.get("q")).toBe("react");
    expect(enqueued.get("page")).toBe("2");
    expect(ec.subscribe).toHaveBeenCalledOnce();
  });

  it("does not enqueue on mount when the query string is empty (matches seed)", () => {
    const ec = createMockEventController("");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSearchParams();
    const setSearchParams = stateSlots[0][1];

    capturedEffectFn!();

    // Seed is "" and the location query is also "" — no change, no enqueue.
    expect(setSearchParams).not.toHaveBeenCalled();
    expect(ec.subscribe).toHaveBeenCalledOnce();
  });

  it("enqueues on a subscribed change and not again when unchanged", () => {
    const ec = createMockEventController("?q=a");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSearchParams();
    const setSearchParams = stateSlots[0][1];

    // Mount catch-up reads "?q=a" and enqueues it.
    capturedEffectFn!();
    expect(setSearchParams).toHaveBeenCalledTimes(1);
    const subscribeCallback = ec.subscribe.mock.calls[0][0];

    setSearchParams.mockClear();

    // A change event with the same query must NOT re-enqueue (prevSearch guard).
    subscribeCallback();
    expect(setSearchParams).not.toHaveBeenCalled();

    // A change event with a new query enqueues the new params.
    ec.getState.mockReturnValue({
      location: new URL("http://localhost/products?q=b&sort=asc"),
    } as any);
    subscribeCallback();
    expect(setSearchParams).toHaveBeenCalledTimes(1);
    const next = setSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(next.get("q")).toBe("b");
    expect(next.get("sort")).toBe("asc");
  });

  it("effect cleanup unsubscribes", () => {
    const unsub = vi.fn();
    const ec = createMockEventController("?q=a");
    ec.subscribe.mockReturnValue(unsub);
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSearchParams();

    const cleanup = capturedEffectFn!() as () => void;
    cleanup();

    expect(unsub).toHaveBeenCalledOnce();
  });

  it("does not subscribe when context is null (SSR)", () => {
    mockedUseContext.mockReturnValue(null as any);

    const result = useSearchParams();
    const setSearchParams = stateSlots[0][1];

    // Effect runs but bails early because ctx is null.
    capturedEffectFn!();

    expect(result.toString()).toBe("");
    expect(setSearchParams).not.toHaveBeenCalled();
  });
});
