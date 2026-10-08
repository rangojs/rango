/**
 * `prefetch: false` in the browser (docs/design/prefetch-false.md, "The
 * browser"): a payload that carries deferred segments commits at once with a
 * gate in place of each missing value, and one fill request fetches them.
 * Pins browser/partial-update.ts (armGates, runFill) and its use of
 * browser/pending-fill.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSegment } from "../browser/types";
import type { RenderSegmentsOptions } from "../segment-system";
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
import { cancelPendingFill, isAdopting } from "../browser/pending-fill";
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
        return { scroll: { enabled: undefined } };
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
    renderSegments?: (
      segments: ResolvedSegment[],
      options?: RenderSegmentsOptions,
    ) => Promise<unknown>;
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The message of the error the last update throws into the tree, if any. */
function errorOf(onUpdate: ReturnType<typeof vi.fn>): string | undefined {
  const update = onUpdate.mock.calls.at(-1)?.[0];
  if (!update?.metadata?.isError) return undefined;
  return (update.root.props.error as Error).message;
}

/** Whether `promise` has settled, either way, by the next macrotask. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await flush();
  return done;
}

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

  // useNavigation() pins `loading` for the update's transition while this
  // is set (pending-fill.ts emitAdoption): only an adoption that waits for a
  // fill asks for it.
  it("hands its update to React as an adoption, and a payload with nothing deferred as usual", async () => {
    const seen: boolean[] = [];
    const adoption = loaderAdoption();
    const waiting = setup(adoption);
    waiting.onUpdate.mockImplementation(() => seen.push(isAdopting()));
    await waiting.navigate();
    expect(seen).toEqual([true]);
    expect(isAdopting(), "only while the update is handed over").toBe(false);

    const whole = setup({
      layout: adoption.layout,
      payload: {
        metadata: {
          isPartial: true,
          segments: [seg("L0R0", { component: "route" })],
          matched: ["L0", "L0R0"],
          diff: ["L0R0"],
        },
      },
    });
    whole.onUpdate.mockImplementation(() => seen.push(isAdopting()));
    await whole.navigate();
    expect(seen).toEqual([true, false]);
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

/** A prefetched page whose route is one deferred unit, below a held layout. */
function unitAdoption(overrides?: Partial<ResolvedSegment>) {
  const layout = seg("L0", { type: "layout", component: "layout" });
  const unit = seg("L0R0", {
    component: null,
    loading: "skeleton",
    deferred: true,
    ...overrides,
  });
  const matched = ["L0", "L0R0"];
  return {
    layout,
    unit,
    matched,
    filled: seg("L0R0", {
      component: "unit-content",
      loading: "skeleton",
      ...overrides,
    }),
    payload: {
      metadata: {
        isPartial: true,
        segments: [unit],
        matched,
        diff: ["L0R0"],
      },
    },
  };
}

/** React commits the adoption's tree (NavigationProvider calls `onCommit`). */
function showAdoption(onUpdate: ReturnType<typeof vi.fn>): void {
  onUpdate.mock.calls[0][0].onCommit();
}

describe("the fill landing", () => {
  it("rewrites the entry in place, updates the held ids and resolves the gate", async () => {
    const adoption = loaderAdoption();
    const { navigate, fill, store } = setup(adoption);
    await navigate();
    const entry = store.cache.get("/product")!.segments;
    const gate = adoption.reviews.loaderData as Promise<unknown>;

    const filled = loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 });
    fill.resolve(fillPayload([filled], adoption.matched));
    await flush();

    // Same array: the fill belongs to the visit that adopted.
    expect(store.cache.get("/product")!.segments).toBe(entry);
    expect(entry.map((s) => s.id)).toEqual(adoption.matched);
    expect(entry).toContain(filled);
    expect(entry.some((s) => s.deferred)).toBe(false);
    expect(store.cacheSegmentsForHistory).not.toHaveBeenCalled();
    expect(store.getSegmentIds()).toEqual(adoption.matched);
    await expect(gate).resolves.toEqual({ reviews: 5 });
    // The tree on screen reads the gate. The entry keeps the fill's stream.
    expect(filled.loaderData).toEqual({ reviews: 5 });
  });

  // In a transition of its own the update would start a view transition
  // wherever a <ViewTransition> is mounted, and every reveal would wait for
  // it. Before the adoption is on screen it would commit the page ahead of
  // the transition React holds the adoption in.
  it("hands over what the fill pushed urgently, under the adoption's tree, once React has committed the adoption", async () => {
    const adoption = loaderAdoption();
    const { navigate, fill, onUpdate, renderSegments } = setup(adoption);
    await navigate();
    const adopted = onUpdate.mock.calls[0][0];
    let lane: boolean | undefined;
    onUpdate.mockImplementation(() => {
      lane = transitionState.inTransition;
    });

    const response = fillPayload(
      [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
      adoption.matched,
    );
    fill.resolve(response);
    await flush();
    expect(
      onUpdate,
      "not before the adoption is on screen",
    ).toHaveBeenCalledTimes(1);

    showAdoption(onUpdate);
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(lane).toBe(false);
    const filled = onUpdate.mock.calls[1][0];
    // A fill is not a navigation transaction and says nothing about scroll.
    // An explicit `scroll` here, even a disabled one, would replace the
    // adoption's pending decision while React still holds that commit
    // (testing/__tests__/navigation-scroll-slot.test.tsx).
    expect(Object.keys(filled).sort()).toEqual(["metadata", "root"]);
    expect(filled.root).toBe(adopted.root);
    expect(filled.metadata).toBe(response.payload.metadata);
    // Loaders only: the tree on screen reads the gates, none is rendered.
    expect(renderSegments).toHaveBeenCalledTimes(1);
  });

  // Where React holds the adoption (a read with no boundary) the fill has
  // landed by the time the adoption is on screen, or the page was left.
  it("hands nothing over on a page that was left before React committed the adoption", async () => {
    const adoption = loaderAdoption();
    const { navigate, fill, store, onUpdate } = setup(adoption);
    await navigate();
    fill.resolve(
      fillPayload(
        [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
        adoption.matched,
      ),
    );
    await flush();

    store.setHistoryKey("/");
    showAdoption(onUpdate);
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  // A unit is revealed like a segment a navigation is still streaming: by
  // a Suspense retry, after React has committed the fill's tree. With its
  // content in that tree the commit would reveal it at once, past React's
  // reveal throttle (docs/design/prefetch-false.md, "The browser").
  it("resolves a unit's gate with the component once React has committed the fill's tree, and adds the segments below it", async () => {
    const adoption = unitAdoption({ type: "layout" });
    const { navigate, fill, store, onUpdate } = setup(adoption);
    await navigate();
    showAdoption(onUpdate);
    const gate = adoption.unit.component as unknown as Promise<unknown>;
    let resolved = false;
    void gate.then(() => {
      resolved = true;
    });

    const below = seg("L0R0R0", { component: "leaf" });
    fill.resolve(
      fillPayload([adoption.filled, below], ["L0", "L0R0", "L0R0R0"]),
    );
    await flush();

    const segments = store.cache.get("/product")!.segments;
    expect(segments.map((s) => s.id)).toEqual(["L0", "L0R0", "L0R0R0"]);
    // The tree the fill committed still reads the gate.
    expect(segments[1].component).toBe(gate);
    expect(segments[1].deferred).toBeUndefined();
    expect(resolved, "not before React has committed the fill").toBe(false);

    // The adoption, what the fill pushed, the fill's tree.
    expect(onUpdate).toHaveBeenCalledTimes(3);
    const tree = onUpdate.mock.calls[2][0];
    expect(tree.root).toBe("tree-3");
    // The handle stream is being read from the update before.
    expect(tree.metadata.handles).toBeUndefined();
    expect(tree.metadata.matched).toBeUndefined();
    tree.onCommit();
    await expect(gate).resolves.toBe("unit-content");
    // The adoption's handle stream reads this array on every yield: it must
    // name the segments the fill added, or their handle data is dropped.
    expect(adoption.matched).toEqual(["L0", "L0R0", "L0R0R0"]);
  });

  // The fill's update is urgent: React renders it without waiting, and
  // suspends on any promise it has not read yet, settled or not. Built with
  // other options than the adoption's tree, a boundary that is on screen
  // would get such a promise and show its fallback again (measured: the
  // fallback remounted and the content 300 ms late).
  it("renders the fill's tree as the adoption's was, with what the fill brought as still streaming", async () => {
    const adoption = unitAdoption();
    const renders: Array<{
      forceAwait: unknown;
      streaming: Array<[string, boolean | undefined]>;
    }> = [];
    const { navigate, fill, store, onUpdate } = setup(adoption, {
      renderSegments: async (segments, options) => {
        renders.push({
          forceAwait: options?.forceAwait,
          streaming: segments.map((s) => [s.id, s.deferred]),
        });
        return "tree";
      },
    });
    await navigate();
    showAdoption(onUpdate);
    fill.resolve(fillPayload([adoption.filled], adoption.matched));
    await flush();

    expect(renders).toEqual([
      {
        forceAwait: true,
        streaming: [
          ["L0", undefined],
          ["L0R0", true],
        ],
      },
      {
        forceAwait: true,
        streaming: [
          ["L0", undefined],
          ["L0R0", true],
        ],
      },
    ]);
    expect(store.cache.get("/product")!.segments.some((s) => s.deferred)).toBe(
      false,
    );
  });

  // React can be holding the adoption on a loader its unit owns: a layout
  // above the unit reads the route's loader, with no boundary. That gate
  // used to wait for the fill's tree, which waits for the adoption's commit,
  // which was waiting for the gate: the page being left stayed for good,
  // useNavigation() read `loading`, and nothing was thrown.
  it("resolves every loader gate at once where React has not committed the adoption, a unit's own included", async () => {
    const adoption = unitAdoption({ namespace: "unit" });
    const owned = { ...loaderSeg("L0R0D0.data", "data"), namespace: "unit" };
    adoption.payload.metadata.segments.push(owned);
    adoption.matched.push(owned.id);
    const { navigate, fill, onUpdate } = setup(adoption);
    await navigate();
    const gates = {
      unit: adoption.unit.component as unknown as Promise<unknown>,
      data: owned.loaderData as Promise<unknown>,
    };

    fill.resolve(
      fillPayload(
        [
          adoption.filled,
          { ...loaderSeg("L0R0D0.data", "data", { n: 1 }), namespace: "unit" },
        ],
        adoption.matched,
      ),
    );
    await flush();

    expect(await settled(gates.data), "the loader's gate").toBe(true);
    await expect(gates.data).resolves.toEqual({ n: 1 });
    // The unit still waits for its tree, and the tree for the adoption.
    expect(await settled(gates.unit)).toBe(false);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    showAdoption(onUpdate);
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(3);
    onUpdate.mock.calls.at(-1)![0].onCommit();
    await expect(gates.unit).resolves.toBe("unit-content");
  });

  // A slot reads its loaders above its content: resolved before the unit,
  // they would reveal that boundary onto the unit's own fallback, the same
  // skeleton mounted a second time.
  it("resolves the loaders a unit owns with the unit, and any other loader at once", async () => {
    const layout = seg("L0", { type: "layout", component: "layout" });
    const route = seg("L0R0", { namespace: "route", component: "route" });
    const reviews = {
      ...loaderSeg("L0R0D0.reviews", "reviews"),
      namespace: "route",
    };
    const slot = seg("L0R0.@side", {
      namespace: "slot",
      type: "parallel",
      component: null,
      loading: "skeleton",
      deferred: true,
    });
    const side = { ...loaderSeg("L0R0D0.side", "side"), namespace: "slot" };
    const matched = [
      "L0",
      "L0R0",
      "L0R0D0.reviews",
      "L0R0.@side",
      "L0R0D0.side",
    ];
    const { navigate, fill, onUpdate } = setup({
      layout,
      payload: {
        metadata: {
          isPartial: true,
          segments: [route, reviews, slot, side],
          matched,
          diff: matched.slice(1),
        },
      },
    });
    await navigate();
    showAdoption(onUpdate);
    const gates = {
      reviews: reviews.loaderData as Promise<unknown>,
      slot: slot.component as unknown as Promise<unknown>,
      side: side.loaderData as Promise<unknown>,
    };

    fill.resolve(
      fillPayload(
        [
          {
            ...loaderSeg("L0R0D0.reviews", "reviews", { reviews: 5 }),
            namespace: "route",
          },
          seg("L0R0.@side", {
            namespace: "slot",
            type: "parallel",
            component: "side-content",
            loading: "skeleton",
          }),
          {
            ...loaderSeg("L0R0D0.side", "side", { side: 1 }),
            namespace: "slot",
          },
        ],
        matched,
      ),
    );
    await flush();

    await expect(gates.reviews).resolves.toEqual({ reviews: 5 });
    expect(await settled(gates.slot)).toBe(false);
    expect(await settled(gates.side)).toBe(false);

    onUpdate.mock.calls.at(-1)![0].onCommit();
    await expect(gates.slot).resolves.toBe("side-content");
    await expect(gates.side).resolves.toEqual({ side: 1 });
  });

  // What the next render from this page builds on is the entry. A slot
  // reads the aggregate of its loaders: built over gates in the fill's tree
  // and over the streams afterwards, it is a promise React has not read,
  // and a render that cannot wait suspends on it (measured: a plain click
  // beside the slot showed the slot's fallback again for 300 ms). So a
  // unit's loaders are in the fill's tree as the fill sent them. A loader
  // outside a unit has a reader on screen, which keeps its gate in that
  // tree; the entry gets the stream back.
  it("renders a unit's loaders from the fill's streams, another loader from its gate, and leaves the streams in the entry", async () => {
    const adoption = unitAdoption({ namespace: "unit" });
    const owned = { ...loaderSeg("L0R0D0.data", "data"), namespace: "unit" };
    const other = { ...loaderSeg("L0D0.badge", "badge"), namespace: "layout" };
    adoption.payload.metadata.segments.push(owned, other);
    adoption.matched.push(owned.id, other.id);
    const rendered: unknown[][] = [];
    const { navigate, fill, store, onUpdate } = setup(adoption, {
      renderSegments: async (segments) => {
        rendered.push(
          [owned.id, other.id].map(
            (id) => segments.find((s) => s.id === id)?.loaderData,
          ),
        );
        return "tree";
      },
    });
    await navigate();
    showAdoption(onUpdate);
    const gates = [owned.loaderData, other.loaderData];

    const data = {
      ...loaderSeg("L0R0D0.data", "data", { n: 1 }),
      namespace: "unit",
    };
    const badge = {
      ...loaderSeg("L0D0.badge", "badge", { n: 2 }),
      namespace: "layout",
    };
    fill.resolve(fillPayload([adoption.filled, data, badge], adoption.matched));
    await flush();

    expect(rendered).toEqual([gates, [{ n: 1 }, gates[1]]]);
    const entry = store.cache.get("/product")!.segments;
    expect(entry).toContain(data);
    expect(entry).toContain(badge);
    expect([data.loaderData, badge.loaderData]).toEqual([{ n: 1 }, { n: 2 }]);
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
    expect(store.cache.has("/product")).toBe(false);

    rendering.resolve("tree");
    await navigation;
    await flush();
    expect(store.cache.get("/product")!.segments.some((s) => s.deferred)).toBe(
      false,
    );
    showAdoption(onUpdate);
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  // React keeps a fallback up for 300 ms. A plain click's shows with its
  // response; an adopted click's has been up since the click, so React
  // would reveal what the fill brought a round trip sooner, without what is
  // still on its way: a second fallback and 300 ms more where the plain
  // click shows everything at once.
  describe("while its response is still streaming", () => {
    const streaming = (response: ReturnType<typeof fillPayload>) => {
      const stream = deferred<void>();
      return {
        stream,
        response: { ...response, streamComplete: stream.promise },
      };
    };
    const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

    it("lands 300 ms after its first chunk, and hands over what was pushed at once", async () => {
      vi.useFakeTimers();
      const adoption = loaderAdoption();
      const { navigate, fill, store, onUpdate } = setup(adoption);
      await navigate();
      showAdoption(onUpdate);
      const gate = adoption.reviews.loaderData as Promise<unknown>;
      let resolved = false;
      void gate.then(() => {
        resolved = true;
      });

      const { response } = streaming(
        fillPayload(
          [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
          adoption.matched,
        ),
      );
      fill.resolve(response);
      await tick(0);
      expect(onUpdate).toHaveBeenCalledTimes(2);
      expect(onUpdate.mock.calls[1][0].metadata).toBe(
        response.payload.metadata,
      );

      await tick(299);
      expect(resolved).toBe(false);
      expect(store.cache.get("/product")!.segments).toContain(adoption.reviews);

      await tick(1);
      expect(resolved).toBe(true);
      expect(
        store.cache.get("/product")!.segments.some((s) => s.deferred),
      ).toBe(false);
    });

    // The wait is for a fallback that is on screen. Where React still holds
    // the adoption (a read with no boundary) there is none, and the page
    // being left stayed 300 ms for nothing: a plain click shows the page as
    // the value arrives (measured: 311 ms after it, against 12).
    it("does not wait where React has not committed the adoption", async () => {
      vi.useFakeTimers();
      const adoption = loaderAdoption();
      const { navigate, fill, store } = setup(adoption);
      await navigate();
      const gate = adoption.reviews.loaderData as Promise<unknown>;
      let resolved = false;
      void gate.then(() => {
        resolved = true;
      });

      const { response } = streaming(
        fillPayload(
          [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
          adoption.matched,
        ),
      );
      fill.resolve(response);
      await tick(0);

      expect(resolved).toBe(true);
      expect(
        store.cache.get("/product")!.segments.some((s) => s.deferred),
      ).toBe(false);
    });

    it("lands as soon as the stream is complete", async () => {
      vi.useFakeTimers();
      const adoption = loaderAdoption();
      const { navigate, fill, store, onUpdate } = setup(adoption);
      await navigate();
      showAdoption(onUpdate);

      const { stream, response } = streaming(
        fillPayload(
          [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
          adoption.matched,
        ),
      );
      fill.resolve(response);
      await tick(100);
      expect(store.cache.get("/product")!.segments).toContain(adoption.reviews);

      stream.resolve();
      await tick(0);
      expect(
        store.cache.get("/product")!.segments.some((s) => s.deferred),
      ).toBe(false);
    });

    it("lands when the stream fails: what arrived is shown, the rest is the stream's error", async () => {
      vi.useFakeTimers();
      const adoption = loaderAdoption();
      const { navigate, fill, store, onUpdate } = setup(adoption);
      await navigate();
      showAdoption(onUpdate);

      const { stream, response } = streaming(
        fillPayload(
          [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
          adoption.matched,
        ),
      );
      fill.resolve(response);
      await tick(50);
      stream.reject(new Error("cut"));
      await tick(0);
      expect(
        store.cache.get("/product")!.segments.some((s) => s.deferred),
      ).toBe(false);
    });

    it("is dropped when the page is left during the wait", async () => {
      vi.useFakeTimers();
      const adoption = loaderAdoption();
      const { navigate, fill, store, onUpdate } = setup(adoption);
      await navigate();
      showAdoption(onUpdate);

      const { response } = streaming(
        fillPayload(
          [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
          adoption.matched,
        ),
      );
      fill.resolve(response);
      await tick(100);
      cancelPendingFill();
      await tick(300);

      expect(store.cache.get("/product")!.segments).toContain(adoption.reviews);
      expect(store.setSegmentIds).toHaveBeenCalledTimes(1);
    });
  });

  // React renders such a page's content in the commit that shows its
  // fallback. Once the fallback is up, no commit can bring the content in
  // without a view transition a plain click does not start (measured: three
  // for two, the content up to 280 ms late).
  describe("for a unit on a page that commits in a transition", () => {
    const transition = {};

    it("holds the adoption: its update carries a promise nobody resolves", async () => {
      const adoption = unitAdoption({ transition });
      const { navigate, onUpdate } = setup(adoption);
      let lane: boolean | undefined;
      onUpdate.mockImplementation(() => {
        lane = transitionState.inTransition;
      });
      await navigate();

      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(lane).toBe(true);
      const adopted = onUpdate.mock.calls[0][0];
      expect(adopted.root).toBeInstanceOf(Promise);
      expect(await settled(adopted.root)).toBe(false);
    });

    // One update, in a transition: React commits it with the adoption's
    // (two transition updates of one state), so the tree, what the fill
    // pushed and the location state the server set arrive in one commit, as
    // a plain click's do. Handed over after that commit, the state was one
    // commit behind the content.
    it("lands with the fill's first chunk: one update in a transition carries the tree, the unit's content in it, and what the fill pushed", async () => {
      const adoption = unitAdoption({ transition });
      const hooks = { redirect: vi.fn(), locationState: vi.fn() };
      const { navigate, fill, store, onUpdate, renderSegments } = setup(
        adoption,
        { fill: hooks },
      );
      await navigate();
      const gate = adoption.unit.component as unknown as Promise<unknown>;
      const order: string[] = [];
      hooks.locationState.mockImplementation(() => order.push("state"));
      onUpdate.mockImplementation(() =>
        order.push(transitionState.inTransition ? "transition" : "urgent"),
      );

      // Still streaming: a plain click commits with its first chunk too.
      const response = {
        ...fillPayload([adoption.filled], adoption.matched),
        streamComplete: new Promise<void>(() => {}),
      };
      (response.payload.metadata as any).locationState = { flash: "saved" };
      fill.resolve(response);
      await flush();

      // The state is the entry's before React is handed the update that
      // reads it.
      expect(order).toEqual(["state", "transition"]);
      expect(onUpdate).toHaveBeenCalledTimes(2);
      const landed = onUpdate.mock.calls[1][0];
      expect(Object.keys(landed).sort()).toEqual(["metadata", "root"]);
      expect(landed.root).toBe("tree-2");
      expect(landed.metadata).toBe(response.payload.metadata);
      expect(store.cache.get("/product")!.segments[1]).toBe(adoption.filled);
      expect(adoption.filled.component).toBe("unit-content");
      await expect(gate).resolves.toBe("unit-content");
      // The tree is the page's first: nothing in it is on screen yet.
      const options = (renderSegments.mock.calls[1] as unknown[])[1];
      expect((options as { forceAwait?: boolean }).forceAwait).toBe(false);

      // Nothing is left to hand over once React has committed.
      showAdoption(onUpdate);
      await flush();
      expect(onUpdate).toHaveBeenCalledTimes(2);
    });

    it("does not hold a page whose deferred segments are loaders", async () => {
      const adoption = loaderAdoption();
      adoption.route.transition = transition as ResolvedSegment["transition"];
      const { navigate, onUpdate } = setup(adoption);
      await navigate();

      expect(onUpdate.mock.calls[0][0].root).toBe("tree-4");
    });

    it("shows a fill that fails in place of the held page", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const adoption = unitAdoption({ transition });
      const { navigate, fill, onUpdate } = setup(adoption);
      await navigate();

      fill.reject(new Error("undecodable"));
      await flush();

      expect(onUpdate).toHaveBeenCalledTimes(2);
      expect(errorOf(onUpdate)).toBe("undecodable");
    });
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
    const layout = seg("L0", { type: "layout", component: "layout" });
    const unit = seg("L0R0", {
      component: null,
      loading: "skeleton",
      deferred: true,
    });
    const rendering = deferred<string>();
    let renders = 0;
    const { navigate, fill, calls, onUpdate, store } = setup(
      {
        layout,
        payload: {
          metadata: {
            isPartial: true,
            segments: [unit],
            matched: ["L0", "L0R0"],
            diff: ["L0R0"],
          },
        },
      },
      {
        renderSegments: () =>
          renders++ === 0 ? Promise.resolve("tree") : rendering.promise,
      },
    );
    await navigate();
    fill.resolve(
      fillPayload(
        [seg("L0R0", { component: "unit-content", loading: "skeleton" })],
        ["L0", "L0R0"],
      ),
    );
    await flush();

    // Left while the fill's tree is being built.
    cancelPendingFill();
    rendering.resolve("filled");
    await flush();

    expect(calls[1].signal?.aborted).toBe(false);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(store.cache.get("/product")!.segments[1].deferred).toBe(true);
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

  // A fill the client cannot use ends like a navigation it cannot process
  // (navigation-bridge.ts): the error replaces the page, so an error boundary
  // takes over. The gates are left alone. A rejected gate is an unhandled
  // rejection of every aggregate built over it (segment-loader-promise.ts).
  it("shows a response it cannot use as an error, and settles no gate", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const { navigate, fill, onUpdate } = setup(adoption);
    await navigate();
    const gate = adoption.reviews.loaderData as Promise<unknown>;
    loaderStore.trackPendingStream("reviews", gate);

    // Lists a segment the client does not hold and does not send it.
    fill.resolve(fillPayload([], [...adoption.matched, "L0R0D2.extra"]));
    await flush();

    expect(errorOf(onUpdate)).toBe(
      "[rango] fill: missing segments [L0R0D1.reviews, L0R0D2.extra]",
    );
    expect(await settled(gate)).toBe(false);
    expect(loaderStore.isStreamPending("reviews")).toBe(false);
  });

  // Checked before anything is handed over: the adoption's `matched`, the
  // location state and the handle data of a response the client then
  // refuses would stay behind under the error.
  it("hands nothing over from a response it cannot use", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const hooks = { redirect: vi.fn(), locationState: vi.fn() };
    const { navigate, fill, onUpdate } = setup(adoption, { fill: hooks });
    await navigate();
    showAdoption(onUpdate);
    const matched = [...adoption.matched];

    const response = fillPayload([], [...matched, "L0R0D2.extra"]);
    (response.payload.metadata as any).locationState = { flash: "saved" };
    fill.resolve(response);
    await flush();

    expect(errorOf(onUpdate)).toBe(
      "[rango] fill: missing segments [L0R0D1.reviews, L0R0D2.extra]",
    );
    expect(adoption.matched).toEqual(matched);
    expect(hooks.locationState).not.toHaveBeenCalled();
    // The adoption and the error.
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  // The error's commit is also the commit the adoption's update was
  // waiting for, where React had not committed the adoption yet. Handed over
  // then, what the fill pushed would put the adoption's tree back over the
  // error, with gates nobody resolves: a fallback for good.
  it("hands nothing over after a failure, whenever React commits the adoption", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = unitAdoption({ transition: {} });
    const { navigate, fill, onUpdate } = setup(adoption);
    await navigate();

    // Usable up to its first chunk, then not: a segment is missing.
    fill.resolve(fillPayload([], [...adoption.matched, "L0R0D0.extra"]));
    await flush();
    expect(errorOf(onUpdate)).toBe(
      "[rango] fill: missing segments [L0R0, L0R0D0.extra]",
    );
    expect(onUpdate).toHaveBeenCalledTimes(2);

    showAdoption(onUpdate);
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("shows a response that is not a partial payload as an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const { navigate, fill, onUpdate } = setup(adoption);
    await navigate();

    fill.resolve({
      payload: { metadata: { segments: [] } },
      streamComplete: Promise.resolve(),
    });
    await flush();

    expect(errorOf(onUpdate)).toBe("[rango] fill: not a partial payload");
  });

  it("holds a failure until the adoption has committed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const rendering = deferred<string>();
    const { navigate, fill, onUpdate } = setup(adoption, {
      renderSegments: () => rendering.promise,
    });
    const navigation = navigate();
    await flush();

    // The fill fails while the adoption is still rendering. Shown now, the
    // error would be replaced by the adoption's own commit a moment later,
    // and its fallback would then wait for a fill that already failed.
    fill.reject(new Error("undecodable"));
    await flush();
    expect(onUpdate).not.toHaveBeenCalled();

    rendering.resolve("tree");
    await navigation;
    await flush();
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(errorOf(onUpdate)).toBe("undecodable");
  });

  it("shows no failure on a page that no longer waits for the fill", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const { navigate, fill, store, onUpdate } = setup(adoption);
    await navigate();
    // An action refetch already rendered the deferred loader.
    store.cache.set("/product", {
      segments: [
        adoption.layout,
        adoption.route,
        adoption.price,
        loaderSeg("L0R0D1.reviews", "reviews", { reviews: 9 }),
      ],
      stale: false,
    });

    fill.reject(new NetworkError("offline", { url: URL_PAGE }));
    await flush();

    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("sends a network failure to the network error boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const { navigate, fill, onUpdate } = setup(adoption);
    await navigate();

    // What fetch() throws when the network drops, not a NetworkError yet: the
    // network error page is picked by the error's class.
    fill.reject(new TypeError("Failed to fetch"));
    await flush();

    expect(onUpdate).toHaveBeenCalledTimes(2);
    const update = onUpdate.mock.calls[1][0];
    expect(update.metadata.isError).toBe(true);
    expect(update.root.props.error).toBeInstanceOf(NetworkError);
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

  // A redirect the client refuses to follow ends the fill with nothing to
  // show. Returning quietly would leave the fallback up for good.
  describe("a redirect the client does not follow", () => {
    it.each([
      [
        "a redirect of the whole response to another origin",
        () =>
          Promise.reject(
            new ServerRedirect("https://evil.example/", undefined),
          ),
      ],
      [
        "a redirect in the payload to another origin",
        () =>
          Promise.resolve({
            payload: {
              metadata: { redirect: { url: "https://evil.example/" } },
            },
            streamComplete: Promise.resolve(),
          }),
      ],
      [
        "an external redirect in the payload with a scheme that is not http",
        () =>
          Promise.resolve({
            payload: {
              metadata: {
                redirect: { url: "javascript:alert(1)", external: true },
              },
            },
            streamComplete: Promise.resolve(),
          }),
      ],
    ])("%s ends in an error", async (_label, response) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const assign = stubLocation();
      const adoption = loaderAdoption();
      const hooks = { redirect: vi.fn(), locationState: vi.fn() };
      const { navigate, fill, onUpdate } = setup(adoption, { fill: hooks });
      await navigate();

      response().then(fill.resolve, fill.reject);
      await flush();

      expect(hooks.redirect).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(errorOf(onUpdate)).toBe("[rango] fill: redirect not followed");
    });
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
