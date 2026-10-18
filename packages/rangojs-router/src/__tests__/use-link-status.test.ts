import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedEffectFn: (() => (() => void) | void) | null = null;
let capturedEffectDeps: any[] | undefined;

let stateSlots: Array<[any, ReturnType<typeof vi.fn>]> = [];
let stateIndex = 0;
const { startTransition } = vi.hoisted(() => ({
  startTransition: vi.fn((fn: () => void) => fn()),
}));

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
    useEffect: vi.fn((fn: () => (() => void) | void, deps?: any[]) => {
      capturedEffectFn = fn;
      capturedEffectDeps = deps;
    }),
    startTransition,
  };
});

import { useContext } from "react";
import {
  useLinkStatus,
  LinkContext,
} from "../browser/react/use-link-status.js";
import { NavigationStoreContext } from "../browser/react/context.js";
import type { NavigationEntry } from "../browser/event-controller.js";

const mockedUseContext = vi.mocked(useContext);

function entry(
  url: string,
  options?: NavigationEntry["options"],
): NavigationEntry {
  return {
    url,
    abort: new AbortController(),
    phase: "fetching",
    startedAt: 0,
    options,
  };
}

function createMockEventController(initial: NavigationEntry | null = null) {
  const ec = {
    navigation: initial,
    getCurrentNavigation: vi.fn(() => ec.navigation),
    getHydrationSnapshot: vi.fn((): object | undefined => undefined),
    subscribe: vi.fn((_cb: () => void) => vi.fn()),
  };
  return ec;
}

/**
 * useLinkStatus calls useContext(LinkContext) then
 * useContext(NavigationStoreContext). Route each context to its value.
 */
function wireContexts(linkTo: string | null, ctx: any) {
  mockedUseContext.mockImplementation((context: any) => {
    if (context === LinkContext) return linkTo as any;
    if (context === NavigationStoreContext) return ctx;
    return null as any;
  });
}

/** Mount the hook and run its effect; returns the setter and the listener. */
function mount(ec: ReturnType<typeof createMockEventController>) {
  wireContexts("/dashboard", { eventController: ec });
  const result = useLinkStatus();
  const setPending = stateSlots[0][1];
  capturedEffectFn!();
  setPending.mockClear();
  const notify = ec.subscribe.mock.calls[0][0] as () => void;
  return { result, setPending, notify };
}

describe("useLinkStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEffectFn = null;
    capturedEffectDeps = undefined;
    stateSlots = [];
    stateIndex = 0;
  });

  it("returns not pending when not inside a Link", () => {
    wireContexts(null, null);
    const result = useLinkStatus();
    expect(result).toEqual({ pending: false });
  });

  it("seeds pending from the controller for a matching link", () => {
    const ec = createMockEventController(entry("http://localhost/dashboard"));
    wireContexts("/dashboard", { eventController: ec });

    expect(useLinkStatus()).toEqual({ pending: true });
  });

  it("seeds not pending while the document hydrates", () => {
    const ec = createMockEventController(entry("/dashboard"));
    ec.getHydrationSnapshot.mockReturnValue({});
    wireContexts("/dashboard", { eventController: ec });

    expect(useLinkStatus()).toEqual({ pending: false });
  });

  it("subscribes with [linkTo, origin] dependency array", () => {
    const ec = createMockEventController();
    wireContexts("/dashboard", { eventController: ec });

    useLinkStatus();
    capturedEffectFn!();

    expect(ec.subscribe).toHaveBeenCalledOnce();
    expect(capturedEffectDeps).toHaveLength(2);
  });

  /**
   * Regression (F2): the effect must re-read the pending state synchronously
   * before subscribing, so a navigation to this link that started between the
   * seeding render and the effect commit isn't dropped until the next notify.
   * Mirrors usePathname / useSearchParams catch-up.
   */
  it("catches up on a navigation that started between render and effect commit", () => {
    const ec = createMockEventController(null);
    wireContexts("/dashboard", { eventController: ec });

    // Seeding render: idle, not pending.
    useLinkStatus();
    const setPending = stateSlots[0][1];
    expect(setPending).not.toHaveBeenCalled();

    // Navigation to /dashboard starts BEFORE the effect commits.
    ec.navigation = entry("/dashboard");

    // Effect commit: catch-up must observe pending and enqueue it.
    capturedEffectFn!();

    expect(setPending).toHaveBeenCalledWith(true);
    expect(ec.subscribe).toHaveBeenCalledOnce();
  });

  it("is pending from the navigation's start until it ends, and never starts a transition", () => {
    const ec = createMockEventController(null);
    const { setPending, notify } = mount(ec);

    ec.navigation = entry("/dashboard");
    notify();
    expect(setPending).toHaveBeenLastCalledWith(true);

    // The response starts streaming: the same navigation, nothing to set.
    ec.navigation.phase = "streaming";
    notify();
    expect(setPending).toHaveBeenCalledOnce();

    // The commit clears it, inside the page's update.
    ec.navigation = null;
    notify();
    expect(setPending).toHaveBeenLastCalledWith(false);
    expect(startTransition).not.toHaveBeenCalled();
  });

  it("a newer navigation sets the value again at its call, even when it did not move", () => {
    const ec = createMockEventController(entry("/dashboard"));
    const { setPending, notify } = mount(ec);

    // Committed: false, which React may hold with the page.
    ec.navigation = null;
    notify();
    // An unrelated notification while that page is held sets nothing.
    notify();
    expect(setPending.mock.calls).toEqual([[false]]);

    // A newer navigation elsewhere: false again, now, at its call.
    ec.navigation = entry("/other");
    notify();
    expect(setPending.mock.calls).toEqual([[false], [false]]);
  });

  it("stays pending through a server redirect from this link", () => {
    const ec = createMockEventController(entry("/dashboard"));
    const { setPending, notify } = mount(ec);

    ec.navigation = entry("/login", { _redirectFrom: "/dashboard" });
    notify();
    expect(setPending).toHaveBeenLastCalledWith(true);
  });

  it("a navigation that shows no loading state neither makes a link pending nor ends one", () => {
    const ec = createMockEventController(null);
    const { setPending, notify } = mount(ec);

    ec.navigation = entry("/dashboard", { skipLoadingState: true });
    notify();
    expect(setPending).not.toHaveBeenCalled();

    // This link's navigation commits (false, held with its page); an
    // action's background refetch then starts: nothing is set again.
    ec.navigation = entry("/dashboard");
    notify();
    ec.navigation = null;
    notify();
    ec.navigation = entry("/dashboard", { skipLoadingState: true });
    notify();
    expect(setPending.mock.calls).toEqual([[true], [false]]);
  });
});
