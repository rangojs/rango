/**
 * `prefetch: false` in the browser (docs/design/prefetch-false.md, "The
 * browser"): a payload that carries deferred segments is the page with holes
 * in it. Its tree is built and committed once, with a deferred in place of
 * each missing value, and the navigation that committed it fills the holes
 * from one fill request: it resolves the deferreds and writes the stores, and
 * hands React nothing. The navigation's signal is what cancels the fill. Pins
 * browser/partial-update.ts (armHoles, fillHoles).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSegment } from "../browser/types";
import type { RenderSegmentsOptions } from "../segment-system";
import { NetworkError, ServerRedirect } from "../errors";

const transitionState = vi.hoisted(() => ({
  inTransition: false,
  types: [] as string[],
}));
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
    addTransitionType: (type: string) => transitionState.types.push(type),
  };
});
vi.mock("../browser/segment-structure-assert.js", () => ({
  assertSegmentStructure: vi.fn(),
}));

import {
  createPartialUpdater,
  type UpdateMode,
} from "../browser/partial-update";
import { LoaderStore } from "../loader-store";

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
    loaders: new LoaderStore(),
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
    mode?: UpdateMode;
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
    updater(URL_PAGE, undefined, false, signal, tx as any, options?.mode);
  /**
   * The click, up to its commit. An adopted click's navigation then waits for
   * its fill, which the test answers through `fill`.
   */
  const adopt = async (signal?: AbortSignal) => {
    const navigation = navigate(signal);
    await flush();
    return { navigation };
  };
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
    adopt,
  };
}

afterEach(() => {
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
  it("commits at once with a deferred as the loader's data", async () => {
    const adoption = loaderAdoption();
    const { adopt, onUpdate, store, tx } = setup(adoption);
    await adopt();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(adoption.reviews.loaderData).toBeInstanceOf(Promise);
    expect(adoption.reviews.deferred).toBe(true);
    // The store never reports a placeholder as held.
    expect(tx.commit.mock.calls[0][0]).toEqual(["L0", "L0R0", "L0R0D0.price"]);
    // The entry keeps the placeholder itself, so the fill can find it.
    expect(store.cache.get("/product")!.segments).toContain(adoption.reviews);
  });

  it("puts the deferred in a unit's component and keeps its fallback", async () => {
    const layout = seg("L0", { type: "layout", component: "layout" });
    const unit = seg("L0R0", {
      component: null,
      loading: "skeleton",
      deferred: true,
    });
    const { adopt, tx } = setup({
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
    await adopt();

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
    await waiting.adopt();
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

  it("sends exactly one fill, before the render returns, listing what the client holds, with the navigation's signal", async () => {
    const adoption = loaderAdoption();
    const rendering = deferred<string>();
    const { navigate, calls } = setup(adoption, {
      renderSegments: () => rendering.promise,
    });
    const signal = new AbortController().signal;
    void navigate(signal);
    await flush();

    // The render has not returned and the fill is already out.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      fill: true,
      targetUrl: URL_PAGE,
      previousUrl: URL_PAGE,
      segmentIds: ["L0", "L0R0", "L0R0D0.price"],
    });
    expect(calls[1].signal).toBe(signal);
    rendering.resolve("tree");
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
function sectionAdoption({ outer = false } = {}) {
  const layout = seg("L0", { type: "layout", component: "layout" });
  const hole = (id: string, overrides: Partial<ResolvedSegment>) =>
    seg(id, { component: null, deferred: true, ...overrides });
  const loader = (id: string, loaderId: string, namespace: string) => ({
    ...loaderSeg(id, loaderId),
    namespace,
  });
  const placeholders = [
    // A flagged loader of the held layout above: outside the section's unit.
    ...(outer ? [loader("L0D0.outer", "outer", "outer")] : []),
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

/** The deferred armHoles left on a placeholder, and the value a segment carries. */
const valueOf = (segment: ResolvedSegment): unknown =>
  segment.type === "loader" ? segment.loaderData : segment.component;
const holeOf = (placeholder: ResolvedSegment) =>
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

// A clientUrls() click presents its destination at the click
// (client-urls/navigation.ts) and then adopts the prefetch like any click. Its
// commit takes the lane the plain group click takes, a transition marked
// rango-optimistic-commit, and the presentation ends with that commit: the
// fill after it does not count toward useOutlet().pending
// (docs/design/prefetch-false.md, "`clientUrls()` routes").
describe("a clientUrls() click that presented its destination", () => {
  it("commits once in the optimistic-commit transition, clears the presentation after the hand-over and before the fill answers, then resolves the deferred", async () => {
    const adoption = loaderAdoption();
    const order: string[] = [];
    const presentation = { clear: vi.fn(() => order.push("clear")) };
    const run = setup(adoption, {
      fill: bridge(),
      mode: { type: "navigate", presentation },
    });
    transitionState.types.length = 0;
    run.onUpdate.mockImplementation(() =>
      order.push(
        transitionState.inTransition
          ? `transition:${transitionState.types.join(",")}`
          : "urgent",
      ),
    );
    const { navigation } = await run.adopt();

    expect(order).toEqual(["transition:rango-optimistic-commit", "clear"]);
    expect(run.onUpdate).toHaveBeenCalledTimes(1);
    expect(presentation.clear).toHaveBeenCalledTimes(1);
    const deferredRead = adoption.reviews.loaderData as Promise<unknown>;
    expect(await settled(deferredRead)).toBe(false);

    run.fill.resolve(
      fillPayload(
        [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
        adoption.matched,
      ),
    );
    await navigation;
    await expect(deferredRead).resolves.toEqual({ reviews: 5 });
    expect(run.onUpdate).toHaveBeenCalledTimes(1);
    expect(presentation.clear).toHaveBeenCalledTimes(1);
  });

  it("clears the presentation with the commit of a click with no holes too", async () => {
    const adoption = loaderAdoption();
    adoption.reviews.loaderData = { reviews: 1 };
    delete adoption.reviews.deferred;
    const order: string[] = [];
    const presentation = { clear: vi.fn(() => order.push("clear")) };
    const run = setup(adoption, {
      mode: { type: "navigate", presentation },
    });
    run.onUpdate.mockImplementation(() =>
      order.push(transitionState.inTransition ? "transition" : "urgent"),
    );
    await run.navigate();

    expect(order).toEqual(["transition", "clear"]);
    expect(run.calls).toHaveLength(1);
  });
});

describe("the fill landing", () => {
  it("rewrites the entry in place, updates the held ids and resolves the deferred", async () => {
    const adoption = loaderAdoption();
    const { adopt, fill, store } = setup(adoption);
    const { navigation } = await adopt();
    const entry = store.cache.get("/product")!.segments;
    const hole = adoption.reviews.loaderData as Promise<unknown>;

    const filled = loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 });
    fill.resolve(fillPayload([filled], adoption.matched));
    await navigation;

    // Same array: the fill belongs to the visit that adopted.
    expect(store.cache.get("/product")!.segments).toBe(entry);
    expect(entry.map((s) => s.id)).toEqual(adoption.matched);
    expect(entry).toContain(filled);
    expect(entry.some((s) => s.deferred)).toBe(false);
    expect(store.cacheSegmentsForHistory).not.toHaveBeenCalled();
    expect(store.getSegmentIds()).toEqual(adoption.matched);
    await expect(hole).resolves.toEqual({ reviews: 5 });
    // The tree on screen reads the deferred. The entry keeps the fill's stream.
    expect(filled.loaderData).toEqual({ reviews: 5 });
  });

  // The model: the click builds the page's tree and commits it, and the
  // navigation then waits for its fill and resolves what the tree is waiting
  // for. Updates that hand React a tree belong to navigations and actions.
  // The same counts as a plain click's: one update, one tree ("sends no fill
  // for a payload with nothing deferred" above reads 1).
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
  it.each(adoptions)(
    "hands React one tree and one update for the click that adopts %s",
    async (_label, build) => {
      const adoption = build();
      const hooks = bridge();
      const { adopt, fill, store, onUpdate, renderSegments } = setup(adoption, {
        fill: hooks,
      });
      const { navigation } = await adopt();
      const placeholders = (
        adoption.payload.metadata.segments as ResolvedSegment[]
      ).filter((s) => s.deferred);
      const holes = placeholders.map(holeOf);

      const response = fillPayload(adoption.filled, adoption.matched);
      fill.resolve(response);
      await navigation;

      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(renderSegments).toHaveBeenCalledTimes(1);
      // What the fill's handlers pushed goes to the handle store.
      expect(hooks.handles).toHaveBeenCalledTimes(1);
      expect(hooks.handles).toHaveBeenCalledWith(response.payload.metadata);
      // Every hole of the tree got the fill's value for its segment.
      for (const [index, placeholder] of placeholders.entries()) {
        const brought = adoption.filled.find((s) => s.id === placeholder.id)!;
        await expect(holes[index], placeholder.id).resolves.toEqual(
          valueOf(brought),
        );
      }
      // The entry holds the fill's own segments, not the placeholders: the
      // next render from this page builds on streams and nodes, and a
      // deferred is a promise React has read only where a reader was on
      // screen.
      const entry = store.cache.get("/product")!.segments;
      expect(entry.some((s) => s.deferred)).toBe(false);
      for (const brought of adoption.filled) expect(entry).toContain(brought);
      for (const segment of entry) {
        expect(holes, segment.id).not.toContain(valueOf(segment));
      }
    },
  );

  it("reads nothing of a fill that answers before the commit until the commit", async () => {
    const adoption = loaderAdoption();
    const rendering = deferred<string>();
    const { navigate, fill, store, onUpdate } = setup(adoption, {
      renderSegments: () => rendering.promise,
    });
    const navigation = navigate();
    await flush();
    let resolved = false;
    void (adoption.reviews.loaderData as Promise<unknown>).then(() => {
      resolved = true;
    });
    fill.resolve(
      fillPayload(
        [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
        adoption.matched,
      ),
    );
    await flush();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(resolved).toBe(false);
    expect(store.cache.has("/product")).toBe(false);

    rendering.resolve("tree");
    await navigation;
    expect(resolved).toBe(true);
    expect(store.cache.get("/product")!.segments.some((s) => s.deferred)).toBe(
      false,
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  // A deferred resolves with the answer's own stream or node and follows it.
  // Nothing waits for another stream, for the end of the response, or for
  // React to commit the tree.
  describe("while its response is still streaming", () => {
    const streaming = (response: ReturnType<typeof fillPayload>) => {
      const stream = deferred<void>();
      return {
        stream,
        response: { ...response, streamComplete: stream.promise },
      };
    };

    it("resolves the deferreds with its first chunk, and hands over what was pushed and the state that was set", async () => {
      const adoption = loaderAdoption();
      const hooks = bridge();
      const { adopt, fill, store, onUpdate } = setup(adoption, {
        fill: hooks,
      });
      const { navigation } = await adopt();

      const { response } = streaming(
        fillPayload(
          [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
          adoption.matched,
        ),
      );
      (response.payload.metadata as any).locationState = { flash: "saved" };
      fill.resolve(response);
      await navigation;

      await expect(adoption.reviews.loaderData).resolves.toEqual({
        reviews: 5,
      });
      expect(hooks.handles).toHaveBeenCalledWith(response.payload.metadata);
      expect(hooks.locationState).toHaveBeenCalledWith({ flash: "saved" });
      expect(
        store.cache.get("/product")!.segments.some((s) => s.deferred),
      ).toBe(false);
      expect(onUpdate).toHaveBeenCalledTimes(1);
    });

    // A flagged layout's deferreds are resolved in one task with the rest,
    // each with its own value: the layout's own loader, still streaming,
    // holds nothing else back, and its deferred follows its stream. What
    // shows meanwhile is React's (the nearest boundary of each read).
    it("resolves a layout unit's deferreds at once, each following its own value", async () => {
      const adoption = sectionAdoption({ outer: true });
      const { adopt, fill, store } = setup(adoption);
      const { navigation } = await adopt();
      const resolved = new Set<string>();
      for (const placeholder of adoption.placeholders) {
        void holeOf(placeholder).then(() => resolved.add(placeholder.id));
      }
      const own = deferred<unknown>();
      const filled = adoption.filled.map((s) =>
        s.id === "L0L1D0.section" ? { ...s, loaderData: own.promise } : s,
      );

      const { response } = streaming(fillPayload(filled, adoption.matched));
      fill.resolve(response);
      await navigation;
      await flush();

      expect([...resolved].sort()).toEqual(
        adoption.placeholders
          .map((s) => s.id)
          .filter((id) => id !== "L0L1D0.section")
          .sort(),
      );
      expect(
        store.cache.get("/product")!.segments.some((s) => s.deferred),
      ).toBe(false);

      own.resolve({ section: 1 });
      await flush();
      expect(resolved.size).toBe(adoption.placeholders.length);
      await expect(holeOf(adoption.placeholders[1]!)).resolves.toEqual({
        section: 1,
      });
    });

    it("resolves the deferreds when the stream later fails: what arrived is shown, the rest is the stream's error", async () => {
      const adoption = loaderAdoption();
      const { adopt, fill, store } = setup(adoption);
      const { navigation } = await adopt();

      const { stream, response } = streaming(
        fillPayload(
          [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
          adoption.matched,
        ),
      );
      fill.resolve(response);
      await navigation;
      stream.reject(new Error("cut"));
      await flush();
      expect(
        store.cache.get("/product")!.segments.some((s) => s.deferred),
      ).toBe(false);
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
      const { adopt, onUpdate, tx } = setup(adoption);
      await adopt();

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
    const { adopt, fill, end } = setup(adoption);
    const { navigation } = await adopt();
    expect(end).not.toHaveBeenCalled();

    const fillStream = deferred<void>();
    fill.resolve({
      ...fillPayload(
        [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
        adoption.matched,
      ),
      streamComplete: fillStream.promise,
    });
    await navigation;
    await flush();
    expect(end).not.toHaveBeenCalled();

    fillStream.resolve();
    await flush();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("hands the location state the server set to the bridge", async () => {
    const adoption = loaderAdoption();
    const hooks = bridge();
    const { adopt, fill } = setup(adoption, { fill: hooks });
    const { navigation } = await adopt();
    const response = fillPayload(
      [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
      adoption.matched,
    );
    (response.payload.metadata as any).locationState = { flash: "saved" };
    fill.resolve(response);
    await navigation;

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

  // A boundary that suspended on its deferred while it mounted, rendered
  // again with a node in its place, is a component that called use() and
  // then did not: React reports it in development. So the new tree hands
  // such a boundary its deferred, settled with the answer's node.
  it("replaces the page with the fill's segments in one update, handing each boundary its deferred settled", async () => {
    const adoption = sectionAdoption();
    const hooks = bridge();
    const { adopt, fill, store, onUpdate, renderSegments } = setup(adoption, {
      fill: hooks,
    });
    const { navigation } = await adopt();
    const holes = adoption.placeholders.map(holeOf);
    store.loaders.trackPendingStream("page", holes[3]);

    const { matched, response } = failedRoute(adoption);
    fill.resolve(response);
    await navigation;

    // The click's update and this one.
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(renderSegments).toHaveBeenCalledTimes(2);
    const update = onUpdate.mock.calls[1][0];
    // No `scroll`: the click's update carried the navigation's decision.
    expect(Object.keys(update).sort()).toEqual(["metadata", "root"]);
    expect(update.root).toBe("tree-5");
    // The update carries the handle stream: not read a second time.
    expect(update.metadata).toBe(response.payload.metadata);
    expect(hooks.handles).not.toHaveBeenCalled();

    expect(await settled(holes[0]!)).toBe(false);
    expect(await settled(holes[3]!)).toBe(false);
    const rendered = renderSegments.mock.calls[1]![0] as ResolvedSegment[];
    for (const [index, value] of [
      [1, "content-L0L1"],
      [2, "content-L0L1.@side"],
      [4, "boundary"],
    ] as const) {
      const hole = holes[index]!;
      expect(hole).toMatchObject({ status: "fulfilled", value });
      expect(await hole).toBe(value);
      const id = adoption.placeholders[index]!.id;
      expect(rendered.find((s) => s.id === id)!.component).toBe(hole);
    }
    expect(store.loaders.isStreamPending("page")).toBe(false);
    expect(store.cache.get("/product")!.segments.map((s) => s.id)).toEqual(
      matched,
    );
    expect(store.getSegmentIds()).toEqual(matched);
    // The tree's handle stream reads this array on every yield.
    expect(adoption.matched).toEqual(matched);
  });

  it("hands nothing over when its navigation is aborted while that tree is built", async () => {
    const adoption = sectionAdoption();
    const rendering = deferred<string>();
    let renders = 0;
    const { adopt, fill, store, onUpdate } = setup(adoption, {
      renderSegments: () =>
        renders++ === 0 ? Promise.resolve("tree") : rendering.promise,
    });
    const controller = new AbortController();
    const { navigation } = await adopt(controller.signal);

    fill.resolve(failedRoute(adoption).response);
    await flush();
    controller.abort();
    rendering.resolve("failed");
    await navigation;

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(
      store.cache.get("/product")!.segments.filter((s) => s.deferred),
    ).toHaveLength(adoption.placeholders.length);
  });
});

// The navigation that committed the tree owns its fill: its signal, which a
// newer navigation or a back/forward aborts (event-controller.ts), is the one
// thing that cancels it. Nothing else tracks a pending fill.
describe("a fill its navigation is left before it lands", () => {
  it("is aborted before its response: nothing resolves, and the deferreds stop being pending streams", async () => {
    const adoption = loaderAdoption();
    const { adopt, calls, onUpdate, end, store } = setup(adoption);
    const controller = new AbortController();
    const { navigation } = await adopt(controller.signal);
    const hole = adoption.reviews.loaderData as Promise<unknown>;
    store.loaders.trackPendingStream("reviews", hole);
    expect(store.loaders.isStreamPending("reviews")).toBe(true);

    controller.abort();
    await navigation;
    await flush();

    expect(calls[1].signal?.aborted).toBe(true);
    expect(await settled(hole)).toBe(false);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(store.loaders.isStreamPending("reviews")).toBe(false);
    // The streaming token is not left open by a fill that never lands (it
    // ends at the abort; StreamingToken counts the first end()).
    expect(end).toHaveBeenCalled();
    // The placeholder stays: history treats the entry as a miss.
    expect(store.cache.get("/product")!.segments).toContain(adoption.reviews);
    expect(store.setSegmentIds).toHaveBeenCalledTimes(1);
  });

  it("drops a response that arrives after the abort", async () => {
    const adoption = unitAdoption();
    const hooks = bridge();
    const { adopt, fill, onUpdate, store } = setup(adoption, { fill: hooks });
    const controller = new AbortController();
    const { navigation } = await adopt(controller.signal);
    const hole = holeOf(adoption.unit);

    const response = fillPayload([adoption.filled], adoption.matched);
    (response.payload.metadata as any).locationState = { flash: "saved" };
    fill.resolve(response);
    controller.abort();
    await navigation;

    expect(await settled(hole)).toBe(false);
    expect(hooks.handles).not.toHaveBeenCalled();
    expect(hooks.locationState).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(store.cache.get("/product")!.segments).toContain(adoption.unit);
  });

  it("leaves a failure unshown once aborted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const { adopt, fill, onUpdate } = setup(adoption);
    const controller = new AbortController();
    const { navigation } = await adopt(controller.signal);

    controller.abort();
    fill.reject(new TypeError("Failed to fetch"));
    await navigation;

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  // Nothing tracks the fill of an adoption that never committed: its answer
  // is not read.
  it("reads nothing of the fill of an adoption that never commits", async () => {
    const adoption = loaderAdoption();
    const { navigate, fill, tx, onUpdate, store } = setup(adoption, {
      renderSegments: () => Promise.reject(new Error("render failed")),
    });
    await expect(navigate()).rejects.toThrow("render failed");

    fill.resolve(
      fillPayload(
        [loaderSeg("L0R0D1.reviews", "reviews", { reviews: 5 })],
        adoption.matched,
      ),
    );
    await flush();
    expect(tx.commit).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(await settled(adoption.reviews.loaderData as Promise<unknown>)).toBe(
      false,
    );
    expect(store.setSegmentIds).not.toHaveBeenCalled();
  });
});

describe("a fill that does not land", () => {
  it("is dropped when the entry no longer holds the placeholders", async () => {
    const adoption = loaderAdoption();
    const { adopt, fill, store, onUpdate } = setup(adoption);
    const { navigation } = await adopt();
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
    await navigation;

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(store.cache.get("/product")!.segments).toContain(fromAction);
  });

  // A fill the client cannot use ends like a navigation it cannot process
  // (navigation-bridge.ts): the error replaces the page, so an error boundary
  // takes over. The deferreds are released, never rejected: a rejected one is
  // an unhandled rejection of every aggregate built over it
  // (segment-loader-promise.ts).
  it("shows a response it cannot use as an error, and settles no deferred", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const { adopt, fill, onUpdate, store } = setup(adoption);
    const { navigation } = await adopt();
    const hole = adoption.reviews.loaderData as Promise<unknown>;
    store.loaders.trackPendingStream("reviews", hole);

    // Lists a segment the client does not hold and does not send it.
    fill.resolve(fillPayload([], [...adoption.matched, "L0R0D2.extra"]));
    await navigation;

    expect(errorOf(onUpdate)).toBe(
      "[rango] fill: missing segments [L0R0D1.reviews, L0R0D2.extra]",
    );
    expect(await settled(hole)).toBe(false);
    expect(store.loaders.isStreamPending("reviews")).toBe(false);
  });

  // Checked before anything is handed over: the adoption's `matched`, the
  // location state and the handle data of a response the client then
  // refuses would stay behind under the error.
  it("hands nothing over from a response it cannot use", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const hooks = bridge();
    const { adopt, fill, onUpdate } = setup(adoption, { fill: hooks });
    const { navigation } = await adopt();
    const matched = [...adoption.matched];

    const response = fillPayload([], [...matched, "L0R0D2.extra"]);
    (response.payload.metadata as any).locationState = { flash: "saved" };
    fill.resolve(response);
    await navigation;

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
    const { adopt, fill, onUpdate } = setup(adoption);
    const { navigation } = await adopt();

    fill.resolve({
      payload: { metadata: { segments: [] } },
      streamComplete: Promise.resolve(),
    });
    await navigation;

    expect(errorOf(onUpdate)).toBe("[rango] fill: not a partial payload");
  });

  it("shows a failure only after the adoption has committed", async () => {
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
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(errorOf(onUpdate)).toBe("undecodable");
  });

  it("shows no failure on a page that no longer waits for the fill", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const { adopt, fill, store, onUpdate } = setup(adoption);
    const { navigation } = await adopt();
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
    await navigation;

    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("sends a network failure to the network error boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adoption = loaderAdoption();
    const { adopt, fill, onUpdate } = setup(adoption);
    const { navigation } = await adopt();

    // What fetch() throws when the network drops, not a NetworkError yet: the
    // network error page is picked by the error's class.
    fill.reject(new TypeError("Failed to fetch"));
    await navigation;

    expect(onUpdate).toHaveBeenCalledTimes(2);
    const update = onUpdate.mock.calls[1][0];
    expect(update.metadata.isError).toBe(true);
    expect(update.root.props.error).toBeInstanceOf(NetworkError);
  });

  // An action refetch already rendered what the placeholders stand for: the
  // page no longer waits for this fill, and a redirect it answers with is
  // nobody's to follow, as its failure is nobody's to show.
  it.each([
    [
      "of the whole response",
      (fill: ReturnType<typeof setup>["fill"]) =>
        fill.reject(new ServerRedirect("/login", undefined)),
    ],
    [
      "carried in the payload",
      (fill: ReturnType<typeof setup>["fill"]) =>
        fill.resolve({
          payload: { metadata: { redirect: { url: "/login" } } },
          streamComplete: Promise.resolve(),
        }),
    ],
  ])(
    "follows no redirect %s on a page that no longer waits for the fill",
    async (_label, answer) => {
      const assign = stubLocation();
      const adoption = loaderAdoption();
      const hooks = bridge();
      const { adopt, fill, store, onUpdate } = setup(adoption, {
        fill: hooks,
      });
      const { navigation } = await adopt();
      store.cache.set("/product", {
        segments: [
          adoption.layout,
          adoption.route,
          adoption.price,
          loaderSeg("L0R0D1.reviews", "reviews", { reviews: 9 }),
        ],
        stale: false,
      });

      answer(fill);
      await navigation;

      expect(hooks.redirect).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalledTimes(1);
    },
  );

  it("follows a redirect of the whole response through the bridge", async () => {
    stubLocation();
    const adoption = loaderAdoption();
    const hooks = bridge();
    const { adopt, fill, onUpdate } = setup(adoption, { fill: hooks });
    const { navigation } = await adopt();

    fill.reject(new ServerRedirect("/login", { from: "product" }));
    await navigation;

    expect(hooks.redirect).toHaveBeenCalledWith("http://localhost/login", {
      from: "product",
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect carried in the payload", async () => {
    stubLocation();
    const adoption = loaderAdoption();
    const hooks = bridge();
    const { adopt, fill } = setup(adoption, { fill: hooks });
    const { navigation } = await adopt();

    fill.resolve({
      payload: { metadata: { redirect: { url: "/login" } } },
      streamComplete: Promise.resolve(),
    });
    await navigation;

    expect(hooks.redirect).toHaveBeenCalledWith(
      "http://localhost/login",
      undefined,
    );
  });

  it("leaves by a document navigation when no bridge follows redirects", async () => {
    const assign = stubLocation();
    const adoption = loaderAdoption();
    const { adopt, fill } = setup(adoption);
    const { navigation } = await adopt();

    fill.reject(new ServerRedirect("/login", undefined));
    await navigation;

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
      const { adopt, fill, onUpdate } = setup(adoption, { fill: hooks });
      const { navigation } = await adopt();

      response().then(fill.resolve, fill.reject);
      await navigation;

      expect(hooks.redirect).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(errorOf(onUpdate)).toBe("[rango] fill: redirect not followed");
    });
  });
});

describe("a page that holds placeholders", () => {
  it("does not offer a placeholder as a held copy to the next navigation", async () => {
    const adoption = loaderAdoption();
    const { adopt, store, client } = setup(adoption);
    const controller = new AbortController();
    const { navigation } = await adopt(controller.signal);
    // Left before its fill landed.
    controller.abort();
    await navigation;

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
