import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventController } from "../browser/event-controller";
import { createServerActionBridge } from "../browser/server-action-bridge";
import type { ResolvedSegment } from "../browser/types";

// Record whether each onUpdate ran inside startTransition (the held lane) or
// urgently.
const lane = vi.hoisted(() => ({ inTransition: false }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    startTransition: (fn: () => void) => {
      lane.inTransition = true;
      try {
        fn();
      } finally {
        lane.inTransition = false;
      }
    },
  };
});

/**
 * transition({ when }) on the action commit: kind "action", `to` is `from`,
 * and the `action` fields, on the normal lane and on the error-boundary lane
 * (with `action.error`).
 */

function seg(
  id: string,
  extra: Partial<ResolvedSegment> = {},
): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type: "route",
    component: `component-${id}`,
    params: { id: "1" },
    ...extra,
  } as ResolvedSegment;
}

function setup(payload: unknown, cached: ResolvedSegment[]) {
  vi.stubGlobal("window", {
    location: {
      href: "http://localhost/items/1",
      pathname: "/items/1",
      origin: "http://localhost",
    },
    history: {
      state: { key: "k1", __rsc_ls_s: "entry" },
      replaceState: vi.fn(),
    },
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
  const store = {
    getSegmentState: vi.fn(() => ({
      path: "/items/1",
      currentUrl: "http://localhost/items/1",
      currentSegmentIds: cached.map((s) => s.id),
    })),
    getHistoryKey: vi.fn(() => "/items/1"),
    getCachedSegments: vi.fn(() => ({ segments: cached, stale: false })),
    setSegmentIds: vi.fn(),
    cacheSegmentsForHistory: vi.fn(),
    rememberDisplayedEntry: vi.fn(),
    getHistoryEntryMemory: vi.fn(() => ({
      routeName: "items.detail",
      state: { key: "k1" },
    })),
    markCacheAsStaleAndBroadcast: vi.fn(),
    getInterceptSourceUrl: vi.fn(() => null),
    getRouterId: vi.fn(() => undefined),
  };
  const setServerCallback = vi.fn();
  const renderSegments = vi.fn(async (..._args: any[]) => "tree");
  const commitLanes: boolean[] = [];
  const onUpdate = vi.fn(() => {
    commitLanes.push(lane.inTransition);
  });
  createServerActionBridge({
    store: store as any,
    client: {} as any,
    eventController: createEventController(),
    deps: {
      createTemporaryReferenceSet: vi.fn(() => ({})),
      encodeReply: vi.fn(async () => ""),
      createFromFetch: vi.fn(async () => payload),
      setServerCallback,
    } as any,
    onUpdate,
    renderSegments,
  }).register();
  const callback = setServerCallback.mock.calls[0]![0] as (
    id: string,
    args: unknown[],
  ) => Promise<unknown>;
  return { callback, renderSegments, store, commitLanes };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("server-action-bridge transition({ when })", () => {
  it("decides the normal action commit with kind action and the action's formData and result", async () => {
    const seen: any[] = [];
    const when = vi.fn((ctx: any) => {
      seen.push(ctx);
      return false;
    });
    const cached = [seg("R0", { transition: { when } })];
    const { callback, renderSegments, commitLanes } = setup(
      {
        metadata: {
          pathname: "/items/1",
          segments: [seg("R0", { transition: { when } })],
          matched: ["R0"],
          diff: ["R0"],
          params: { id: "1" },
          routeName: "items.detail",
          isPartial: true,
        },
        returnValue: { ok: true, data: "saved" },
      },
      cached,
    );
    const formData = new FormData();

    await expect(callback("hash#save", [{ prev: 0 }, formData])).resolves.toBe(
      "saved",
    );

    expect(when).toHaveBeenCalledTimes(1);
    const ctx = seen[0];
    expect(ctx.kind).toBe("action");
    expect(ctx.to).toBe(ctx.from);
    expect(ctx.from.url.href).toBe("http://localhost/items/1");
    expect(ctx.from.routeName).toBe("items.detail");
    expect(ctx.from.state).toEqual({ key: "k1", __rsc_ls_s: "entry" });
    expect(ctx.isAction()).toBe(true);
    expect(ctx.action).toEqual({
      id: "hash#save",
      formData,
      result: "saved",
      error: undefined,
    });
    expect(renderSegments.mock.calls[0]![1]).toMatchObject({
      transitionGatedOff: true,
      isAction: true,
    });
    // Gated off: urgent, so a re-suspending segment streams its loading().
    expect(commitLanes).toEqual([false]);
  });

  it("decides the error-boundary commit of a failed action with action.error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: any[] = [];
    const when = vi.fn((ctx: any) => {
      seen.push(ctx);
      return true;
    });
    const failure = new Error("nope");
    const cached = [
      seg("L0", { type: "layout", transition: { when } }),
      seg("L0R0"),
    ];
    const { callback, renderSegments, commitLanes } = setup(
      {
        metadata: {
          pathname: "/items/1",
          segments: [seg("L0R0", { type: "error", component: "boundary" })],
          matched: ["L0", "L0R0"],
          diff: ["L0R0"],
          isPartial: true,
          isError: true,
        },
        returnValue: { ok: false, data: failure },
      },
      cached,
    );

    await expect(callback("hash#save", [])).rejects.toBe(failure);

    expect(when).toHaveBeenCalledTimes(1);
    expect(seen[0].kind).toBe("action");
    expect(seen[0].action).toEqual({
      id: "hash#save",
      formData: undefined,
      result: undefined,
      error: failure,
    });
    expect(renderSegments.mock.calls[0]![1]).toMatchObject({
      transitionGatedOff: false,
    });
    // true keeps the action's held lane.
    expect(commitLanes).toEqual([true]);
  });

  it.each([
    [true, [true]],
    [false, [false]],
  ])(
    "the normal action commit with when -> %s commits in lanes %j",
    async (result, lanes) => {
      const when = vi.fn(() => result);
      const { callback, commitLanes } = setup(
        {
          metadata: {
            pathname: "/items/1",
            segments: [seg("R0", { transition: { when } })],
            matched: ["R0"],
            diff: ["R0"],
            isPartial: true,
          },
          returnValue: { ok: true, data: 1 },
        },
        [seg("R0", { transition: { when } })],
      );
      await callback("hash#save", []);
      expect(commitLanes).toEqual(lanes);
    },
  );

  it("a gated-off error-boundary commit is urgent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const when = vi.fn(() => false);
    const failure = new Error("nope");
    const { callback, commitLanes } = setup(
      {
        metadata: {
          pathname: "/items/1",
          segments: [seg("L0R0", { type: "error", component: "boundary" })],
          matched: ["L0", "L0R0"],
          diff: ["L0R0"],
          isPartial: true,
          isError: true,
        },
        returnValue: { ok: false, data: failure },
      },
      [seg("L0", { type: "layout", transition: { when } }), seg("L0R0")],
    );
    await expect(callback("hash#save", [])).rejects.toBe(failure);
    expect(commitLanes).toEqual([false]);
  });
});
