import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSegment } from "../browser/types";

/**
 * A navigation that is left after it sent its request ignores the response;
 * it never cancels it. Aborting a Flight body mid-read errors every chunk a
 * mounted tree may be reading, so the body streams to its end and nothing of
 * it reaches the page, the history, the stores, the scroll position or
 * useNavigation() (docs/design/prefetch-false.md, R9). The same holds for
 * every navigation, with or without `prefetch: false`.
 *
 * The real store, event controller, transaction and partial updater; the
 * server is the `fetchPartial` below.
 */

const { handleNavigationEnd } = vi.hoisted(() => ({
  handleNavigationEnd: vi.fn(),
}));

vi.mock("../browser/scroll-restoration.js", () => ({
  handleNavigationStart: vi.fn(),
  handleNavigationEnd,
  handleTraversalStart: vi.fn(),
  ensureHistoryKey: vi.fn(),
  getHistoryStateKey: vi.fn(() => "entry-key"),
}));

import { createEventController } from "../browser/event-controller";
import { createNavigationBridge } from "../browser/navigation-bridge";
import {
  createNavigationStore,
  generateHistoryKey,
} from "../browser/navigation-store";

const HUB = "http://localhost/hub";
const LEFT = "http://localhost/left";
const NEXT = "http://localhost/next";

function seg(id: string): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type: "route",
    component: `component-${id}`,
  } as ResolvedSegment;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The page `url` as a server answers it: one new route segment. */
function answer(url: string, streamComplete: Promise<void>) {
  const id = `R${new URL(url).pathname.slice(1)}`;
  return {
    payload: {
      metadata: {
        isPartial: true,
        pathname: new URL(url).pathname,
        segments: [seg(id)],
        matched: ["L0", id],
        diff: [id],
      },
    },
    streamComplete,
  };
}

/**
 * On HUB, with the address bar at `location` (a back/forward has moved it
 * already). The response for LEFT arrives when the test says, and its body
 * never ends; its tree is built when the test says. Every other page is
 * answered at once, its body complete.
 */
function setup(location = HUB) {
  let historyState: unknown = { key: "entry", idx: 1 };
  const pushState = vi.fn((state: unknown, _unused: string, _url: string) => {
    historyState = state;
  });
  vi.stubGlobal("window", {
    location: { href: location, origin: "http://localhost" },
    history: {
      get state() {
        return historyState;
      },
      replaceState: vi.fn((state: unknown) => {
        historyState = state;
      }),
      pushState,
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  const store = createNavigationStore({
    initialLocation: { href: HUB },
    initialHistoryKey: generateHistoryKey(HUB),
    initialSegments: [seg("L0")],
    initialSegmentIds: ["L0"],
    crossTabSync: false,
  });
  store.cacheSegmentsForHistory(generateHistoryKey(HUB), [seg("L0")]);
  const eventController = createEventController({
    initialLocation: new URL(HUB),
  });
  const leftResponse = deferred<void>();
  const leftTree = deferred<string>();
  const requests: { targetUrl: string; signal?: AbortSignal }[] = [];
  const fetchPartial = vi.fn(
    async (options: { targetUrl: string; signal?: AbortSignal }) => {
      requests.push(options);
      if (options.targetUrl !== LEFT) {
        return answer(options.targetUrl, Promise.resolve());
      }
      await leftResponse.promise;
      return answer(LEFT, new Promise<void>(() => {}));
    },
  );
  const renderSegments = vi.fn(async (segments: ResolvedSegment[]) =>
    segments.some((s) => s.id === "Rleft")
      ? leftTree.promise
      : `tree:${segments.map((s) => s.id).join(",")}`,
  );
  const onUpdate = vi.fn();
  const bridge = createNavigationBridge({
    store,
    client: { fetchPartial } as any,
    eventController,
    onUpdate,
    renderSegments,
  });
  const consoleError = vi.spyOn(console, "error");
  const consoleWarn = vi.spyOn(console, "warn");
  return {
    store,
    eventController,
    bridge,
    requests,
    renderSegments,
    onUpdate,
    pushState,
    consoleError,
    consoleWarn,
    leftResponse,
    leftTree,
  };
}

/** Nothing of LEFT's response reached the page, history or the stores. */
function expectLeftIgnored(page: ReturnType<typeof setup>) {
  const leftId = "Rleft";
  for (const [update] of page.onUpdate.mock.calls) {
    expect(
      update.metadata.segments?.some((s: ResolvedSegment) => s.id === leftId),
    ).not.toBe(true);
  }
  expect(
    page.store.getCachedSegments(generateHistoryKey(LEFT)),
  ).toBeUndefined();
  expect(page.store.getSegmentState().currentSegmentIds).not.toContain(leftId);
  expect(
    page.pushState.mock.calls.filter(([, , url]) => String(url) === LEFT),
  ).toHaveLength(0);
  // The body is never cancelled: the navigation's request carries no signal.
  expect(
    page.requests.filter((r) => r.targetUrl === LEFT).map((r) => r.signal),
  ).toEqual([undefined]);
  expect(page.consoleError).not.toHaveBeenCalled();
  expect(page.consoleWarn).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  handleNavigationEnd.mockClear();
});

describe("a navigation left after its response arrived", () => {
  it("a click: superseded while its tree is built, nothing of it lands", async () => {
    const page = setup();
    const left = page.bridge.navigate(LEFT);
    page.leftResponse.resolve();
    await flush();
    expect(page.renderSegments).toHaveBeenCalledTimes(1);

    await page.bridge.navigate(NEXT);
    page.leftTree.resolve("tree:left");
    await left;
    await flush();

    expectLeftIgnored(page);
    expect(page.onUpdate).toHaveBeenCalledTimes(1);
    expect(page.store.getSegmentState().currentUrl).toBe(NEXT);
    const state = page.eventController.getState();
    expect(state.state).toBe("idle");
    expect(
      state.isStreaming,
      "the left response still streams; nobody waits on it",
    ).toBe(false);
    expect(state.location.href).toBe(NEXT);
  });

  it("a click: superseded before its response, which arrives later and is ignored", async () => {
    const page = setup();
    const left = page.bridge.navigate(LEFT);
    await flush();

    await page.bridge.navigate(NEXT);
    page.leftResponse.resolve();
    await left;
    await flush();

    expectLeftIgnored(page);
    expect(page.onUpdate).toHaveBeenCalledTimes(1);
    expect(page.eventController.getState().isStreaming).toBe(false);
  });

  it("a back/forward: superseded, it restores no scroll position", async () => {
    const page = setup(LEFT);
    const traversal = page.bridge.handlePopstate();
    await flush();
    expect(page.requests).toHaveLength(1);

    await page.bridge.navigate(NEXT);
    page.leftResponse.resolve();
    await traversal;
    await flush();

    expectLeftIgnored(page);
    expect(handleNavigationEnd).not.toHaveBeenCalled();
    expect(page.onUpdate).toHaveBeenCalledTimes(1);
    expect(page.eventController.getState().isStreaming).toBe(false);
  });

  it("the stale entry's revalidation on back/forward: superseded, the entry stays as it was", async () => {
    const page = setup(LEFT);
    // The revalidation answers with Rleft, whose tree the test builds.
    const entry = [seg("L0"), seg("Rold")];
    page.store.cacheSegmentsForHistory(generateHistoryKey(LEFT), entry);
    page.store.markHistoryCacheStale();
    await page.bridge.handlePopstate();
    // The entry is shown at once; its revalidation is in flight.
    expect(page.onUpdate).toHaveBeenCalledTimes(1);
    page.leftResponse.resolve();
    await flush();
    expect(page.renderSegments).toHaveBeenCalledTimes(2);

    await page.bridge.navigate(NEXT);
    page.leftTree.resolve("tree:left");
    await flush();

    const cached = page.store.getCachedSegments(generateHistoryKey(LEFT))!;
    expect(cached.segments).toEqual(entry);
    expect(cached.stale).toBe(true);
    // The restore and the click: the revalidation committed nothing.
    expect(page.onUpdate).toHaveBeenCalledTimes(2);
    expect(page.consoleError).not.toHaveBeenCalled();
    expect(page.eventController.getState().isStreaming).toBe(false);
  });
});
