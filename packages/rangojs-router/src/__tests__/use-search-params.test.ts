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
    useCallback: vi.fn((fn: Function) => fn),
    useMemo: vi.fn((fn: Function) => fn()),
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

function mockCtx(ec: ReturnType<typeof createMockEventController>) {
  const navigate = vi.fn(() => Promise.resolve());
  mockedUseContext.mockReturnValue({ eventController: ec, navigate } as any);
  return { navigate };
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
   * Seed-from-store contract (mirrors usePathname): the initial render reads
   * the store location — during document SSR that is the LIVE request's
   * search (seeded via SSRRenderOptions.search), in the browser it is
   * window.location. Both derive from the same URL, so the hydration renders
   * agree; the old SSR-empty seed (and its post-hydration flicker) is gone.
   */
  it("seeds from the store location on the initial render", () => {
    const ec = createMockEventController("?q=react&page=2");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    const [params] = useSearchParams();

    expect(params.get("q")).toBe("react");
    expect(params.get("page")).toBe("2");
  });

  /**
   * The mount effect must NOT re-enqueue when the seed already matches the
   * location (prevSearch is initialized from the seed, not "").
   */
  it("does not re-enqueue on mount when the seed matches the location", () => {
    const ec = createMockEventController("?q=react&page=2");
    mockedUseContext.mockReturnValue({ eventController: ec } as any);

    useSearchParams();
    const setSearchParams = stateSlots[0][1];

    capturedEffectFn!();

    expect(setSearchParams).not.toHaveBeenCalled();
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

    // Seed already matches "?q=a" — no mount enqueue.
    capturedEffectFn!();
    expect(setSearchParams).not.toHaveBeenCalled();
    const subscribeCallback = ec.subscribe.mock.calls[0][0];

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

  it("seeds empty and does not subscribe without a provider", () => {
    mockedUseContext.mockReturnValue(null as any);

    const [params] = useSearchParams();
    const setSearchParams = stateSlots[0][1];

    // Effect runs but bails early because ctx is null.
    capturedEffectFn!();

    expect(params.toString()).toBe("");
    expect(setSearchParams).not.toHaveBeenCalled();
  });

  describe("setter", () => {
    it("replaces the whole search string and pushes by default", async () => {
      const ec = createMockEventController("?q=react&page=2");
      const { navigate } = mockCtx(ec);

      const [, setSearch] = useSearchParams();
      await setSearch({ category: "electronics" });

      // Wholesale replace (RR semantics): q/page are gone, not merged.
      expect(navigate).toHaveBeenCalledWith("/products?category=electronics", {
        replace: false,
      });
    });

    it("functional init merges against params read at CALL time", async () => {
      const ec = createMockEventController("?q=a");
      const { navigate } = mockCtx(ec);

      const [, setSearch] = useSearchParams();

      // Location changes AFTER render: the functional form must see it.
      ec.getState.mockReturnValue({
        location: new URL("http://localhost/products?q=b"),
      } as any);

      await setSearch((prev) => {
        expect(prev.get("q")).toBe("b");
        prev.set("page", "3");
        return prev;
      });

      expect(navigate).toHaveBeenCalledWith("/products?q=b&page=3", {
        replace: false,
      });
    });

    it("normalizes record inits: stringifies, appends arrays, skips null/undefined", async () => {
      const ec = createMockEventController("");
      const { navigate } = mockCtx(ec);

      const [, setSearch] = useSearchParams();
      await setSearch({
        page: 2,
        active: true,
        tag: ["a", "b"],
        gone: null,
        alsoGone: undefined,
      });

      expect(navigate).toHaveBeenCalledWith(
        "/products?page=2&active=true&tag=a&tag=b",
        { replace: false },
      );
    });

    it("navigates to the bare pathname when the result is empty", async () => {
      const ec = createMockEventController("?q=react");
      const { navigate } = mockCtx(ec);

      const [, setSearch] = useSearchParams();
      await setSearch({});

      expect(navigate).toHaveBeenCalledWith("/products", { replace: false });
    });

    it("forwards replace, scroll, and revalidate options", async () => {
      const ec = createMockEventController("");
      const { navigate } = mockCtx(ec);

      const [, setSearch] = useSearchParams();
      await setSearch("q=x", {
        replace: true,
        scroll: false,
        revalidate: false,
      });

      expect(navigate).toHaveBeenCalledWith("/products?q=x", {
        replace: true,
        scroll: false,
        revalidate: false,
      });
    });

    it("throws when called without NavigationProvider", () => {
      mockedUseContext.mockReturnValue(null as any);

      const [, setSearch] = useSearchParams();
      expect(() => setSearch({ q: "x" })).toThrow(
        "useSearchParams setter must be used within NavigationProvider",
      );
    });
  });
});
