import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSegment } from "../browser/types";

/**
 * #1165: every commit the router runs in a transition carries its
 * transition({ when }) kind (push, replace, pop, action, revalidate) as a
 * transition type, first, then the types it carried before (navigation,
 * navigation-back, action, rango-optimistic-commit). Urgent commits run no
 * transition and carry none. Pins browser/partial-update.ts
 * (commitInTransition and its callers), browser/server-action-bridge.ts (the
 * action commit and its error-boundary commit), and the history-cache restore
 * in browser/navigation-bridge.ts, which adds no kind.
 */

// Each startTransition opens a type list; addTransitionType dedupes into it
// like React (react.development.js addTransitionType) and throws outside one,
// where React would start a transition of its own.
const rec = vi.hoisted(() => ({ current: null as string[] | null }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    startTransition: (fn: () => void) => {
      const outer = rec.current;
      rec.current = [];
      try {
        fn();
      } finally {
        rec.current = outer;
      }
    },
    addTransitionType: (type: string) => {
      if (!rec.current) {
        throw new Error(`addTransitionType("${type}") outside a transition`);
      }
      if (!rec.current.includes(type)) rec.current.push(type);
    },
  };
});
vi.mock("../browser/segment-structure-assert.js", () => ({
  assertSegmentStructure: vi.fn(),
}));
vi.mock("../browser/scroll-restoration.js", () => ({
  handleNavigationStart: vi.fn(),
  handleNavigationEnd: vi.fn(),
  handleTraversalStart: vi.fn(),
  ensureHistoryKey: vi.fn(),
  getHistoryStateKey: vi.fn(() => "k"),
}));

import {
  createPartialUpdater,
  type UpdateMode,
} from "../browser/partial-update";
import { createNavigationBridge } from "../browser/navigation-bridge";
import { createServerActionBridge } from "../browser/server-action-bridge";
import { createEventController } from "../browser/event-controller";
import { LoaderStore } from "../loader-store";

type Commit = readonly string[] | "urgent";

/** What each onUpdate committed with: its transition's types, or "urgent". */
function recorder() {
  const commits: Commit[] = [];
  const onUpdate = vi.fn(() => void commits.push(rec.current ?? "urgent"));
  return { commits, onUpdate };
}

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
    ...extra,
  } as ResolvedSegment;
}

const withTransition = (id: string, extra: Partial<ResolvedSegment> = {}) =>
  seg(id, { transition: {}, ...extra });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("partial-update commits carry their kind", () => {
  function store(onScreen: ResolvedSegment[]) {
    return {
      loaders: new LoaderStore(),
      getHistoryKey: () => "/",
      setHistoryKey: vi.fn(),
      getCachedSegments: (key: string) =>
        key === "/" ? { segments: onScreen, stale: false } : undefined,
      getSegmentState: () => ({
        path: "/",
        currentUrl: "http://localhost/",
        currentSegmentIds: onScreen.map((s) => s.id),
      }),
      getHistoryEntryMemory: () => undefined,
      setInterceptSourceUrl: vi.fn(),
      getInterceptSourceUrl: () => null,
      setSegmentIds: vi.fn(),
      updateCacheHandleData: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      cacheSegmentsForHistory: vi.fn(),
    };
  }

  async function commit(options: {
    onScreen: ResolvedSegment[];
    metadata: Record<string, unknown>;
    mode?: UpdateMode;
    tx?: Record<string, unknown>;
    fullyPrefetched?: boolean;
  }): Promise<Commit[]> {
    const { commits, onUpdate } = recorder();
    const updater = createPartialUpdater({
      store: store(options.onScreen) as any,
      client: {
        fetchPartial: vi.fn(async () => ({
          payload: { metadata: options.metadata },
          streamComplete: Promise.resolve(),
          fullyPrefetched: options.fullyPrefetched,
        })),
      } as any,
      onUpdate,
      renderSegments: vi.fn(async () => "tree"),
    });
    await updater(
      "http://localhost/next",
      undefined,
      false,
      undefined,
      {
        currentUrl: "http://localhost/",
        startStreaming: () => ({ end: vi.fn() }),
        commit: () => ({ scroll: { enabled: undefined } }),
        ...options.tx,
      } as any,
      options.mode,
    );
    return commits;
  }

  const partial = (segments: ResolvedSegment[], matched = ["R0"]) => ({
    isPartial: true,
    segments,
    matched,
    diff: segments.map((s) => s.id),
  });

  it.each([
    ["push", {}, ["push", "navigation"]],
    ["replace", { replace: true }, ["replace", "navigation"]],
    [
      "a back/forward that refetches",
      { traversal: true },
      ["pop", "navigation"],
    ],
  ])("a %s with transition()", async (_label, tx, types) => {
    expect(
      await commit({
        onScreen: [withTransition("R0")],
        metadata: partial([withTransition("R0", { component: "next" })]),
        tx,
      }),
    ).toEqual([types]);
  });

  it("router.refresh() with transition() is revalidate", async () => {
    expect(
      await commit({
        onScreen: [withTransition("R0")],
        metadata: partial([withTransition("R0", { component: "next" })]),
        mode: { type: "navigate", refresh: true },
      }),
    ).toEqual([["revalidate", "navigation"]]);
  });

  it("the same-structure content hold (a search change) carries its kind alone", async () => {
    expect(
      await commit({
        onScreen: [seg("R0")],
        metadata: partial([seg("R0", { component: "next" })]),
      }),
    ).toEqual([["push"]]);
  });

  it("a fully prefetched click that mounts a new segment carries its kind alone", async () => {
    expect(
      await commit({
        onScreen: [seg("L0", { type: "layout" })],
        metadata: partial([seg("L0R1")], ["L0", "L0R1"]),
        fullyPrefetched: true,
      }),
    ).toEqual([["push"]]);
  });

  it("a fully prefetched intercept carries its kind alone", async () => {
    expect(
      await commit({
        onScreen: [withTransition("L0", { type: "layout" }), seg("L0R0")],
        metadata: {
          ...partial(
            [seg("M0", { namespace: "intercept:@modal", type: "parallel" })],
            ["L0", "L0R0", "M0"],
          ),
          slots: { "@modal": { active: true } },
        },
        fullyPrefetched: true,
      }),
    ).toEqual([["push"]]);
  });

  it("an optimistic clientUrls() presentation keeps rango-optimistic-commit after its kind", async () => {
    expect(
      await commit({
        onScreen: [seg("L0", { type: "layout" })],
        metadata: partial([seg("L0R1")], ["L0", "L0R1"]),
        mode: { type: "navigate", presentation: { clear: vi.fn() } },
        tx: { replace: true },
      }),
    ).toEqual([["replace", "rango-optimistic-commit"]]);
  });

  it("a history-cache render with no diff and transition()", async () => {
    expect(
      await commit({
        onScreen: [seg("R0")],
        metadata: { isPartial: true, segments: [], matched: ["R0"], diff: [] },
        mode: { type: "navigate", targetCacheSegments: [withTransition("R0")] },
      }),
    ).toEqual([["push", "navigation"]]);
  });

  it.each([
    ["with transition()", withTransition, ["revalidate", "action"]],
    ["without transition()", seg, ["revalidate"]],
  ])("a stale revalidation %s is revalidate", async (_label, make, types) => {
    expect(
      await commit({
        onScreen: [make("R0")],
        metadata: partial([make("R0", { component: "next" })]),
        mode: { type: "stale-revalidation" },
        tx: { replace: true },
      }),
    ).toEqual([types]);
  });

  it.each([
    ["with transition()", withTransition],
    ["without transition()", seg],
  ])("an action refetch %s is action", async (_label, make) => {
    expect(
      await commit({
        onScreen: [make("R0")],
        metadata: partial([make("R0", { component: "next" })]),
        mode: { type: "action" },
      }),
    ).toEqual([["action"]]);
  });

  it.each([
    [
      "navigation",
      undefined,
      { replace: undefined },
      ["push", "navigation"] as Commit,
    ],
    [
      "stale revalidation",
      { type: "stale-revalidation" } as UpdateMode,
      { replace: true },
      ["revalidate", "action"] as Commit,
    ],
    ["action", { type: "action" } as UpdateMode, {}, ["action"] as Commit],
  ])(
    "the full-update fallback: a %s with transition()",
    async (_label, mode, tx, types) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(
        await commit({
          onScreen: [withTransition("R0")],
          metadata: { isPartial: false, segments: [withTransition("R0")] },
          mode,
          tx,
        }),
      ).toEqual([types]);
    },
  );

  it("urgent commits carry nothing: a cold click that mounts a new segment, and a gated-off one", async () => {
    expect(
      await commit({
        onScreen: [seg("L0", { type: "layout" })],
        metadata: partial([seg("L0R1")], ["L0", "L0R1"]),
      }),
    ).toEqual(["urgent"]);
    expect(
      await commit({
        onScreen: [withTransition("R0")],
        metadata: partial([withTransition("R0", { component: "next" })]),
        tx: { transitionGatedOff: true },
      }),
    ).toEqual(["urgent"]);
  });
});

// React flushes a transition started in the popstate event synchronously,
// with non-transition lanes: no view transition starts and its types would
// stay queued for the next transition commit. It keeps navigation-back alone.
describe("navigation-bridge: a back/forward restored from the history cache", () => {
  it.each([
    ["with transition() adds no kind", withTransition, ["navigation-back"]],
    ["without transition() commits urgently", seg, "urgent"],
  ])("%s", async (_label, make, commit) => {
    vi.stubGlobal("window", {
      location: { href: "http://localhost/a", origin: "http://localhost" },
      history: { state: { key: "entry-a" } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const { commits, onUpdate } = recorder();
    const store = {
      getHistoryKey: vi.fn(() => "/b"),
      setHistoryKey: vi.fn(),
      setSegmentIds: vi.fn(),
      setCurrentUrl: vi.fn(),
      setPath: vi.fn(),
      getSegmentState: vi.fn(() => ({
        path: "/b",
        currentUrl: "http://localhost/b",
        currentSegmentIds: ["R0"],
      })),
      getCachedSegments: vi.fn(() => ({
        segments: [make("R0")],
        stale: false,
      })),
      getHistoryEntryMemory: vi.fn(() => undefined),
      rememberDisplayedEntry: vi.fn(),
      getInterceptSourceUrl: vi.fn(() => null),
      setInterceptSourceUrl: vi.fn(),
    };
    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: {
        abortNavigation: vi.fn(),
        abortAllActions: vi.fn(),
        setLocation: vi.fn(),
        setParams: vi.fn(),
        commitLocationState: vi.fn(),
        getState: vi.fn(() => ({ isStreaming: false })),
      } as any,
      onUpdate,
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.handlePopstate();

    expect(commits).toEqual([commit]);
  });
});

describe("server-action-bridge: the action commit is action", () => {
  function setup(payload: unknown, cached: ResolvedSegment[]) {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/items/1",
        pathname: "/items/1",
        origin: "http://localhost",
      },
      history: { state: { key: "k1" }, replaceState: vi.fn() },
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const { commits, onUpdate } = recorder();
    const setServerCallback = vi.fn();
    createServerActionBridge({
      store: {
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
        getHistoryEntryMemory: vi.fn(() => undefined),
        markCacheAsStaleAndBroadcast: vi.fn(),
        getInterceptSourceUrl: vi.fn(() => null),
        getRouterId: vi.fn(() => undefined),
      } as any,
      client: {} as any,
      eventController: createEventController(),
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async () => payload),
        setServerCallback,
      } as any,
      onUpdate,
      renderSegments: vi.fn(async () => "tree"),
    }).register();
    const callback = setServerCallback.mock.calls[0]![0] as (
      id: string,
      args: unknown[],
    ) => Promise<unknown>;
    return { callback, commits };
  }

  it.each([
    ["with transition()", withTransition],
    ["without transition()", seg],
  ])("the revalidation commit %s", async (_label, make) => {
    const { callback, commits } = setup(
      {
        metadata: {
          pathname: "/items/1",
          segments: [make("R0", { component: "next" })],
          matched: ["R0"],
          diff: ["R0"],
          isPartial: true,
        },
        returnValue: { ok: true, data: 1 },
      },
      [make("R0")],
    );
    await callback("hash#save", []);
    expect(commits).toEqual([["action"]]);
  });

  it("the error-boundary commit of a failed action", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("nope");
    const { callback, commits } = setup(
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
      [seg("L0", { type: "layout" }), seg("L0R0")],
    );
    await expect(callback("hash#save", [])).rejects.toBe(failure);
    expect(commits).toEqual([["action"]]);
  });

  it("a gated-off action commit is urgent and carries nothing", async () => {
    const when = vi.fn(() => false);
    const { callback, commits } = setup(
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
    expect(commits).toEqual(["urgent"]);
  });
});
