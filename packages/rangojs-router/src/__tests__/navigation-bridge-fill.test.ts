import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSegment } from "../browser/types";

/**
 * `prefetch: false` and history (docs/design/prefetch-false.md, "History" and
 * "Abort"). An entry the user left before its fill landed holds placeholders:
 * the bridge must fetch it, never restore it. And the bridge is who follows a
 * fill's redirect and commits the location state it carried.
 *
 * The real store and event controller; the partial updater is replaced, so
 * what the bridge asks of it is what is asserted.
 */

const { fetchPartialUpdateMock, createPartialUpdaterMock } = vi.hoisted(() => {
  const fetchPartialUpdateMock = vi.fn(async () => {});
  return {
    fetchPartialUpdateMock,
    createPartialUpdaterMock: vi.fn((_config: any) => fetchPartialUpdateMock),
  };
});

vi.mock("../browser/partial-update.js", async () => ({
  ...(await vi.importActual<object>("../browser/partial-update.js")),
  createPartialUpdater: createPartialUpdaterMock,
}));

vi.mock("../browser/scroll-restoration.js", () => ({
  handleNavigationStart: vi.fn(),
  handleNavigationEnd: vi.fn(),
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
import { cancelPendingFill, setPendingFill } from "../browser/pending-fill";

const HUB = "http://localhost/hub";
const PRODUCT = "http://localhost/product";

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

const filled = () => [
  seg("R1"),
  seg("R1D0.reviews", {
    type: "loader",
    component: null,
    loaderId: "reviews",
    loaderData: { reviews: 5 },
  }),
];

/** What an adoption caches while its fill is in flight. */
const withPlaceholder = () => [
  seg("R1"),
  seg("R1D0.reviews", {
    type: "loader",
    component: null,
    loaderId: "reviews",
    loaderData: new Promise(() => {}),
    deferred: true,
  }),
];

/** On HUB, with a history entry for PRODUCT holding `product`. */
function setup(product: ResolvedSegment[], location = HUB) {
  let historyState: unknown = { key: "entry", idx: 1 };
  vi.stubGlobal("window", {
    location: { href: location, origin: "http://localhost" },
    history: {
      get state() {
        return historyState;
      },
      replaceState: vi.fn((state: unknown) => {
        historyState = state;
      }),
      pushState: vi.fn((state: unknown) => {
        historyState = state;
      }),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  const store = createNavigationStore({
    initialLocation: { href: HUB },
    initialHistoryKey: generateHistoryKey(HUB),
    initialSegments: [seg("R0")],
    initialSegmentIds: ["R0"],
    crossTabSync: false,
  });
  store.cacheSegmentsForHistory(generateHistoryKey(PRODUCT), product);
  const eventController = createEventController({
    initialLocation: new URL(HUB),
  });
  const renderSegments = vi.fn(async () => "tree");
  const onUpdate = vi.fn();
  const bridge = createNavigationBridge({
    store,
    client: {} as any,
    eventController,
    onUpdate,
    renderSegments,
  });
  return { store, eventController, bridge, renderSegments, onUpdate };
}

afterEach(() => {
  cancelPendingFill();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchPartialUpdateMock.mockClear();
  createPartialUpdaterMock.mockClear();
});

describe("navigation-bridge: an entry left before its fill landed", () => {
  it("back/forward fetches it instead of restoring placeholders", async () => {
    const { bridge, renderSegments, onUpdate } = setup(
      withPlaceholder(),
      PRODUCT,
    );
    await bridge.handlePopstate();

    expect(renderSegments).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
    const [url, segmentIds, , , tx] = fetchPartialUpdateMock.mock
      .calls[0] as unknown as [string, unknown, unknown, unknown, any];
    expect(url).toBe(PRODUCT);
    // The page on screen's ids, not the entry's: nothing of it is reused.
    expect(segmentIds).toBeUndefined();
    expect(tx.traversal).toBe(true);
  });

  it("control: back/forward restores a filled entry from history", async () => {
    const { bridge, renderSegments, onUpdate } = setup(filled(), PRODUCT);
    await bridge.handlePopstate();

    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
    expect(renderSegments).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("navigate() does not offer it as the target's cached segments", async () => {
    const { bridge } = setup(withPlaceholder());
    await bridge.navigate(PRODUCT);

    const [, segmentIds, , , , mode] = fetchPartialUpdateMock.mock
      .calls[0] as unknown as [string, unknown, unknown, unknown, any, any];
    expect(segmentIds).toBeUndefined();
    expect(mode.targetCacheSegments).toBeUndefined();
  });

  it("control: navigate() offers a filled entry", async () => {
    const { bridge } = setup(filled());
    await bridge.navigate(PRODUCT);

    const [, segmentIds, , , , mode] = fetchPartialUpdateMock.mock
      .calls[0] as unknown as [string, unknown, unknown, unknown, any, any];
    expect(segmentIds).toEqual(["R1", "R1D0.reviews"]);
    expect(mode.targetCacheSegments).toHaveLength(2);
  });
});

describe("navigation-bridge: a fill in flight", () => {
  it("is cancelled by back/forward, before anything is restored", async () => {
    const { bridge } = setup(filled(), PRODUCT);
    const cancel = vi.fn();
    setPendingFill(cancel);
    await bridge.handlePopstate();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("is not cancelled by a navigation that has not committed", async () => {
    const { bridge } = setup(filled());
    const cancel = vi.fn();
    setPendingFill(cancel);
    // The updater mock never commits its transaction.
    await bridge.navigate(PRODUCT);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("navigation-bridge: what it gives a fill", () => {
  const hooks = () =>
    createPartialUpdaterMock.mock.calls[0][0].fill as {
      redirect(url: string, state?: Record<string, unknown>): void;
      locationState(state: Record<string, unknown>): void;
    };

  it("follows a redirect as a replace navigation that reuses nothing", async () => {
    setup(filled());
    hooks().redirect("http://localhost/login", { __rsc_ls_from: "product" });
    await vi.waitFor(() =>
      expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1),
    );

    const [url, segmentIds, , , tx] = fetchPartialUpdateMock.mock
      .calls[0] as unknown as [string, unknown, unknown, unknown, any];
    expect(url).toBe("http://localhost/login");
    expect(segmentIds).toEqual([]);
    expect(tx.replace).toBe(true);
    expect(tx.state).toEqual({ __rsc_ls_from: "product" });
  });

  it("merges the server's location state into the entry and commits it to the hooks", () => {
    const { eventController } = setup(filled());
    const before = eventController.getLocationState();
    hooks().locationState({ __rsc_ls_flash: { text: "saved" } });

    expect(window.history.state).toEqual({
      key: "entry",
      idx: 1,
      __rsc_ls_flash: { text: "saved" },
    });
    expect(eventController.getLocationState()).not.toBe(before);
  });
});
