import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedEffectFn: (() => (() => void) | void) | null = null;
let capturedEffectDeps: any[] | undefined;

let refSlots: Array<{ current: any }> = [];
let refIndex = 0;
let stateSlots: Array<[any, ReturnType<typeof vi.fn>]> = [];
let stateIndex = 0;
let setOptimistic = vi.fn();

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
    useOptimistic: vi.fn((base: any) => [base, setOptimistic]),
    startTransition: vi.fn((fn: () => void) => fn()),
  };
});

import { useContext } from "react";
import {
  useLinkStatus,
  LinkContext,
} from "../browser/react/use-link-status.js";
import { NavigationStoreContext } from "../browser/react/context.js";

const mockedUseContext = vi.mocked(useContext);

function createMockEventController(pendingUrl: string | null = null) {
  return {
    getState: vi.fn(() => ({
      state: pendingUrl ? "loading" : "idle",
      pendingUrl,
    })),
    subscribe: vi.fn((_cb: () => void) => vi.fn()),
  };
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

describe("useLinkStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEffectFn = null;
    capturedEffectDeps = undefined;
    refSlots = [];
    refIndex = 0;
    stateSlots = [];
    stateIndex = 0;
    setOptimistic = vi.fn();
  });

  it("returns not pending when not inside a Link", () => {
    wireContexts(null, null);
    const result = useLinkStatus();
    expect(result).toEqual({ pending: false });
  });

  it("seeds pending from the controller for a matching link", () => {
    const ec = createMockEventController("/dashboard");
    wireContexts("/dashboard", { eventController: ec });

    const result = useLinkStatus();
    expect(result).toEqual({ pending: true });
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
    let pendingUrl: string | null = null;
    const ec = {
      getState: vi.fn(() => ({
        state: pendingUrl ? "loading" : "idle",
        pendingUrl,
      })),
      subscribe: vi.fn((_cb: () => void) => vi.fn()),
    };
    wireContexts("/dashboard", { eventController: ec });

    // Seeding render: idle, not pending.
    useLinkStatus();
    const setBasePending = stateSlots[0][1];
    expect(setBasePending).not.toHaveBeenCalled();

    // Navigation to /dashboard starts BEFORE the effect commits.
    pendingUrl = "/dashboard";

    // Effect commit: catch-up must observe pending and enqueue it.
    capturedEffectFn!();

    expect(setBasePending).toHaveBeenCalledWith(true);
    expect(ec.subscribe).toHaveBeenCalledOnce();
  });

  it("does not enqueue on effect commit when pending is unchanged", () => {
    const ec = createMockEventController(null);
    wireContexts("/dashboard", { eventController: ec });

    useLinkStatus();
    const setBasePending = stateSlots[0][1];

    capturedEffectFn!();

    expect(setBasePending).not.toHaveBeenCalled();
    expect(ec.subscribe).toHaveBeenCalledOnce();
  });

  /**
   * Regression (F1): the optimistic pending value must be released when the
   * navigation returns to idle. While loading, useLinkStatus pins the optimistic
   * value to `true` in a transition; at completion `state.state` is already
   * "idle", so the old code only ran setBasePending(false) and left the pinned
   * optimistic `true` in place. For view-transition routes the base `false` is
   * deferred behind the still-pending commit transition, so the spinner stayed
   * stuck. The fix mirrors useNavigation's optimisticPinnedRef release branch.
   */
  it("releases the pinned optimistic value when navigation returns to idle", () => {
    let state = "idle";
    let pendingUrl: string | null = null;
    const ec = {
      getState: vi.fn(() => ({ state, pendingUrl })),
      subscribe: vi.fn((_cb: () => void) => vi.fn()),
    };
    wireContexts("/dashboard", { eventController: ec });

    useLinkStatus();
    capturedEffectFn!();
    const subscribeCallback = ec.subscribe.mock.calls[0][0];

    // Navigation to /dashboard starts: loading + pending. This pins the
    // optimistic value to true inside a transition.
    state = "loading";
    pendingUrl = "/dashboard";
    subscribeCallback();
    expect(setOptimistic).toHaveBeenCalledWith(true);

    setOptimistic.mockClear();

    // Navigation completes: state is idle and no longer pending. The pinned
    // optimistic `true` must be released by setting it back to false.
    state = "idle";
    pendingUrl = null;
    subscribeCallback();

    expect(setOptimistic).toHaveBeenCalledWith(false);
  });

  it("does not release when nothing was pinned (no spurious optimistic call)", () => {
    // A navigation to a DIFFERENT link never pins this link's optimistic value;
    // when it settles, no release should fire.
    let state = "idle";
    let pendingUrl: string | null = null;
    const ec = {
      getState: vi.fn(() => ({ state, pendingUrl })),
      subscribe: vi.fn((_cb: () => void) => vi.fn()),
    };
    wireContexts("/dashboard", { eventController: ec });

    useLinkStatus();
    capturedEffectFn!();
    const subscribeCallback = ec.subscribe.mock.calls[0][0];

    // A different link is navigated to: this link is not pending, so no pin.
    state = "loading";
    pendingUrl = "/other";
    subscribeCallback();
    expect(setOptimistic).not.toHaveBeenCalled();

    // It settles back to idle: still no optimistic release for this link.
    state = "idle";
    pendingUrl = null;
    subscribeCallback();
    expect(setOptimistic).not.toHaveBeenCalled();
  });
});
