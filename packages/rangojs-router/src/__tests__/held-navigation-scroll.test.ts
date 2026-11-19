// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventController } from "../browser/event-controller";
import { createNavigationBridge } from "../browser/navigation-bridge";
import {
  createNavigationStore,
  generateHistoryKey,
} from "../browser/navigation-store";
import { initScrollRestoration } from "../browser/scroll-restoration";
import type {
  NavigationClient,
  NavigationUpdate,
  ResolvedSegment,
  RscMetadata,
} from "../browser/types";

/**
 * Pins today's behaviour: a forward navigation whose answer redraws nothing
 * (every segment held, an empty diff) commits with no tree, so no React commit
 * follows to run NavigationProvider's layout effect and the page keeps its
 * scroll position, whatever `scroll` says.
 *
 * The real store, event controller, transaction, partial updater and scroll
 * restoration; the server is the `fetchPartial` below.
 */

const PAGE = new URL("/products", window.location.origin).href;

function seg(id: string, type: ResolvedSegment["type"]): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type,
    component: `component-${id}`,
  } as ResolvedSegment;
}

const SEGMENTS = [seg("M0L0", "layout"), seg("M0L0R0", "route")];
const IDS = SEGMENTS.map((s) => s.id);

async function* noHandles(): AsyncGenerator<never> {}

/** The server's answer for a request that held every segment: no diff. */
function heldEverything(pathname: string) {
  return {
    payload: {
      metadata: {
        pathname,
        isPartial: true,
        matched: IDS,
        diff: [],
        segments: [],
        params: {},
        handles: noHandles(),
      } as unknown as RscMetadata,
    },
    streamComplete: Promise.resolve(),
  };
}

let disposeScroll: (() => void) | undefined;

beforeEach(() => {
  window.history.replaceState(null, "", PAGE);
  disposeScroll = initScrollRestoration();
});

afterEach(() => {
  disposeScroll?.();
  disposeScroll = undefined;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  window.scrollTo(0, 0);
  vi.restoreAllMocks();
});

function setup() {
  const store = createNavigationStore({
    initialLocation: { href: PAGE },
    initialHistoryKey: generateHistoryKey(PAGE),
    initialSegments: SEGMENTS,
    initialSegmentIds: IDS,
    crossTabSync: false,
  });
  const eventController = createEventController({
    initialLocation: new URL(PAGE),
  });
  const fetchPartial = vi.fn(async (options: { targetUrl: string }) =>
    heldEverything(new URL(options.targetUrl, window.location.origin).pathname),
  );
  const updates: NavigationUpdate[] = [];
  const renderSegments = vi.fn(async () => null);
  const bridge = createNavigationBridge({
    store,
    client: { fetchPartial } as unknown as NavigationClient,
    eventController,
    onUpdate: (update) => void updates.push(update),
    renderSegments,
  });
  return { bridge, store, fetchPartial, updates, renderSegments };
}

/**
 * The navigation held every segment and took the no-redraw path: no tree was
 * handed on.
 */
function expectNoRedraw(ctx: ReturnType<typeof setup>): void {
  expect(ctx.fetchPartial).toHaveBeenCalledOnce();
  expect(ctx.fetchPartial.mock.calls[0]![0]).toMatchObject({
    segmentIds: IDS,
  });
  expect(ctx.renderSegments).not.toHaveBeenCalled();
  expect(ctx.updates).toEqual([]);
}

describe("a navigation that redraws nothing does not scroll", () => {
  it("keeps the position on a link to the page on screen after an action marked its entry stale", async () => {
    const ctx = setup();
    ctx.store.markHistoryCacheStale();
    window.scrollTo(0, 600);
    expect(window.scrollY).toBe(600);

    await ctx.bridge.navigate(PAGE);

    expectNoRedraw(ctx);
    expect(window.location.href).toBe(PAGE);
    expect(window.scrollY).toBe(600);
  });

  it("keeps the position on a search-only change that holds every segment", async () => {
    const ctx = setup();
    window.scrollTo(0, 600);

    await ctx.bridge.navigate("/products?color=blue");

    expectNoRedraw(ctx);
    expect(window.location.href).toBe(`${PAGE}?color=blue`);
    expect(window.scrollY).toBe(600);
  });
});
