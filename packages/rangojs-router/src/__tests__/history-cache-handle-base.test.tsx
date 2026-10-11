// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandle } from "../handle.js";
import { pushedByKey } from "../handles/pushed-by.js";
import { createEventController } from "../browser/event-controller.js";
import { createNavigationBridge } from "../browser/navigation-bridge.js";
import {
  createNavigationStore,
  generateHistoryKey,
} from "../browser/navigation-store.js";
import { NavigationProvider } from "../browser/react/NavigationProvider.js";
import { useHandle } from "../browser/react/use-handle.js";
import type { HandleData } from "../server/handle-store.js";
import type {
  NavigationClient,
  ResolvedSegment,
  RscMetadata,
} from "../browser/types.js";

vi.mock("../browser/scroll-restoration.js", () => ({
  handleNavigationStart: vi.fn(),
  handleNavigationEnd: vi.fn(),
  handleTraversalStart: vi.fn(),
  ensureHistoryKey: vi.fn(),
  getHistoryStateKey: vi.fn(() => "entry-key"),
}));

/**
 * A link navigation to a URL the history cache holds sends the entry's segment
 * ids; the server re-renders only what revalidates, and the page is the
 * entry's segments plus the response's. Its handles must be the entry's
 * pushes plus the response's, whether or not the response re-rendered
 * anything. The real store, event controller, bridge, partial updater and
 * NavigationProvider; only the server's answer is faked.
 *
 * A section layout (M0L0) holds two pages: A (M0L0R0), and B (M0L0L1R0) under
 * its own layout (M0L0L1), with a loader (tick) that reruns on every visit.
 */

const Crumbs = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_history_cache_crumbs__",
);
const Title = createHandle<string, string | undefined>(
  (segments) => segments.flat().at(-1),
  "__test_history_cache_title__",
);

const A = "/history/a";
const B = "/history/b";
const url = (path: string): string =>
  new URL(path, window.location.origin).href;

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

const sectionSeg = (): ResolvedSegment =>
  seg("M0L0", { type: "layout", component: "section" });
const aSegments = (): ResolvedSegment[] => [sectionSeg(), seg("M0L0R0")];
const tickSeg = (runs: number): ResolvedSegment =>
  seg("M0L0L1R0D0.tick", {
    type: "loader",
    component: null,
    loaderId: "tick",
    loaderData: { runs },
  });
const bSegments = (): ResolvedSegment[] => [
  sectionSeg(),
  seg("M0L0L1", { type: "layout" }),
  seg("M0L0L1R0"),
  tickSeg(1),
];
const bMatched = bSegments().map((s) => s.id);

const aHandles = (section: string): HandleData => ({
  [Crumbs.$$id]: { M0L0: [section], M0L0R0: ["a-page"] },
  [Title.$$id]: { M0L0R0: ["A"] },
});

/** B's entry as its first visit left it in the history cache. */
const bHandles = (section: string): HandleData => ({
  [Crumbs.$$id]: {
    M0L0: [section],
    M0L0L1: ["b-layout"],
    M0L0L1R0: ["b-page", "tick:1"],
  },
  [pushedByKey(Crumbs.$$id)]: { M0L0L1R0: [null, "tick"] },
  [Title.$$id]: { M0L0L1R0: ["B"] },
});

/** A partial response's handle stream: one yield per snapshot. */
async function* stream(...snapshots: HandleData[]): AsyncGenerator<HandleData> {
  for (const snapshot of snapshots) yield snapshot;
}

/**
 * The server's answer to B: only what revalidated, with its pushes. Every
 * partial response carries a handle stream (rsc-rendering.ts); one where no
 * run pushed ends without a yield.
 */
function answer(
  diff: string[],
  segments: ResolvedSegment[],
  ...snapshots: HandleData[]
): { payload: { metadata: RscMetadata }; streamComplete: Promise<void> } {
  return {
    payload: {
      metadata: {
        pathname: B,
        isPartial: true,
        matched: bMatched,
        diff,
        segments,
        resolvedIds: diff,
        params: {},
        handles: stream(...snapshots),
      } as RscMetadata,
    },
    streamComplete: Promise.resolve(),
  };
}

let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    root = undefined;
    await act(async () => current.unmount());
  }
  cleanup();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

function View(): ReactNode {
  const crumbs = useHandle(Crumbs);
  const title = useHandle(Title);
  return (
    <p>
      {crumbs.join(" > ")} | {title ?? "(no title)"}
    </p>
  );
}

/**
 * Page A on screen, its section layout pushing `onScreen`; B's entry cached
 * from its first visit, its section layout having pushed `cachedSection`.
 */
async function setup(
  respond: () => ReturnType<typeof answer>,
  section: { onScreen: string; cached: string },
) {
  window.history.replaceState(null, "", A);
  const store = createNavigationStore({
    initialLocation: { href: url(A) },
    initialHistoryKey: generateHistoryKey(url(A)),
    initialSegments: aSegments(),
    initialSegmentIds: aSegments().map((s) => s.id),
    crossTabSync: false,
  });
  store.updateCacheHandleData(
    generateHistoryKey(url(A)),
    aHandles(section.onScreen),
  );
  store.cacheSegmentsForHistory(
    generateHistoryKey(url(B)),
    bSegments(),
    bHandles(section.cached),
  );
  const eventController = createEventController({
    initialLocation: new URL(url(A)),
  });
  eventController.setHandleData(
    aHandles(section.onScreen),
    aSegments().map((s) => s.id),
  );
  const fetchPartial = vi.fn(async () => respond());
  const bridge = createNavigationBridge({
    store,
    client: { fetchPartial } as unknown as NavigationClient,
    eventController,
    onUpdate: (update) => store.emitUpdate(update),
    renderSegments: async () => <View />,
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <NavigationProvider
        store={store}
        eventController={eventController}
        bridge={bridge}
        initialPayload={{
          root: <View />,
          metadata: {
            pathname: A,
            segments: aSegments(),
            matched: aSegments().map((s) => s.id),
            params: {},
          } as RscMetadata,
        }}
      />,
    );
  });
  expect(container.textContent).toBe(`${section.onScreen} > a-page | A`);
  return { store, bridge, container, fetchPartial };
}

describe("a link navigation to a page the history cache holds", () => {
  it("keeps the cached page's pushes when the response re-renders part of it", async () => {
    const { bridge, container, fetchPartial } = await setup(
      () =>
        answer(["M0L0L1R0D0.tick"], [tickSeg(2)], {
          [Crumbs.$$id]: { M0L0L1R0: ["tick:2"] },
          [pushedByKey(Crumbs.$$id)]: { M0L0L1R0: ["tick"] },
        }),
      { onScreen: "section", cached: "section" },
    );

    await act(async () => {
      await bridge.navigate(B);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The navigation was answered from the entry: its ids went to the server.
    expect(fetchPartial).toHaveBeenCalledWith(
      expect.objectContaining({ segmentIds: bMatched }),
    );
    expect(container.textContent).toBe(
      "section > b-layout > b-page > tick:2 | B",
    );
  });

  it("keeps the cached page's pushes when the rerun pushes nothing", async () => {
    const { bridge, container } = await setup(
      () => answer(["M0L0L1R0D0.tick"], [tickSeg(2)]),
      { onScreen: "section", cached: "section" },
    );

    await act(async () => {
      await bridge.navigate(B);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The tick loader re-ran and pushed nothing: its crumb goes, the rest of
    // the entry's stays.
    expect(container.textContent).toBe("section > b-layout > b-page | B");
  });

  // The bridge renders a segment the page on screen shares with the entry
  // from the page on screen (it can be the fresher one). Its pushes come
  // from the same place, with or without a response that re-renders.
  it("takes a shared segment's pushes from the page on screen, as it takes the segment", async () => {
    const { bridge, container } = await setup(
      () =>
        answer(["M0L0L1R0D0.tick"], [tickSeg(2)], {
          [Crumbs.$$id]: { M0L0L1R0: ["tick:2"] },
          [pushedByKey(Crumbs.$$id)]: { M0L0L1R0: ["tick"] },
        }),
      { onScreen: "section:2", cached: "section:1" },
    );

    await act(async () => {
      await bridge.navigate(B);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toBe(
      "section:2 > b-layout > b-page > tick:2 | B",
    );
  });

  it("takes a shared segment's pushes from the page on screen when nothing re-renders", async () => {
    const { bridge, container } = await setup(() => answer([], []), {
      onScreen: "section:2",
      cached: "section:1",
    });

    await act(async () => {
      await bridge.navigate(B);
    });

    expect(container.textContent).toBe(
      "section:2 > b-layout > b-page > tick:1 | B",
    );
  });
});
