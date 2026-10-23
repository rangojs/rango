/**
 * The partial-request URLs the browser sends, as exact strings: a navigation
 * (navigation-client.ts), a prefetch (prefetch/fetch.ts buildPrefetchUrl) and
 * a JS server action (server-action-bridge.ts). The server reads these
 * parameters by name, and the prefetch cache keys are built from the same
 * strings, so a navigation adopts a prefetch only while both sides write
 * their parameters identically. A change to how the parameters are written
 * (one writer for all three) keeps these strings byte-identical: names,
 * order, encoding and the empty segment list.
 *
 * Only platform globals are stubbed (window, document, navigator, fetch);
 * every module under test runs as the browser runs it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNavigationClient } from "../navigation-client.js";
import { prefetchDirect, setPrefetchDecoder } from "../prefetch/fetch.js";
import {
  buildPrefetchKey,
  buildSourceKey,
  clearPrefetchCache,
} from "../prefetch/cache.js";
import { createServerActionBridge } from "../server-action-bridge.js";
import { createEventController } from "../event-controller.js";
import { setAppVersion } from "../app-version.js";
import { registerNavigationStore } from "../navigation-store-handle.js";
import { __resetActionFence } from "../action-fence.js";
import type { NavigationStore, RscPayload } from "../types.js";

const ORIGIN = "http://localhost:4173";
const RANGO_STATE = "v1:100";

/** What the page on screen holds, per test. */
let mountedSegments: string[] = [];
let routerId: string | undefined;
/** Its rewrite target (`_rsc_rt`). */
let shownRewriteTarget: string | undefined;

/** The navigation store, as far as the three senders read it. */
const store = {
  getSegmentState: () => ({
    path: "/current",
    currentUrl: `${ORIGIN}/current`,
    currentSegmentIds: mountedSegments,
  }),
  getHistoryEntryMemory: () =>
    shownRewriteTarget === undefined
      ? undefined
      : { routeName: "item", rewriteTarget: shownRewriteTarget, state: null },
  getRouterId: () => routerId,
  getInterceptSourceUrl: () => null,
  markCacheAsStaleAndBroadcast: () => {},
  markHistoryCacheStale: () => {},
};

let fetchMock: ReturnType<typeof vi.fn>;

/** Every URL handed to fetch(), as the string the request goes out with. */
function sentUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

function stubBrowser(href = `${ORIGIN}/current`): void {
  const location = new URL(href);
  vi.stubGlobal("window", {
    location: {
      origin: location.origin,
      href: location.href,
      pathname: location.pathname,
      search: location.search,
      protocol: location.protocol,
    },
    history: { state: { key: "k1" }, replaceState: () => {} },
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal("navigator", { connection: { saveData: false } });
  // A readable state cookie: getRangoState() returns it as it stands.
  vi.stubGlobal("document", { cookie: `rango-state=${RANGO_STATE}` });
}

const payload: RscPayload = {
  metadata: { pathname: "/products", segments: [], isPartial: true },
} as unknown as RscPayload;

beforeEach(() => {
  mountedSegments = [];
  routerId = undefined;
  shownRewriteTarget = undefined;
  stubBrowser();
  fetchMock = vi.fn(async () => new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  registerNavigationStore(store as unknown as NavigationStore);
  setPrefetchDecoder(async (response) => {
    await response;
    return payload;
  });
  setAppVersion(undefined);
});

afterEach(() => {
  clearPrefetchCache(false);
  __resetActionFence();
  setAppVersion(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function navigationClient() {
  return createNavigationClient({
    createFromFetch: (async (response: Promise<Response>) => {
      await response;
      return payload;
    }) as never,
    createFromReadableStream: (async () => payload) as never,
  });
}

describe("navigation URL (navigation-client.ts)", () => {
  it("sends every parameter, in order, and encodes the segment list and rewrite target", async () => {
    await navigationClient().fetchPartial({
      targetUrl: "/products?page=2",
      previousUrl: `${ORIGIN}/current`,
      segmentIds: ["M0L0", "M0L0L0R0"],
      version: "v7",
      routerId: "rid",
      rewriteTarget: "/item/1?sort=a",
    });

    expect(sentUrls()).toEqual([
      `${ORIGIN}/products?page=2&_rsc_partial=true&_rsc_segments=M0L0%2CM0L0L0R0&_rsc_v=v7&_rsc_rid=rid&_rsc_rt=%2Fitem%2F1%3Fsort%3Da`,
    ]);
  });

  it("sends an empty _rsc_segments when no segment is mounted", async () => {
    await navigationClient().fetchPartial({
      targetUrl: "/products",
      previousUrl: `${ORIGIN}/current`,
      segmentIds: [],
    });

    expect(sentUrls()).toEqual([
      `${ORIGIN}/products?_rsc_partial=true&_rsc_segments=`,
    ]);
  });

  it("puts _rsc_stale after the segments and _rsc_fill last", async () => {
    await navigationClient().fetchPartial({
      targetUrl: "/products",
      previousUrl: `${ORIGIN}/current`,
      segmentIds: ["M0L0"],
      staleRevalidation: true,
      version: "v7",
      routerId: "rid",
      rewriteTarget: "/item/1",
      fill: true,
    });

    expect(sentUrls()).toEqual([
      `${ORIGIN}/products?_rsc_partial=true&_rsc_segments=M0L0&_rsc_stale=true&_rsc_v=v7&_rsc_rid=rid&_rsc_rt=%2Fitem%2F1&_rsc_fill=1`,
    ]);
  });
});

describe("prefetch URL (prefetch/fetch.ts)", () => {
  it("sends every parameter, in the navigation's order, with the page's rewrite target", () => {
    shownRewriteTarget = "/item/1?sort=a";

    prefetchDirect("/products?page=2", ["M0L0", "M0L0L0R0"], "v7", "rid");

    expect(sentUrls()).toEqual([
      `${ORIGIN}/products?page=2&_rsc_partial=true&_rsc_segments=M0L0%2CM0L0L0R0&_rsc_v=v7&_rsc_rid=rid&_rsc_rt=%2Fitem%2F1%3Fsort%3Da`,
    ]);
  });

  it("leaves _rsc_segments out when no segment is mounted", () => {
    prefetchDirect("/products", [], "v7");

    expect(sentUrls()).toEqual([
      `${ORIGIN}/products?_rsc_partial=true&_rsc_v=v7`,
    ]);
  });
});

describe("action URL (server-action-bridge.ts)", () => {
  async function sendAction(id: string): Promise<void> {
    const setServerCallback = vi.fn();
    createServerActionBridge({
      store: store as never,
      client: {} as never,
      eventController: createEventController(),
      deps: {
        createTemporaryReferenceSet: () => ({}),
        encodeReply: async () => "",
        createFromFetch: async () => ({ metadata: {} }),
        setServerCallback,
      } as never,
      onUpdate: () => {},
      renderSegments: async () => null,
    }).register();
    const callback = setServerCallback.mock.calls[0]![0] as (
      id: string,
      args: unknown[],
    ) => Promise<unknown>;
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The stub payload is not partial, so the call rejects after the request.
    await callback(id, []).catch(() => {});
  }

  it("keeps the page's own query and appends the action, its segments, version, router and rewrite target", async () => {
    stubBrowser(`${ORIGIN}/current?tab=2`);
    mountedSegments = ["M0L0", "M0L0L0R0"];
    setAppVersion("v7");
    routerId = "rid";
    shownRewriteTarget = "/item/1?sort=a";

    await sendAction("src/actions.ts#save");

    expect(sentUrls()).toEqual([
      `${ORIGIN}/current?tab=2&_rsc_action=src%2Factions.ts%23save&_rsc_segments=M0L0%2CM0L0L0R0&_rsc_v=v7&_rsc_rid=rid&_rsc_rt=%2Fitem%2F1%3Fsort%3Da`,
    ]);
  });

  it("sends an empty _rsc_segments when no segment is mounted", async () => {
    await sendAction("src/actions.ts#save");

    expect(sentUrls()).toEqual([
      `${ORIGIN}/current?_rsc_action=src%2Factions.ts%23save&_rsc_segments=`,
    ]);
  });
});

describe("prefetch cache keys (prefetch/cache.ts)", () => {
  const source = `${ORIGIN}/current`;

  /** The URLs a prefetch and the navigation that follows it send. */
  async function sentFor(segmentIds: string[]): Promise<{
    prefetch: URL;
    navigation: URL;
  }> {
    prefetchDirect("/products", segmentIds, "v7");
    await navigationClient().fetchPartial({
      targetUrl: "/products",
      previousUrl: source,
      segmentIds,
      version: "v7",
      // Bypass the prefetch it would otherwise adopt: both URLs are needed.
      hmr: true,
    });
    const [prefetch, navigation] = sentUrls();
    return { prefetch: new URL(prefetch!), navigation: new URL(navigation!) };
  }

  it("keys the wildcard slot by state and target without _rsc_segments, the source slot with it", async () => {
    const { prefetch, navigation } = await sentFor(["M0L0"]);

    expect(buildPrefetchKey(RANGO_STATE, prefetch)).toBe(
      `${RANGO_STATE}\0/products?_rsc_partial=true&_rsc_v=v7`,
    );
    expect(buildSourceKey(RANGO_STATE, source, prefetch)).toBe(
      `${RANGO_STATE}\0${source}\0/products?_rsc_partial=true&_rsc_segments=M0L0&_rsc_v=v7`,
    );
    // The navigation's keys are the prefetch's: either slot serves it.
    expect(buildPrefetchKey(RANGO_STATE, navigation)).toBe(
      buildPrefetchKey(RANGO_STATE, prefetch),
    );
    expect(buildSourceKey(RANGO_STATE, source, navigation)).toBe(
      buildSourceKey(RANGO_STATE, source, prefetch),
    );
  });

  it("with no segment mounted, the navigation matches the prefetch on the wildcard key only", async () => {
    const { prefetch, navigation } = await sentFor([]);

    expect(buildPrefetchKey(RANGO_STATE, navigation)).toBe(
      buildPrefetchKey(RANGO_STATE, prefetch),
    );
    expect(buildSourceKey(RANGO_STATE, source, navigation)).toBe(
      `${RANGO_STATE}\0${source}\0/products?_rsc_partial=true&_rsc_segments=&_rsc_v=v7`,
    );
    expect(buildSourceKey(RANGO_STATE, source, prefetch)).toBe(
      `${RANGO_STATE}\0${source}\0/products?_rsc_partial=true&_rsc_v=v7`,
    );
  });

  it("a navigation adopts the prefetch of its URL instead of fetching again", async () => {
    prefetchDirect("/products", [], "v7");
    await navigationClient().fetchPartial({
      targetUrl: "/products",
      previousUrl: source,
      segmentIds: [],
      version: "v7",
    });

    expect(sentUrls()).toEqual([
      `${ORIGIN}/products?_rsc_partial=true&_rsc_v=v7`,
    ]);
  });
});
