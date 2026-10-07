/**
 * `prefetch: false` in the browser (docs/design/prefetch-false.md, "The
 * browser"): a payload that carries deferred segments commits at once with a
 * gate in place of each missing value, and one fill request fetches them.
 * Pins browser/partial-update.ts (armGates, runFill) and its use of
 * browser/pending-fill.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSegment } from "../browser/types";
import { NetworkError, ServerRedirect } from "../errors";

const transitionState = vi.hoisted(() => ({ inTransition: false }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    startTransition: (fn: () => void) => {
      transitionState.inTransition = true;
      try {
        fn();
      } finally {
        transitionState.inTransition = false;
      }
    },
  };
});
vi.mock("../browser/segment-structure-assert.js", () => ({
  assertSegmentStructure: vi.fn(),
}));

import { createPartialUpdater } from "../browser/partial-update";
import { cancelPendingFill } from "../browser/pending-fill";
import { loaderStore } from "../loader-store";

const URL_PAGE = "http://localhost/product";

function seg(
  id: string,
  overrides?: Partial<ResolvedSegment>,
): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type: "route",
    component: `component-${id}`,
    ...overrides,
  } as ResolvedSegment;
}

const loaderSeg = (id: string, loaderId: string, data?: unknown) =>
  seg(id, {
    type: "loader",
    component: null,
    loaderId,
    ...(data === undefined ? { deferred: true } : { loaderData: data }),
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A store whose history cache is written by tx.commit, like the real one. */
function createStore(cachedSegments: ResolvedSegment[]) {
  const cache = new Map<
    string,
    { segments: ResolvedSegment[]; stale: boolean }
  >([["/", { segments: cachedSegments, stale: false }]]);
  let historyKey = "/";
  let segmentIds = cachedSegments.map((s) => s.id);
  return {
    cache,
    getHistoryKey: () => historyKey,
    setHistoryKey: (key: string) => {
      historyKey = key;
    },
    getCachedSegments: (key: string) => cache.get(key),
    getSegmentState: () => ({
      path: "/",
      currentUrl: "http://localhost/",
      currentSegmentIds: segmentIds,
    }),
    setSegmentIds: vi.fn((ids: string[]) => {
      segmentIds = ids;
    }),
    getSegmentIds: () => segmentIds,
    setInterceptSourceUrl: vi.fn(),
    getInterceptSourceUrl: () => null,
    getHistoryEntryMemory: () => undefined,
    rememberDisplayedEntry: vi.fn(),
    updateCacheHandleData: vi.fn(),
    cacheSegmentsForHistory: vi.fn(),
  };
}

/** tx.commit moves the store to `key` and caches the committed segments. */
function createTx(store: ReturnType<typeof createStore>, key = "/product") {
  const end = vi.fn();
  return {
    end,
    tx: {
      currentUrl: "http://localhost/",
      startStreaming: vi.fn(() => ({ end })),
      commit: vi.fn((ids: string[], segments: ResolvedSegment[]) => {
        // What navigation-transaction.ts commit() does to a pending fill.
        cancelPendingFill();
        store.setHistoryKey(key);
        store.setSegmentIds(ids);
        store.cache.set(key, { segments, stale: false });
        return { scroll: undefined };
      }),
    },
  };
}

type FetchOptions = {
  targetUrl: string;
  segmentIds: string[];
  previousUrl: string;
  fill?: boolean;
  signal?: AbortSignal;
};

/**
 * The first fetch answers with `adopted`; the fill is answered by the test
 * through `fill` (a real request would reject once its signal aborts).
 */
function createClient(adopted: unknown, fullyPrefetched = true) {
  const fill = deferred<{ payload: any; streamComplete: Promise<void> }>();
  const calls: FetchOptions[] = [];
  const fetchPartial = vi.fn(async (options: FetchOptions) => {
    calls.push(options);
    if (!options.fill) {
      return {
        payload: adopted,
        streamComplete: Promise.resolve(),
        fullyPrefetched,
      };
    }
    options.signal?.addEventListener("abort", () =>
      fill.reject(new DOMException("aborted", "AbortError")),
    );
    return fill.promise;
  });
  return { client: { fetchPartial }, fill, calls };
}

/** A prefetched product page: a held layout, a route, two loaders, one deferred. */
function loaderAdoption() {
  const layout = seg("L0", { type: "layout", component: "layout" });
  const route = seg("L0R0", { component: "route" });
  const price = loaderSeg("L0R0D0.price", "price", { price: 1 });
  const reviews = loaderSeg("L0R0D1.reviews", "reviews");
  const matched = ["L0", "L0R0", "L0R0D0.price", "L0R0D1.reviews"];
  return {
    layout,
    route,
    price,
    reviews,
    matched,
    payload: {
      metadata: {
        isPartial: true,
        segments: [route, price, reviews],
        matched,
        diff: ["L0R0", "L0R0D0.price", "L0R0D1.reviews"],
      },
    },
  };
}

function fillPayload(segments: ResolvedSegment[], matched: string[]) {
  return {
    payload: {
      metadata: {
        isPartial: true,
        segments,
        matched,
        diff: segments.map((s) => s.id),
      },
    },
    streamComplete: Promise.resolve(),
  };
}

function setup(
  adoption: { payload: unknown; layout?: ResolvedSegment },
  options?: {
    fill?: {
      redirect: ReturnType<typeof vi.fn>;
      locationState: ReturnType<typeof vi.fn>;
    };
    renderSegments?: (segments: ResolvedSegment[]) => Promise<unknown>;
  },
) {
  const store = createStore(adoption.layout ? [adoption.layout] : []);
  const { client, fill, calls } = createClient(adoption.payload);
  const { tx, end } = createTx(store);
  const onUpdate = vi.fn();
  const renderSegments = vi.fn(
    options?.renderSegments ??
      (async (segments: ResolvedSegment[]) => `tree-${segments.length}`),
  );
  const updater = createPartialUpdater({
    getVersion: () => "v1",
    store: store as any,
    client: client as any,
    onUpdate,
    renderSegments: renderSegments as any,
    fill: options?.fill as any,
  });
  const navigate = () =>
    updater(URL_PAGE, undefined, false, undefined, tx as any);
  return {
    store,
    client,
    fill,
    calls,
    tx,
    end,
    onUpdate,
    renderSegments,
    navigate,
  };
}

afterEach(() => {
  cancelPendingFill();
  loaderStore.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A redirect is validated against, and may leave through, window.location. */
function stubLocation() {
  const assign = vi.fn();
  vi.stubGlobal("window", {
    location: { origin: "http://localhost", href: URL_PAGE, assign },
  });
  return assign;
}

describe("adopting a payload with deferred segments", () => {
  it("commits at once with a gate as the deferred loader's data", async () => {
    const adoption = loaderAdoption();
    const { navigate, onUpdate, store, tx } = setup(adoption);
    await navigate();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(adoption.reviews.loaderData).toBeInstanceOf(Promise);
    expect(adoption.reviews.deferred).toBe(true);
    // The store never reports a placeholder as held.
    expect(tx.commit.mock.calls[0][0]).toEqual(["L0", "L0R0", "L0R0D0.price"]);
    // The entry keeps the placeholder itself, so the fill can find it.
    expect(store.cache.get("/product")!.segments).toContain(adoption.reviews);
  });

  it("puts the gate in a deferred unit's component and keeps its fallback", async () => {
    const layout = seg("L0", { type: "layout", component: "layout" });
    const unit = seg("L0R0", {
      component: null,
      loading: "skeleton",
      deferred: true,
    });
    const { navigate, tx } = setup({
      layout,
      payload: {
        metadata: {
          isPartial: true,
          segments: [unit],
          matched: ["L0", "L0R0"],
          diff: ["L0R0"],
        },
      },
    });
    await navigate();

    expect(unit.component).toBeInstanceOf(Promise);
    expect(unit.loading).toBe("skeleton");
    expect(tx.commit.mock.calls[0][0]).toEqual(["L0"]);
  });

  it("shows the placeholder's fallback over a held copy that suppressed it", async () => {
    const layout = seg("L0", { type: "layout", component: "layout" });
    const held = seg("L0R0", { component: "old", loading: false });
    const unit = seg("L0R0", {
      component: null,
      loading: "skeleton",
      deferred: true,
    });
    const store = createStore([layout, held]);
    const { client } = createClient({
      metadata: {
        isPartial: true,
        segments: [unit],
        matched: ["L0", "L0R0"],
        diff: ["L0R0"],
      },
    });
    const { tx } = createTx(store);
    const renderSegments = vi.fn(
      async (_segments: ResolvedSegment[]) => "tree",
    );
    const updater = createPartialUpdater({
      store: store as any,
      client: client as any,
      onUpdate: vi.fn(),
      renderSegments: renderSegments as any,
    });
    await updater(URL_PAGE, undefined, false, undefined, tx as any);

    const rendered = renderSegments.mock.calls[0][0];
    expect(rendered.find((s) => s.id === "L0R0")).toBe(unit);
    expect(unit.loading).toBe("skeleton");
  });

  it("sends exactly one fill, before the render returns, listing what the client holds", async () => {
    const adoption = loaderAdoption();
    const rendering = deferred<string>();
    const { navigate, calls } = setup(adoption, {
      renderSegments: () => rendering.promise,
    });
    const navigation = navigate();
    await flush();

    // The render has not returned and the fill is already out.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      fill: true,
      targetUrl: URL_PAGE,
      previousUrl: URL_PAGE,
      segmentIds: ["L0", "L0R0", "L0R0D0.price"],
    });
    rendering.resolve("tree");
    await navigation;
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("sends no fill for a payload with nothing deferred", async () => {
    const adoption = loaderAdoption();
    adoption.reviews.loaderData = { reviews: 1 };
    delete adoption.reviews.deferred;
    const { navigate, calls, tx } = setup(adoption);
    await navigate();
    await flush();

    expect(calls).toHaveLength(1);
    expect(tx.commit.mock.calls[0][0]).toEqual(adoption.matched);
  });
});

describe("the fill landing", () => {
  it("rewrites the entry in place, updates the held ids and commits in a transition", async () => {
    const adoption = loaderAdoption();
    const { navigate, fill, store, onUpdate } = setup(adoption);
    await navigate();
    const entry = store.cache.get("/product")!.segments;
    const gate = adoption.reviews.loaderData as Promise<unknown>;

    const filled = loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 });
    let lane: boolean | undefined;
    onUpdate.mockImplementation(() => {
      lane = transitionState.inTransition;
    });
    fill.resolve(fillPayload([filled], adoption.matched));
    await flush();

    // Same array: the fill belongs to the visit that adopted.
    expect(store.cache.get("/product")!.segments).toBe(entry);
    expect(entry.map((s) => s.id)).toEqual(adoption.matched);
    expect(entry).toContain(filled);
    expect(entry.some((s) => s.deferred)).toBe(false);
    expect(store.cacheSegmentsForHistory).not.toHaveBeenCalled();
    expect(store.getSegmentIds()).toEqual(adoption.matched);

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(lane).toBe(true);
    expect(onUpdate.mock.calls[1][0].scroll).toEqual({ enabled: false });
    await expect(gate).resolves.toEqual({ reviews: 5 });
  });

  it("resolves a unit's gate with the component and adds the segments below it", async () => {
    const layout = seg("L0", { type: "layout", component: "layout" });
    const unit = seg("L0L1", {
      type: "layout",
      component: null,
      loading: "skeleton",
      deferred: true,
    });
    const adoptedMatched = ["L0", "L0L1"];
    const { navigate, fill, store } = setup({
      layout,
      payload: {
        metadata: {
          isPartial: true,
          segments: [unit],
          matched: adoptedMatched,
          diff: ["L0L1"],
        },
      },
    });
    await navigate();
    const gate = unit.component as unknown as Promise<unknown>;

    const filledUnit = seg("L0L1", {
      type: "layout",
      component: "unit-content",
      loading: "skeleton",
    });
    const below = seg("L0L1R0", { component: "leaf" });
    fill.resolve(fillPayload([filledUnit, below], ["L0", "L0L1", "L0L1R0"]));
    await flush();

    await expect(gate).resolves.toBe("unit-content");
    expect(store.cache.get("/product")!.segments.map((s) => s.id)).toEqual([
      "L0",
      "L0L1",
      "L0L1R0",
    ]);
    // The adoption's handle stream reads this array on every yield: it must
    // name the segments the fill added, or their handle data is dropped.
    expect(adoptedMatched).toEqual(["L0", "L0L1", "L0L1R0"]);
  });

  it("waits for the adoption's commit when the fill answers first", async () => {
    const adoption = loaderAdoption();
    const rendering = deferred<string>();
    let renders = 0;
    const { navigate, fill, store, onUpdate } = setup(adoption, {
      renderSegments: () =>
        renders++ === 0 ? rendering.promise : Promise.resolve("filled"),
    });
    const navigation = navigate();
    await flush();
    fill.resolve(
      fillPayload(
        [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
        adoption.matched,
      ),
    );
    await flush();
    expect(onUpdate).not.toHaveBeenCalled();

    rendering.resolve("tree");
    await navigation;
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(store.cache.get("/product")!.segments.some((s) => s.deferred)).toBe(
      false,
    );
  });

  it("keeps the streaming token open until the fill has streamed", async () => {
    const adoption = loaderAdoption();
    const { navigate, fill, end } = setup(adoption);
    await navigate();
    await flush();
    expect(end).not.toHaveBeenCalled();

    const fillStream = deferred<void>();
    fill.resolve({
      ...fillPayload(
        [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
        adoption.matched,
      ),
      streamComplete: fillStream.promise,
    });
    await flush();
    expect(end).not.toHaveBeenCalled();

    fillStream.resolve();
    await flush();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("hands the location state the server set to the bridge", async () => {
    const adoption = loaderAdoption();
    const hooks = { redirect: vi.fn(), locationState: vi.fn() };
    const { navigate, fill } = setup(adoption, { fill: hooks });
    await navigate();
    const response = fillPayload(
      [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
      adoption.matched,
    );
    (response.payload.metadata as any).locationState = { flash: "saved" };
    fill.resolve(response);
    await flush();

    expect(hooks.locationState).toHaveBeenCalledWith({ flash: "saved" });
  });
});

describe("a fill that does not land", () => {
  it("is dropped when the entry no longer holds the placeholders", async () => {
    const adoption = loaderAdoption();
    const { navigate, fill, store, onUpdate } = setup(adoption);
    await navigate();
    // An action refetch already rendered the deferred loader.
    const fromAction = loaderSeg("L0R0D1.reviews", "reviews", { reviews: 9 });
    store.cache.set("/product", {
      segments: [adoption.layout, adoption.route, adoption.price, fromAction],
      stale: false,
    });

    fill.resolve(
      fillPayload(
        [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
        adoption.matched,
      ),
    );
    await flush();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(store.cache.get("/product")!.segments).toContain(fromAction);
  });

  it("is aborted when the page is left before the response, and the gate stops being a pending stream", async () => {
    const adoption = loaderAdoption();
    const { navigate, calls, onUpdate, end } = setup(adoption);
    await navigate();
    const gate = adoption.reviews.loaderData as Promise<unknown>;
    loaderStore.trackPendingStream("reviews", gate);
    expect(loaderStore.isStreamPending("reviews")).toBe(true);

    // What a committing navigation and a back/forward both do.
    cancelPendingFill();
    await flush();

    expect(calls[1].signal?.aborted).toBe(true);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(loaderStore.isStreamPending("reviews")).toBe(false);
    // The streaming token is not left open by a fill that never lands.
    expect(end).toHaveBeenCalledTimes(1);
    // The placeholder stays: history treats the entry as a miss.
    expect(adoption.reviews.deferred).toBe(true);
  });

  it("is not aborted once the response arrived, only dropped", async () => {
    const adoption = loaderAdoption();
    const rendering = deferred<string>();
    let renders = 0;
    const { navigate, fill, calls, onUpdate } = setup(adoption, {
      renderSegments: () =>
        renders++ === 0 ? Promise.resolve("tree") : rendering.promise,
    });
    await navigate();
    fill.resolve(
      fillPayload(
        [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
        adoption.matched,
      ),
    );
    await flush();

    // Left while the fill's tree is being built.
    cancelPendingFill();
    rendering.resolve("filled");
    await flush();

    expect(calls[1].signal?.aborted).toBe(false);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(adoption.reviews.deferred).toBe(true);
  });

  it("is cancelled when the adoption never commits", async () => {
    const adoption = loaderAdoption();
    const { navigate, calls, tx } = setup(adoption, {
      renderSegments: () => Promise.reject(new Error("render failed")),
    });
    await expect(navigate()).rejects.toThrow("render failed");

    expect(tx.commit).not.toHaveBeenCalled();
    expect(calls[1].signal?.aborted).toBe(true);
  });

  it("rejects the gates when the response cannot be used", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const { navigate, fill, onUpdate } = setup(adoption);
    await navigate();
    const gate = adoption.reviews.loaderData as Promise<unknown>;

    // Lists a segment the client does not hold and does not send it.
    fill.resolve(fillPayload([], [...adoption.matched, "L0R0D2.extra"]));
    await flush();

    await expect(gate).rejects.toThrow(
      "The fill response is missing segments: [L0R0D1.reviews, L0R0D2.extra]",
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("sends a network failure to the network error boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const { navigate, fill, onUpdate } = setup(adoption);
    await navigate();

    fill.reject(new NetworkError("offline", { url: URL_PAGE }));
    await flush();

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[1][0].metadata.isError).toBe(true);
  });

  it("follows a redirect of the whole response through the bridge", async () => {
    stubLocation();
    const adoption = loaderAdoption();
    const hooks = { redirect: vi.fn(), locationState: vi.fn() };
    const { navigate, fill, onUpdate } = setup(adoption, { fill: hooks });
    await navigate();

    fill.reject(new ServerRedirect("/login", { from: "product" }));
    await flush();

    expect(hooks.redirect).toHaveBeenCalledWith("http://localhost/login", {
      from: "product",
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect carried in the payload", async () => {
    stubLocation();
    const adoption = loaderAdoption();
    const hooks = { redirect: vi.fn(), locationState: vi.fn() };
    const { navigate, fill } = setup(adoption, { fill: hooks });
    await navigate();

    fill.resolve({
      payload: { metadata: { redirect: { url: "/login" } } },
      streamComplete: Promise.resolve(),
    });
    await flush();

    expect(hooks.redirect).toHaveBeenCalledWith(
      "http://localhost/login",
      undefined,
    );
  });

  it("leaves by a document navigation when no bridge follows redirects", async () => {
    const assign = stubLocation();
    const adoption = loaderAdoption();
    const { navigate, fill } = setup(adoption);
    await navigate();

    fill.reject(new ServerRedirect("/login", undefined));
    await flush();

    expect(assign).toHaveBeenCalledWith("http://localhost/login");
  });

  it("does not follow a redirect to another origin", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const assign = stubLocation();
    const adoption = loaderAdoption();
    const hooks = { redirect: vi.fn(), locationState: vi.fn() };
    const { navigate, fill } = setup(adoption, { fill: hooks });
    await navigate();

    fill.reject(new ServerRedirect("https://evil.example/", undefined));
    await flush();

    expect(hooks.redirect).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("a page that holds placeholders", () => {
  it("does not offer a placeholder as a held copy to the next navigation", async () => {
    const adoption = loaderAdoption();
    const { navigate, store, client } = setup(adoption);
    await navigate();
    cancelPendingFill();

    // The next page says the client holds the reviews loader; it does not.
    const next = seg("L0R1", { component: "next" });
    client.fetchPartial.mockImplementation(async (options: FetchOptions) => ({
      payload: {
        metadata: {
          isPartial: true,
          segments:
            options.segmentIds.length === 0 ? [adoption.layout, next] : [next],
          matched:
            options.segmentIds.length === 0
              ? ["L0", "L0R1"]
              : ["L0", "L0R1", "L0R0D1.reviews"],
          diff: options.segmentIds.length === 0 ? ["L0", "L0R1"] : ["L0R1"],
        },
      },
      streamComplete: Promise.resolve(),
      fullyPrefetched: false,
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = createTx(store, "/next");
    const updater = createPartialUpdater({
      store: store as any,
      client: client as any,
      onUpdate: vi.fn(),
      renderSegments: (async () => "tree") as any,
    });
    await updater(
      "http://localhost/next",
      undefined,
      false,
      undefined,
      second.tx as any,
    );

    // The placeholder was reported missing, so everything was fetched again.
    expect(client.fetchPartial.mock.calls.at(-1)![0].segmentIds).toEqual([]);
    expect(second.tx.commit.mock.calls[0][0]).toEqual(["L0", "L0R1"]);
  });
});
