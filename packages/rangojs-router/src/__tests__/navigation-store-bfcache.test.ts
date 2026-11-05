import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { createNavigationStore } from "../browser/navigation-store.js";
import { __resetActionFence } from "../browser/action-fence.js";
import {
  currentGeneration,
  currentPrefetchEpoch,
} from "../browser/prefetch/cache.js";
import {
  getRangoState,
  getRangoStateCookieName,
  initRangoState,
} from "../browser/rango-state.js";
import type { ResolvedSegment } from "../types.js";

/**
 * The page-lifecycle half of cross-tab invalidation: an open BroadcastChannel
 * keeps the document out of the bfcache, so the channel closes on pagehide and
 * reopens on pageshow. These tests fire the two events the browser fires and
 * read the channel the store holds, with the real prefetch and rango-state
 * modules in place: the marks they expose are what a restore must and must not
 * do.
 */

interface FakeChannel {
  name: string;
  onmessage: ((event: MessageEvent) => void) | null;
  closed: boolean;
  posted: unknown[];
}

interface FakeWindow {
  location: { href: string; pathname: string };
  listeners: Map<string, Array<(event: unknown) => void>>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  dispatch(type: string, event?: unknown): void;
}

function seg(id: string): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type: "route",
    component: `component-${id}`,
  } as ResolvedSegment;
}

describe("navigation-store BroadcastChannel page lifecycle", () => {
  let channels: FakeChannel[];
  let win: FakeWindow;
  let stubbedWindows: FakeWindow[];
  let refresh: Mock<() => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetActionFence();
    // A bound state, as rsc-router.tsx does before the store opens: with no
    // mirror an incoming value is always newer, and the soft branch below would
    // never run.
    initRangoState("v1", "rango-state_router");
    channels = [];
    stubbedWindows = [];
    refresh = vi.fn<() => void>();
    win = {
      location: { href: "http://localhost/products", pathname: "/products" },
      listeners: new Map(),
      addEventListener(type, listener) {
        const list = win.listeners.get(type) ?? [];
        list.push(listener);
        win.listeners.set(type, list);
      },
      removeEventListener(type, listener) {
        const list = win.listeners.get(type) ?? [];
        win.listeners.set(
          type,
          list.filter((entry) => entry !== listener),
        );
      },
      dispatch(type, event) {
        for (const listener of win.listeners.get(type) ?? []) listener(event);
      },
    };
    stubbedWindows.push(win);
    vi.stubGlobal("window", win);
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        closed = false;
        posted: unknown[] = [];
        constructor(public name: string) {
          channels.push(this as unknown as FakeChannel);
        }

        postMessage(message: unknown): void {
          this.posted.push(message);
        }

        close(): void {
          this.closed = true;
        }
      },
    );
  });

  afterEach(() => {
    // Leave no channel open for the next test: the module keeps the page's
    // channel and its owner, so a test that never left would hand its channel to
    // the next test's store. Every stubbed window is asked, because the module
    // bound its pair to whichever one was current when a store opened.
    for (const stub of stubbedWindows) {
      stub.dispatch("pagehide", { persisted: true });
    }
    vi.unstubAllGlobals();
  });

  const makeStore = (initialSegments: ResolvedSegment[] = [seg("products")]) =>
    createNavigationStore({
      crossTabSync: true,
      onCrossTabRefresh: refresh,
      initialLocation: { href: "http://localhost/products" },
      initialSegmentIds: initialSegments.map((s) => s.id),
      initialHistoryKey: "/products",
      initialSegments,
    });

  const invalidation = (overrides: Record<string, unknown> = {}) =>
    ({
      data: {
        type: "invalidate",
        path: "/products",
        segmentIds: ["products"],
        rangoState: getRangoState(),
        stateCookieName: getRangoStateCookieName(),
        soft: true,
        ...overrides,
      },
    }) as MessageEvent;

  it("closes the channel and drops its handler on pagehide", () => {
    makeStore();
    const channel = channels.at(-1)!;
    expect(channel.onmessage).toBeTypeOf("function");

    win.dispatch("pagehide", { persisted: true });

    expect(channel.closed).toBe(true);
    expect(channel.onmessage).toBeNull();
  });

  it("reopens the channel with the store's handler on pageshow", () => {
    const store = makeStore();
    const first = channels.at(-1)!;
    win.dispatch("pagehide", { persisted: true });

    win.dispatch("pageshow", { persisted: true });

    const reopened = channels.at(-1)!;
    expect(reopened).not.toBe(first);
    expect(reopened.closed).toBe(false);
    expect(reopened.onmessage).toBeTypeOf("function");

    // The handler is the store's: an invalidation after the restore still
    // reaches it.
    const epochBefore = currentPrefetchEpoch();
    reopened.onmessage?.(invalidation());
    expect(currentPrefetchEpoch()).toBeGreaterThan(epochBefore);
    expect(store.getCachedSegments("/products")?.stale).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("reopens a channel pagehide closed when an invalidation must still go out", () => {
    const store = makeStore();
    const first = channels.at(-1)!;
    win.dispatch("pagehide", { persisted: true });
    expect(first.closed).toBe(true);

    store.markCacheAsStaleAndBroadcast();

    const reopened = channels.at(-1)!;
    expect(reopened).not.toBe(first);
    expect(reopened.posted).toHaveLength(1);
  });

  it("marks the restored page's caches stale: broadcasts sent while frozen were missed", () => {
    const store = makeStore();
    const generationBefore = currentGeneration();
    const epochBefore = currentPrefetchEpoch();
    const stateBefore = getRangoState();

    win.dispatch("pagehide", { persisted: true });
    win.dispatch("pageshow", { persisted: true });

    expect(store.getCachedSegments("/products")?.stale).toBe(true);
    expect(currentPrefetchEpoch()).toBe(epochBefore + 1);
    // Marked, never flushed: no rotation, and the restored page is not
    // refreshed, so the pixels the user went Back for stay.
    expect(currentGeneration()).toBe(generationBefore);
    expect(getRangoState()).toBe(stateBefore);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("marks nothing on a first load's pageshow, which missed no broadcast", () => {
    const store = makeStore();
    const epochBefore = currentPrefetchEpoch();

    win.dispatch("pageshow", { persisted: false });

    expect(store.getCachedSegments("/products")?.stale).toBe(false);
    expect(currentPrefetchEpoch()).toBe(epochBefore);
    expect(channels).toHaveLength(1);
  });

  it("binds one pagehide/pageshow pair per window, however many stores open", () => {
    makeStore();
    makeStore();

    expect(win.listeners.get("pagehide")).toHaveLength(1);
    expect(win.listeners.get("pageshow")).toHaveLength(1);
    // One channel: the second store takes it over rather than opening another.
    expect(channels).toHaveLength(1);
  });

  it("leaves the channel open when the window has no event API", () => {
    // A unit test stubs `window` without listeners; the store must still boot and
    // keep the channel open, which is how it behaved before the pagehide pair.
    vi.stubGlobal("window", {
      location: { href: "http://localhost/products", pathname: "/products" },
    });

    expect(() => makeStore()).not.toThrow();
    expect(channels.at(-1)!.closed).toBe(false);
  });
});
