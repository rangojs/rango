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
 * anything; a segment the bridge takes from the page on screen brings that
 * page's pushes as they are at the commit. The real store, event controller,
 * bridge, partial updater and NavigationProvider; only the server's answer is
 * faked.
 *
 * A section layout (M0L0, with a loader `sec`) holds two pages: A (M0L0R0),
 * and B (M0L0L1R0) under its own layout (M0L0L1), with a loader (`tick`)
 * that reruns on every visit.
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

const loaderSeg = (id: string, loaderId: string, runs: number) =>
  seg(id, { type: "loader", component: null, loaderId, loaderData: { runs } });
const sectionSegs = (): ResolvedSegment[] => [
  seg("M0L0", { type: "layout", component: "section" }),
  loaderSeg("M0L0D0.sec", "sec", 1),
];
const aSegments = (): ResolvedSegment[] => [...sectionSegs(), seg("M0L0R0")];
const tickSeg = (runs: number): ResolvedSegment =>
  loaderSeg("M0L0L1R0D0.tick", "tick", runs);
const bSegments = (): ResolvedSegment[] => [
  ...sectionSegs(),
  seg("M0L0L1", { type: "layout" }),
  seg("M0L0L1R0"),
  tickSeg(1),
];
const aMatched = aSegments().map((s) => s.id);
const bMatched = bSegments().map((s) => s.id);

/** The section layout's crumb bucket: its values and who pushed each. */
interface Section {
  values: string[];
  by?: (string | null)[];
}
const section = (...values: string[]): Section => ({ values });

const aHandles = (sec: Section): HandleData => ({
  [Crumbs.$$id]: { M0L0: sec.values, M0L0R0: ["a-page"] },
  ...(sec.by && { [pushedByKey(Crumbs.$$id)]: { M0L0: sec.by } }),
  [Title.$$id]: { M0L0R0: ["A"] },
});

/** B's entry as its first visit left it in the history cache. */
const bHandles = (sec: Section): HandleData => ({
  [Crumbs.$$id]: {
    M0L0: sec.values,
    M0L0L1: ["b-layout"],
    M0L0L1R0: ["b-page", "tick:1"],
  },
  [pushedByKey(Crumbs.$$id)]: {
    ...(sec.by && { M0L0: sec.by }),
    M0L0L1R0: [null, "tick"],
  },
  [Title.$$id]: { M0L0L1R0: ["B"] },
});

const tickPush = (runs: number): HandleData => ({
  [Crumbs.$$id]: { M0L0L1R0: [`tick:${runs}`] },
  [pushedByKey(Crumbs.$$id)]: { M0L0L1R0: ["tick"] },
});

/** A partial response's handle stream: one yield per snapshot. */
async function* stream(...snapshots: HandleData[]): AsyncGenerator<HandleData> {
  for (const snapshot of snapshots) yield snapshot;
}

/** A handle stream that yields `snapshot` once `gate` resolves. */
async function* heldStream(
  gate: Promise<void>,
  snapshot: HandleData,
): AsyncGenerator<HandleData> {
  await gate;
  yield snapshot;
}

type Answer = {
  payload: { metadata: RscMetadata };
  streamComplete: Promise<void>;
};

/**
 * The server's answer to B (or A): only what revalidated, with its pushes.
 * Every partial response carries a handle stream (rsc-rendering.ts); one where
 * no run pushed ends without a yield.
 */
function answer(
  diff: string[],
  segments: ResolvedSegment[],
  handles: AsyncGenerator<HandleData> = stream(),
  page: typeof A | typeof B = B,
): Answer {
  return {
    payload: {
      metadata: {
        pathname: page,
        isPartial: true,
        matched: page === B ? bMatched : aMatched,
        diff,
        segments,
        resolvedIds: diff,
        params: {},
        handles,
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

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/**
 * The screen once the handle stream has landed: handle readers are notified
 * on a timer (event-controller.ts makeDebouncedNotifier), so poll.
 */
const expectScreen = (container: HTMLElement, text: string) =>
  vi.waitFor(async () => {
    await settle();
    expect(container.textContent).toBe(text);
  });

const aKey = () => generateHistoryKey(url(A));
const bKey = () => generateHistoryKey(url(B));
const crumbsIn = (
  store: {
    getCachedSegments(key: string): { handleData?: HandleData } | undefined;
  },
  key: string,
) => store.getCachedSegments(key)?.handleData?.[Crumbs.$$id];

/** Back or Forward to `path`, restored from the history cache. */
async function traverseTo(
  bridge: { handlePopstate(): Promise<void> },
  path: string,
) {
  window.history.replaceState(null, "", path);
  await act(async () => {
    await bridge.handlePopstate();
  });
  await settle();
}

/**
 * Page A on screen, its section bucket `onScreen`; B's entry cached from its
 * first visit, with the section bucket `cached`.
 */
async function setup(
  respond: () => Answer | Promise<Answer>,
  sections: { onScreen: Section; cached: Section },
) {
  window.history.replaceState(null, "", A);
  const store = createNavigationStore({
    initialLocation: { href: url(A) },
    initialHistoryKey: generateHistoryKey(url(A)),
    initialSegments: aSegments(),
    initialSegmentIds: aMatched,
    crossTabSync: false,
  });
  store.updateCacheHandleData(
    generateHistoryKey(url(A)),
    aHandles(sections.onScreen),
  );
  store.cacheSegmentsForHistory(
    generateHistoryKey(url(B)),
    bSegments(),
    bHandles(sections.cached),
  );
  const eventController = createEventController({
    initialLocation: new URL(url(A)),
  });
  eventController.setHandleData(aHandles(sections.onScreen), aMatched);
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
            matched: aMatched,
            params: {},
          } as RscMetadata,
        }}
      />,
    );
  });
  expect(container.textContent).toBe(
    `${sections.onScreen.values.join(" > ")} > a-page | A`,
  );
  return { store, eventController, bridge, container, fetchPartial };
}

describe("a link navigation to a page the history cache holds", () => {
  it("keeps the cached page's pushes when the response re-renders part of it", async () => {
    const { bridge, container, fetchPartial } = await setup(
      () => answer(["M0L0L1R0D0.tick"], [tickSeg(2)], stream(tickPush(2))),
      { onScreen: section("section"), cached: section("section") },
    );

    await act(async () => {
      await bridge.navigate(B);
    });

    // The navigation was answered from the entry: its ids went to the server.
    expect(fetchPartial).toHaveBeenCalledWith(
      expect.objectContaining({ segmentIds: bMatched }),
    );
    await expectScreen(container, "section > b-layout > b-page > tick:2 | B");
  });

  it("keeps the cached page's pushes when the rerun pushes nothing", async () => {
    const { bridge, container } = await setup(
      () => answer(["M0L0L1R0D0.tick"], [tickSeg(2)]),
      { onScreen: section("section"), cached: section("section") },
    );

    await act(async () => {
      await bridge.navigate(B);
    });

    // The tick loader re-ran and pushed nothing: its crumb goes, the rest of
    // the entry's stays.
    await expectScreen(container, "section > b-layout > b-page | B");
  });

  // The bridge renders a segment the page on screen shares with the entry
  // from the page on screen (it can be the fresher one). Its pushes come
  // from the same place, with the record of who pushed them: here the
  // section's loader re-runs, and only its push is replaced.
  it("takes a shared segment's pushes from the page on screen, as it takes the segment", async () => {
    const { bridge, container } = await setup(
      () =>
        answer(
          ["M0L0D0.sec", "M0L0L1R0D0.tick"],
          [loaderSeg("M0L0D0.sec", "sec", 3), tickSeg(2)],
          stream({
            [Crumbs.$$id]: { M0L0: ["sec:3"], M0L0L1R0: ["tick:2"] },
            [pushedByKey(Crumbs.$$id)]: {
              M0L0: ["sec"],
              M0L0L1R0: ["tick"],
            },
          }),
        ),
      {
        onScreen: { values: ["section:2", "sec:2"], by: [null, "sec"] },
        cached: section("section:1"),
      },
    );

    await act(async () => {
      await bridge.navigate(B);
    });

    await expectScreen(
      container,
      "section:2 > sec:3 > b-layout > b-page > tick:2 | B",
    );
  });

  it("takes a shared segment's pushes from the page on screen when nothing re-renders", async () => {
    const { bridge, container } = await setup(() => answer([], []), {
      onScreen: section("section:2"),
      cached: section("section:1"),
    });

    await act(async () => {
      await bridge.navigate(B);
    });

    expect(container.textContent).toBe(
      "section:2 > b-layout > b-page > tick:1 | B",
    );
  });

  it("takes a shared segment's pushes as the page on screen has them at the commit", async () => {
    let release!: (value: Answer) => void;
    const { bridge, eventController, container, fetchPartial } = await setup(
      () => new Promise<Answer>((resolve) => (release = resolve)),
      { onScreen: section("section"), cached: section("section") },
    );

    let navigation!: Promise<void>;
    await act(async () => {
      navigation = bridge.navigate(B);
    });
    expect(fetchPartial).toHaveBeenCalledTimes(1);

    // A push on the page on screen while the request is in flight.
    await act(async () => {
      eventController.setHandleData(
        aHandles(section("section:late")),
        aMatched,
      );
    });
    await act(async () => {
      release(answer(["M0L0L1R0D0.tick"], [tickSeg(2)], stream(tickPush(2))));
      await navigation;
    });

    await expectScreen(
      container,
      "section:late > b-layout > b-page > tick:2 | B",
    );
  });

  it("records the entry's pushes in its history entry at the commit, before the response's handles arrive", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { bridge, store, container } = await setup(
      () =>
        answer(
          ["M0L0L1R0D0.tick"],
          [tickSeg(2)],
          heldStream(gate, tickPush(2)),
        ),
      { onScreen: section("section"), cached: section("section") },
    );

    await act(async () => {
      await bridge.navigate(B);
    });

    // Back now, then Forward, restores B from this entry.
    expect(crumbsIn(store, bKey())).toEqual({
      M0L0: ["section"],
      M0L0L1: ["b-layout"],
      M0L0L1R0: ["b-page", "tick:1"],
    });
    expect(container.textContent).toBe(
      "section > b-layout > b-page > tick:1 | B",
    );

    open();
    await expectScreen(container, "section > b-layout > b-page > tick:2 | B");
  });

  it("records the entry's pushes in its history entry when nothing re-renders, for Back and Forward", async () => {
    const { bridge, store, container } = await setup(() => answer([], []), {
      onScreen: section("section:2"),
      cached: section("section:1"),
    });

    await act(async () => {
      await bridge.navigate(B);
    });
    expect(crumbsIn(store, bKey())).toEqual({
      M0L0: ["section:2"],
      M0L0L1: ["b-layout"],
      M0L0L1R0: ["b-page", "tick:1"],
    });

    await traverseTo(bridge, A);
    expect(container.textContent).toBe("section:2 > a-page | A");
    await traverseTo(bridge, B);
    expect(container.textContent).toBe(
      "section:2 > b-layout > b-page > tick:1 | B",
    );
  });

  // The document is still hydrating: the page on screen's live pushes are in
  // its history entry (rsc-router writes late pushes there), not in the
  // controller's snapshot.
  it("takes a shared segment's pushes from the document's entry while it hydrates", async () => {
    let release!: (value: Answer) => void;
    const { bridge, store, eventController } = await setup(
      () => new Promise<Answer>((resolve) => (release = resolve)),
      { onScreen: section("section"), cached: section("section") },
    );
    eventController.lockHydration();

    let navigation!: Promise<void>;
    await act(async () => {
      navigation = bridge.navigate(B);
    });
    // A late document push: queued in the controller, written to the entry.
    eventController.setHandleData(aHandles(section("section:late")), aMatched);
    store.updateCacheHandleData(aKey(), aHandles(section("section:late")));
    await act(async () => {
      release(
        answer(
          ["M0L0L1R0D0.tick"],
          [tickSeg(2)],
          heldStream(new Promise(() => {}), tickPush(2)),
        ),
      );
      await navigation;
    });

    expect(crumbsIn(store, bKey())).toEqual({
      M0L0: ["section:late"],
      M0L0L1: ["b-layout"],
      M0L0L1R0: ["b-page", "tick:1"],
    });
    eventController.releaseHydrationLock();
  });

  // A link to the page on screen's own URL while the document hydrates:
  // tx.commit() records the controller's snapshot in that same entry, so the
  // page's pushes are read before it.
  for (const variant of ["nothing re-renders", "its route re-renders"]) {
    it(`a link to the page on screen while it hydrates keeps a late document push (${variant})`, async () => {
      const reRenders = variant === "its route re-renders";
      const { bridge, store, eventController, container } = await setup(
        () =>
          reRenders
            ? answer(
                ["M0L0R0"],
                [seg("M0L0R0")],
                stream({
                  [Crumbs.$$id]: { M0L0R0: ["a-page:2"] },
                  [Title.$$id]: { M0L0R0: ["A"] },
                }),
                A,
              )
            : answer([], [], stream(), A),
        { onScreen: section("section"), cached: section("section") },
      );
      eventController.lockHydration();
      eventController.setHandleData(
        aHandles(section("section:late")),
        aMatched,
      );
      store.updateCacheHandleData(aKey(), aHandles(section("section:late")));
      // NavigationProvider ends the hydration window before the update of a
      // navigation committed during it.
      const emit = store.emitUpdate.bind(store);
      store.emitUpdate = (update) => {
        eventController.releaseHydrationLock();
        emit(update);
      };

      await act(async () => {
        await bridge.navigate(A);
      });

      await expectScreen(
        container,
        reRenders ? "section:late > a-page:2 | A" : "section:late > a-page | A",
      );
      expect(crumbsIn(store, aKey())?.M0L0).toEqual(["section:late"]);
    });
  }
});
