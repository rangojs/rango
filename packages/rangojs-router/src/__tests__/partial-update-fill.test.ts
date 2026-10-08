/**
 * `prefetch: false` in the browser (docs/design/prefetch-false.md, "The
 * browser"): a payload that carries deferred segments is the page with holes
 * in it. Its tree is built and committed once, with a gate in place of each
 * missing value, and one fill request settles the gates: it resolves them and
 * writes the stores, and hands React nothing. Pins browser/partial-update.ts
 * (armGates, runFill, settleHoles) and its use of browser/pending-fill.ts.
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
 * through `fill` (a real request would reject once its signal aborts). A
 * request that lists nothing as held is the navigation starting over: the
 * server answers it, with `whole`.
 */
function createClient(adopted: unknown, whole?: unknown) {
  const fill = deferred<{ payload: any; streamComplete: Promise<void> }>();
  const calls: FetchOptions[] = [];
  const fetchPartial = vi.fn(async (options: FetchOptions) => {
    calls.push(options);
    if (!options.fill) {
      const again = whole !== undefined && options.segmentIds.length === 0;
      return {
        payload: again ? whole : adopted,
        streamComplete: Promise.resolve(),
        fullyPrefetched: !again,
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

/** The writes the navigation bridge supplies (PartialUpdateConfig.fill). */
const bridge = () => ({
  redirect: vi.fn(),
  locationState: vi.fn(),
  handles: vi.fn(),
  flush: vi.fn(),
});

function setup(
  adoption: { payload: unknown; layout?: ResolvedSegment },
  options?: {
    fill?: ReturnType<typeof bridge>;
    /** The payload a request with nothing held is answered with. */
    whole?: unknown;
    renderSegments?: (
      segments: ResolvedSegment[],
      options?: RenderSegmentsOptions,
    ) => Promise<unknown>;
  },
) {
  const store = createStore(adoption.layout ? [adoption.layout] : []);
  const { client, fill, calls } = createClient(
    adoption.payload,
    options?.whole,
  );
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
  const navigate = (signal?: AbortSignal) =>
    updater(URL_PAGE, undefined, false, signal, tx as any);
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

  // React may hold the commit (a hole read with no boundary), and the
  // click's own notification has not gone out yet: useNavigation() has to
  // read `loading` before the commit is handed over. And a plain click to a
  // page that is not whole commits urgently, so this one does. In a
  // transition React starts a view transition for the commit wherever a
  // <ViewTransition> is mounted, and what fills the holes is revealed behind
  // it.
  it("delivers the navigation state, then commits urgently; a whole prefetched payload commits in a transition", async () => {
    const recorded = (run: ReturnType<typeof setup>, hooks = bridge()) => {
      const order: string[] = [];
      const commit = run.tx.commit.getMockImplementation()!;
      run.tx.commit.mockImplementation((...args) => {
        order.push("commit");
        return commit(...args);
      });
      run.onUpdate.mockImplementation(() =>
        order.push(transitionState.inTransition ? "transition" : "urgent"),
      );
      hooks.flush.mockImplementation(() => order.push("flush"));
      return order;
    };

    const adoption = loaderAdoption();
    const hooks = bridge();
    const waiting = setup(adoption, { fill: hooks });
    const withHoles = recorded(waiting, hooks);
    await waiting.navigate();
    expect(withHoles).toEqual(["flush", "commit", "urgent"]);

    const wholeHooks = bridge();
    const whole = setup(
      {
        layout: adoption.layout,
        payload: {
          metadata: {
            isPartial: true,
            segments: [seg("L0R0", { component: "route" })],
            matched: ["L0", "L0R0"],
            diff: ["L0R0"],
          },
        },
      },
      { fill: wholeHooks },
    );
    const noHoles = recorded(whole, wholeHooks);
    await whole.navigate();
    expect(noHoles).toEqual(["commit", "transition"]);
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

/**
 * A prefetched page below a flagged layout: the layout unit, a slot of it
 * with no loading(), the route below it, and a loader each. Every one is a
 * placeholder; `filled` is what the fill sends for them, in the same order.
 */
function sectionAdoption() {
  const layout = seg("L0", { type: "layout", component: "layout" });
  const hole = (id: string, overrides: Partial<ResolvedSegment>) =>
    seg(id, { component: null, deferred: true, ...overrides });
  const loader = (id: string, loaderId: string, namespace: string) => ({
    ...loaderSeg(id, loaderId),
    namespace,
  });
  const placeholders = [
    loader("L0L1D0.section", "section", "section"),
    hole("L0L1", { type: "layout", namespace: "section", loading: "skeleton" }),
    hole("L0L1.@side", { type: "parallel", namespace: "side" }),
    loader("L0L1R0D0.page", "page", "page"),
    hole("L0L1R0", { namespace: "page" }),
  ];
  const matched = ["L0", ...placeholders.map((s) => s.id)];
  const filled = placeholders.map((placeholder) =>
    placeholder.type === "loader"
      ? {
          ...loaderSeg(placeholder.id, placeholder.loaderId!, {
            from: placeholder.id,
          }),
          namespace: placeholder.namespace,
        }
      : seg(placeholder.id, {
          type: placeholder.type,
          namespace: placeholder.namespace,
          loading: placeholder.loading,
          component: `content-${placeholder.id}`,
        }),
  );
  return {
    layout,
    placeholders,
    matched,
    filled,
    payload: {
      metadata: {
        isPartial: true,
        segments: placeholders,
        matched,
        diff: placeholders.map((s) => s.id),
      },
    },
  };
}

/** The gate armGates left on a placeholder, and the value a segment carries. */
const valueOf = (segment: ResolvedSegment): unknown =>
  segment.type === "loader" ? segment.loaderData : segment.component;
const gateOf = (placeholder: ResolvedSegment) =>
  valueOf(placeholder) as Promise<unknown>;

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

  // The model: the click builds the page's tree and commits it, and the fill
  // is a routine that waits for the response and resolves what the tree is
  // waiting for. Updates that hand React a tree belong to navigations and
  // actions. The same counts as a plain click's: one update, one tree
  // ("sends no fill for a payload with nothing deferred" above reads 1).
  interface Adopted {
    layout?: ResolvedSegment;
    payload: { metadata: { segments: ResolvedSegment[] } };
    matched: string[];
    /** What the fill sends for the placeholders. */
    filled: ResolvedSegment[];
  }
  const adoptions: Array<[string, () => Adopted]> = [
    [
      "a loader",
      () => {
        const adoption = loaderAdoption();
        return {
          ...adoption,
          filled: [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
        };
      },
    ],
    [
      "a route unit",
      () => {
        const adoption = unitAdoption();
        return { ...adoption, filled: [adoption.filled] };
      },
    ],
    [
      "a layout unit with the route, the slot and the loaders below it",
      sectionAdoption,
    ],
  ];
  describe.each(adoptions)("the click that adopts %s", (_label, build) => {
    it.each([
      ["on screen", true],
      ["held by React", false],
    ])(
      "hands React one tree and one update, with the tree %s when the fill answers",
      async (_state, shown) => {
        const adoption = build();
        const hooks = bridge();
        const { navigate, fill, store, onUpdate, renderSegments } = setup(
          adoption,
          { fill: hooks },
        );
        await navigate();
        const placeholders = (
          adoption.payload.metadata.segments as ResolvedSegment[]
        ).filter((s) => s.deferred);
        const gates = placeholders.map(gateOf);
        if (shown) showAdoption(onUpdate);

        const response = fillPayload(adoption.filled, adoption.matched);
        fill.resolve(response);
        await flush();

        expect(onUpdate).toHaveBeenCalledTimes(1);
        expect(renderSegments).toHaveBeenCalledTimes(1);
        // What the fill's handlers pushed goes to the handle store.
        expect(hooks.handles).toHaveBeenCalledTimes(1);
        expect(hooks.handles).toHaveBeenCalledWith(response.payload.metadata);
        // Every hole of the tree got the fill's value for its segment.
        for (const [index, placeholder] of placeholders.entries()) {
          const brought = adoption.filled.find((s) => s.id === placeholder.id)!;
          await expect(gates[index], placeholder.id).resolves.toEqual(
            valueOf(brought),
          );
        }
        // The entry holds the fill's own segments, not the placeholders: the
        // next render from this page builds on streams and nodes, and a gate
        // is a promise React has read only where a reader was on screen.
        const entry = store.cache.get("/product")!.segments;
        expect(entry.some((s) => s.deferred)).toBe(false);
        for (const brought of adoption.filled) expect(entry).toContain(brought);
        for (const segment of entry) {
          expect(gates, segment.id).not.toContain(valueOf(segment));
        }
      },
    );
  });

  it("waits for the adoption's commit when the fill answers first", async () => {
    const adoption = loaderAdoption();
    const rendering = deferred<string>();
    const { navigate, fill, store, onUpdate } = setup(adoption, {
      renderSegments: () => rendering.promise,
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
    expect(onUpdate).toHaveBeenCalledTimes(1);
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

    it("resolves the gates 300 ms after its first chunk, and hands over what was pushed at once", async () => {
      vi.useFakeTimers();
      const adoption = loaderAdoption();
      const hooks = bridge();
      const { navigate, fill, store, onUpdate } = setup(adoption, {
        fill: hooks,
      });
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
      (response.payload.metadata as any).locationState = { flash: "saved" };
      fill.resolve(response);
      await tick(0);
      expect(hooks.handles).toHaveBeenCalledWith(response.payload.metadata);
      expect(hooks.locationState).toHaveBeenCalledWith({ flash: "saved" });

      await tick(299);
      expect(resolved).toBe(false);
      expect(store.cache.get("/product")!.segments).toContain(adoption.reviews);

      await tick(1);
      expect(resolved).toBe(true);
      expect(
        store.cache.get("/product")!.segments.some((s) => s.deferred),
      ).toBe(false);
      expect(onUpdate).toHaveBeenCalledTimes(1);
    });

    // A unit's content renders the holes below it. Resolved in one task, a
    // hole that is read in that render costs it a microtask, not a fallback.
    it("resolves a unit's gate and every gate below it after the same wait", async () => {
      vi.useFakeTimers();
      const adoption = sectionAdoption();
      const { navigate, fill, onUpdate } = setup(adoption);
      await navigate();
      showAdoption(onUpdate);
      let resolved = 0;
      for (const placeholder of adoption.placeholders) {
        void gateOf(placeholder).then(() => resolved++);
      }

      const { response } = streaming(
        fillPayload(adoption.filled, adoption.matched),
      );
      fill.resolve(response);
      await tick(299);
      expect(resolved).toBe(0);

      await tick(1);
      expect(resolved).toBe(adoption.placeholders.length);
    });

    // The wait is for a fallback that is on screen. Where React still holds
    // the tree (a read with no boundary) there is none, and the page being
    // left stayed 300 ms for nothing: a plain click shows the page as the
    // value arrives (measured: 311 ms after it, against 12). It can be a
    // unit's own gate React waits for: a layout above the unit reads the
    // route's loader with no boundary.
    it("does not wait where React has not committed the tree, for a unit's gate either", async () => {
      vi.useFakeTimers();
      const adoption = sectionAdoption();
      const { navigate, fill, store } = setup(adoption);
      await navigate();
      let resolved = 0;
      for (const placeholder of adoption.placeholders) {
        void gateOf(placeholder).then(() => resolved++);
      }

      const { response } = streaming(
        fillPayload(adoption.filled, adoption.matched),
      );
      fill.resolve(response);
      await tick(0);

      expect(resolved).toBe(adoption.placeholders.length);
      expect(
        store.cache.get("/product")!.segments.some((s) => s.deferred),
      ).toBe(false);
    });

    it("resolves the gates as soon as the stream is complete", async () => {
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

    it("resolves the gates when the stream fails: what arrived is shown, the rest is the stream's error", async () => {
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

    it("is dropped when the page is left during the wait: no gate resolves, and the response is not aborted", async () => {
      vi.useFakeTimers();
      const adoption = loaderAdoption();
      const { navigate, fill, store, calls, onUpdate } = setup(adoption);
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
      await tick(100);
      cancelPendingFill();
      await tick(300);

      expect(resolved).toBe(false);
      expect(calls[1].signal?.aborted).toBe(false);
      expect(store.cache.get("/product")!.segments).toContain(adoption.reviews);
      expect(store.setSegmentIds).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledTimes(1);
    });
  });

  // A plain click to such a page keeps the page it is on until its response
  // starts, then commits the page in one transition: URL, hooks and page
  // together. Committed with the click, the URL moved a round trip before
  // the page, and no later commit could bring the content in without a view
  // transition the plain click does not start (measured: three for two, the
  // content up to 280 ms late).
  describe("for a unit on a page that commits in a transition", () => {
    const transition = {};

    it("commits nothing with the click: the navigation waits for its fill", async () => {
      const adoption = unitAdoption({ transition });
      const hooks = bridge();
      const { navigate, calls, tx, onUpdate } = setup(adoption, {
        fill: hooks,
      });
      const signal = new AbortController().signal;
      const navigation = navigate(signal);
      await flush();

      expect(calls[1]).toMatchObject({
        fill: true,
        targetUrl: URL_PAGE,
        previousUrl: URL_PAGE,
        segmentIds: ["L0"],
      });
      // The navigation's own request: it ends with the navigation.
      expect(calls[1].signal).toBe(signal);
      expect(tx.commit).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
      expect(hooks.flush).not.toHaveBeenCalled();
      expect(await settled(navigation)).toBe(false);
    });

    it("commits once with the fill's first chunk, in a transition, from the prefetched segments and the fill's", async () => {
      const adoption = unitAdoption({ transition });
      const hooks = bridge();
      const { navigate, fill, store, tx, onUpdate, renderSegments } = setup(
        adoption,
        { fill: hooks },
      );
      const order: string[] = [];
      const commit = tx.commit.getMockImplementation()!;
      tx.commit.mockImplementation((...args) => {
        order.push("commit");
        return commit(...args);
      });
      hooks.handles.mockImplementation(() => order.push("handles"));
      onUpdate.mockImplementation(() =>
        order.push(transitionState.inTransition ? "transition" : "urgent"),
      );
      const navigation = navigate();
      await flush();

      // Still streaming: a plain click commits with its first chunk too.
      const response = {
        ...fillPayload([adoption.filled], adoption.matched),
        streamComplete: new Promise<void>(() => {}),
      };
      (response.payload.metadata as any).locationState = { flash: "saved" };
      fill.resolve(response);
      await navigation;

      // The fill's handle stream belongs to the entry the commit made.
      expect(order).toEqual(["commit", "handles", "transition"]);
      expect(hooks.handles).toHaveBeenCalledWith(response.payload.metadata);
      const [ids, segments, overrides] = tx.commit.mock.calls[0] as unknown as [
        string[],
        ResolvedSegment[],
        { serverState?: unknown },
      ];
      expect(ids).toEqual(adoption.matched);
      expect(segments).toEqual([adoption.layout, adoption.filled]);
      // The state the fill's handlers set is the entry's from its commit.
      expect(overrides.serverState).toEqual({ flash: "saved" });
      expect(hooks.locationState).not.toHaveBeenCalled();

      expect(onUpdate).toHaveBeenCalledTimes(1);
      const update = onUpdate.mock.calls[0][0];
      expect(update.root).toBe("tree-2");
      expect(update.onCommit).toBeUndefined();
      expect(renderSegments).toHaveBeenCalledTimes(1);
      const [rendered, options] = renderSegments.mock.calls[0] as unknown as [
        ResolvedSegment[],
        { forceAwait?: boolean },
      ];
      expect(rendered).toEqual([adoption.layout, adoption.filled]);
      // The fill is still streaming: nothing of it is awaited.
      expect(options.forceAwait).toBe(false);
      expect(store.cache.get("/product")!.segments).toEqual([
        adoption.layout,
        adoption.filled,
      ]);

      // No fill is pending afterwards: nothing more reaches React.
      await flush();
      expect(onUpdate).toHaveBeenCalledTimes(1);
    });

    it("keeps the streaming token open until that fill has streamed", async () => {
      const adoption = unitAdoption({ transition });
      const { navigate, fill, end } = setup(adoption);
      const navigation = navigate();
      await flush();
      expect(end).not.toHaveBeenCalled();

      const stream = deferred<void>();
      fill.resolve({
        ...fillPayload([adoption.filled], adoption.matched),
        streamComplete: stream.promise,
      });
      await navigation;
      await flush();
      expect(end).not.toHaveBeenCalled();

      stream.resolve();
      await flush();
      expect(end).toHaveBeenCalledTimes(1);
    });

    it("does not wait on a page whose deferred segments are loaders", async () => {
      const adoption = loaderAdoption();
      adoption.route.transition = transition as ResolvedSegment["transition"];
      const { navigate, onUpdate, tx } = setup(adoption);
      await navigate();

      expect(tx.commit).toHaveBeenCalledTimes(1);
      expect(onUpdate.mock.calls[0][0].root).toBe("tree-4");
    });

    it("fails as a navigation when its fill fails: nothing commits", async () => {
      const adoption = unitAdoption({ transition });
      const { navigate, fill, tx, onUpdate, end } = setup(adoption);
      const navigation = navigate();
      await flush();

      fill.reject(new Error("undecodable"));
      await expect(navigation).rejects.toThrow("undecodable");
      await flush();

      expect(tx.commit).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
      expect(end).toHaveBeenCalledTimes(1);
    });

    it("is redirected as a navigation when its fill answers with a redirect", async () => {
      stubLocation();
      const adoption = unitAdoption({ transition });
      const hooks = bridge();
      const { navigate, fill, tx, onUpdate } = setup(adoption, { fill: hooks });
      const navigation = navigate();
      await flush();

      fill.resolve({
        payload: {
          metadata: { redirect: { url: "/login" }, locationState: { a: 1 } },
        },
        streamComplete: Promise.resolve(),
      });
      const thrown = await navigation.then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(ServerRedirect);
      expect((thrown as ServerRedirect).url).toBe("http://localhost/login");
      expect((thrown as ServerRedirect).state).toEqual({ a: 1 });
      // The navigation's own redirect path follows it, not the fill's.
      expect(hooks.redirect).not.toHaveBeenCalled();
      expect(tx.commit).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    // The routes changed between the prefetch and the click (HMR, say): the
    // two answers do not make the page. A navigation whose own response
    // misses segments starts over with nothing held, and nothing of this
    // click has committed, so it does the same. Committed, the store would
    // list a segment as held that no tree has.
    it.each([
      [
        "names a segment neither answer carries",
        (adoption: ReturnType<typeof unitAdoption>) =>
          fillPayload([adoption.filled], [...adoption.matched, "L0R0D0.new"]),
      ],
      [
        "is not a partial payload",
        () => ({
          payload: { metadata: { isPartial: false } },
          streamComplete: Promise.resolve(),
        }),
      ],
    ])(
      "starts over as a plain navigation when its fill %s",
      async (_label, answer) => {
        const adoption = unitAdoption({ transition });
        const { navigate, fill, calls, tx, onUpdate } = setup(adoption, {
          whole: {
            metadata: {
              isPartial: true,
              segments: [adoption.layout, adoption.filled],
              matched: adoption.matched,
              diff: adoption.matched,
            },
          },
        });
        const navigation = navigate();
        await flush();
        expect(calls).toHaveLength(2);

        fill.resolve(answer(adoption));
        await navigation;

        expect(calls).toHaveLength(3);
        expect(calls[2]).toMatchObject({ targetUrl: URL_PAGE, segmentIds: [] });
        expect(calls[2].fill).toBeUndefined();
        expect(tx.commit).toHaveBeenCalledTimes(1);
        expect(tx.commit.mock.calls[0][0]).toEqual(adoption.matched);
        expect(onUpdate).toHaveBeenCalledTimes(1);
      },
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
    const hooks = bridge();
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

// The one answer that hands React a tree. A handler the fill awaited threw
// or called notFound(): its entry's segments are one error segment
// (router/segment-resolution/helpers.ts catchSegmentError), so the page is
// not the one the tree was built for. That is the outcome of the navigation.
describe("a fill whose segments are not the ones the tree was built for", () => {
  /** The route's handler threw: an error segment, and its loader is gone. */
  function failedRoute(adoption: ReturnType<typeof sectionAdoption>) {
    const failed = seg("L0L1R0", {
      type: "error",
      namespace: "page",
      component: "boundary",
    });
    const matched = ["L0", "L0L1D0.section", "L0L1", "L0L1.@side", "L0L1R0"];
    return {
      matched,
      response: fillPayload([...adoption.filled.slice(0, 3), failed], matched),
    };
  }

  it("replaces the page with the fill's segments in one update, and resolves no gate", async () => {
    const adoption = sectionAdoption();
    const hooks = bridge();
    const { navigate, fill, store, onUpdate, renderSegments } = setup(
      adoption,
      { fill: hooks },
    );
    await navigate();
    showAdoption(onUpdate);
    const gates = adoption.placeholders.map(gateOf);
    loaderStore.trackPendingStream("page", gates[3]);

    const { matched, response } = failedRoute(adoption);
    fill.resolve(response);
    await flush();

    // The click's update and this one.
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(renderSegments).toHaveBeenCalledTimes(2);
    const update = onUpdate.mock.calls[1][0];
    // No `scroll`: a fill is not a navigation transaction.
    expect(Object.keys(update).sort()).toEqual(["metadata", "root"]);
    expect(update.root).toBe("tree-5");
    // The update carries the handle stream: not read a second time.
    expect(update.metadata).toBe(response.payload.metadata);
    expect(hooks.handles).not.toHaveBeenCalled();

    for (const gate of gates) expect(await settled(gate)).toBe(false);
    expect(loaderStore.isStreamPending("page")).toBe(false);
    expect(store.cache.get("/product")!.segments.map((s) => s.id)).toEqual(
      matched,
    );
    expect(store.getSegmentIds()).toEqual(matched);
    // The tree's handle stream reads this array on every yield.
    expect(adoption.matched).toEqual(matched);
  });

  it("hands nothing over on a page that was left while its tree was built", async () => {
    const adoption = sectionAdoption();
    const rendering = deferred<string>();
    let renders = 0;
    const { navigate, fill, store, onUpdate } = setup(adoption, {
      renderSegments: () =>
        renders++ === 0 ? Promise.resolve("tree") : rendering.promise,
    });
    await navigate();
    showAdoption(onUpdate);

    fill.resolve(failedRoute(adoption).response);
    await flush();
    cancelPendingFill();
    rendering.resolve("failed");
    await flush();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(
      store.cache.get("/product")!.segments.filter((s) => s.deferred),
    ).toHaveLength(adoption.placeholders.length);
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
    const hooks = bridge();
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
    expect(hooks.handles).not.toHaveBeenCalled();
    // The adoption and the error.
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
    const hooks = bridge();
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
    const hooks = bridge();
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
      const hooks = bridge();
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
