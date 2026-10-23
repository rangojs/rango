import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventController } from "../browser/event-controller";
import { createServerActionBridge } from "../browser/server-action-bridge";
import { renderSegments } from "../segment-system";
import { LoaderStore } from "../loader-store";
import { Defer } from "../browser/defer";
import { __resetActionFence } from "../browser/action-fence";

function createMockStore() {
  return {
    getSegmentState: vi.fn(() => ({
      path: "/",
      currentUrl: "http://localhost/",
      currentSegmentIds: ["R0"],
    })),
    markCacheAsStaleAndBroadcast: vi.fn(),
    getInterceptSourceUrl: vi.fn(() => null),
    getHistoryEntryMemory: vi.fn(() => undefined),
  };
}

function stubWindow() {
  vi.stubGlobal("window", {
    location: {
      href: "http://localhost/",
      pathname: "/",
      origin: "http://localhost",
    },
    history: {
      state: { key: "k1" },
      replaceState: vi.fn(),
    },
    dispatchEvent: vi.fn(),
  });
}

function setupBridge(
  payload: unknown,
  onNavigate = vi.fn(async () => {}),
  store = createMockStore(),
) {
  const eventController = createEventController();
  const setServerCallback = vi.fn();

  const deps = {
    createTemporaryReferenceSet: vi.fn(() => ({})),
    encodeReply: vi.fn(async () => ""),
    createFromFetch: vi.fn(async () => payload),
    setServerCallback,
  };

  const bridge = createServerActionBridge({
    store: store as any,
    client: {} as any,
    eventController,
    deps: deps as any,
    onUpdate: vi.fn(),
    renderSegments: vi.fn(async () => "tree"),
    onNavigate,
  });
  bridge.register();

  const callback = setServerCallback.mock.calls[0]?.[0] as
    | ((id: string, args: any[]) => Promise<unknown>)
    | undefined;

  if (!callback) {
    throw new Error("Expected setServerCallback to be called");
  }

  return { callback, onNavigate };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("server-action-bridge partial invariant", () => {
  it("rejects non-partial action response", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { callback } = setupBridge({
      metadata: {
        pathname: "/",
        segments: [{ id: "R0", component: "div" }],
        matched: ["R0"],
        diff: ["R0"],
        // isPartial is intentionally omitted
      },
      returnValue: { ok: true, data: "done" },
    });

    await expect(callback("hash#save", [])).rejects.toThrow(
      /Action response missing isPartial/,
    );
  });

  it("accepts partial action response", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const { callback } = setupBridge({
      metadata: {
        pathname: "/",
        segments: [{ id: "R0", component: "div" }],
        matched: ["R0"],
        diff: ["R0"],
        isPartial: true,
      },
      returnValue: { ok: true, data: "result" },
    });

    // The partial payload passes the isPartial guard. It will fail later
    // on store.getHistoryKey (not mocked), but the invariant error is
    // distinct — verify we do NOT get the isPartial rejection.
    await expect(callback("hash#save", [])).rejects.toThrow(
      /getHistoryKey is not a function/,
    );
    await expect(callback("hash#save", [])).rejects.not.toThrow(
      /Action response missing isPartial/,
    );
  });
});

describe("server-action-bridge rewrite target", () => {
  it("names the page's rewrite target (_rsc_rt) on the action request", async () => {
    stubWindow();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createMockStore();
    store.getHistoryEntryMemory.mockReturnValue({
      routeName: "item",
      rewriteTarget: "/item/1?sort=a",
      state: null,
    } as any);

    const { callback } = setupBridge({ metadata: {} }, undefined, store);
    await callback("hash#save", []).catch(() => {});

    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get("_rsc_rt")).toBe("/item/1?sort=a");
  });
});

// An action does not change the history entry or wait for a tree: its
// location state is a treeless commit of the merged entry, flushed at once,
// so readers have it when the response is processed, ahead of the revalidated
// tree.
describe("server-action-bridge location state", () => {
  it("commits the action's slots as treeless, on top of what readers hold, and flushes before the action's tree renders", async () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/",
        pathname: "/",
        origin: "http://localhost",
      },
      history: { state: { key: "k1" }, replaceState },
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const segment = { id: "R0", type: "route", component: "div" };
    const store = {
      ...createMockStore(),
      getHistoryKey: vi.fn(() => "/"),
      getCachedSegments: vi.fn(() => ({ segments: [segment], stale: false })),
      setSegmentIds: vi.fn(),
      cacheSegmentsForHistory: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      getHistoryEntryMemory: vi.fn(() => undefined),
      getRouterId: vi.fn(() => undefined),
    };
    const eventController = createEventController();
    // A flash value on screen: committed with the entry, cleared from
    // history since (window.history.state above holds no slot).
    eventController.commitLocationState({ __rsc_ls_flash: { text: "saved" } });
    const shownFlash = eventController.getLocationState()!.__rsc_ls_flash;
    const order: string[] = [];
    // NavigationProvider's listener: takes a treeless commit when notified.
    eventController.subscribe(() => {
      if (eventController.takeTreelessLocationState()) {
        order.push("provider took the state");
      }
    });
    const setServerCallback = vi.fn();
    createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController,
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async () => ({
          metadata: {
            pathname: "/",
            segments: [segment],
            matched: ["R0"],
            diff: ["R0"],
            isPartial: true,
            locationState: { __rsc_ls_note: "from-action" },
          },
          returnValue: { ok: true, data: "done" },
        })),
        setServerCallback,
      } as any,
      onUpdate: vi.fn(() => void order.push("tree committed")),
      renderSegments: vi.fn(async () => {
        order.push("tree rendered");
        return "tree";
      }),
    }).register();

    await expect(
      setServerCallback.mock.calls[0]![0]("hash#save", []),
    ).resolves.toBe("done");

    expect(replaceState.mock.calls[0]![0]).toMatchObject({
      __rsc_ls_note: "from-action",
    });
    // Added to what readers hold, not re-read from the entry: the flash
    // value stays, as the object its reader has.
    expect(eventController.getLocationState()).toEqual({
      __rsc_ls_flash: { text: "saved" },
      __rsc_ls_note: "from-action",
    });
    expect(eventController.getLocationState()!.__rsc_ls_flash).toBe(shownFlash);
    expect(order.slice(0, 3)).toEqual([
      "provider took the state",
      "tree rendered",
      "tree committed",
    ]);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });
});

describe("server-action-bridge redirect payload validation", () => {
  it("allows same-origin redirect payload", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const { callback, onNavigate } = setupBridge({
      metadata: {
        redirect: { url: "/safe" },
        locationState: { __rsc_ls_flash: "ok" },
      },
      returnValue: { ok: true, data: "done" },
    });

    const result = await callback("hash#save", []);

    expect(onNavigate).toHaveBeenCalledWith("http://localhost/safe", {
      state: { __rsc_ls_flash: "ok" },
      replace: true,
      _skipCache: true,
    });
    expect(result).toBe("done");
  });

  it("blocks cross-origin redirect payload", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { callback, onNavigate } = setupBridge({
      metadata: {
        redirect: { url: "https://evil.example/phish" },
      },
      returnValue: { ok: true, data: "done" },
    });

    const result = await callback("hash#save", []);

    expect(onNavigate).not.toHaveBeenCalled();
    expect(result).toBe("done");
  });
});

describe("server-action-bridge revalidation render failure", () => {
  // The action commit's renderSegments rejects (a segment that failed to
  // build); the call rejects with it. A loader that throws on its rerun does
  // not get here: it throws at its read (below).
  it("records the rejection as the action's error", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const segment = { id: "R0", type: "route", component: "div" };
    const store = {
      ...createMockStore(),
      getHistoryKey: vi.fn(() => "/"),
      getCachedSegments: vi.fn(() => ({ segments: [segment], stale: false })),
      setSegmentIds: vi.fn(),
      cacheSegmentsForHistory: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      getHistoryEntryMemory: vi.fn(() => undefined),
      getRouterId: vi.fn(() => undefined),
    };
    const eventController = createEventController();
    const setServerCallback = vi.fn();
    const renderError = new Error("stock service unavailable");
    createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController,
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async () => ({
          metadata: {
            pathname: "/",
            segments: [segment],
            matched: ["R0"],
            diff: ["R0"],
            isPartial: true,
          },
          returnValue: { ok: true, data: "saved" },
        })),
        setServerCallback,
      } as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => {
        throw renderError;
      }),
    }).register();

    await expect(
      setServerCallback.mock.calls[0]![0]("hash#save", []),
    ).rejects.toBe(renderError);
    await vi.waitFor(() =>
      expect(eventController.getActionState("save")).toMatchObject({
        state: "idle",
        error: renderError,
      }),
    );
  });
});

describe("server-action-bridge loader that fails on its rerun", () => {
  // The action ran and returned; a loader it revalidates threw. The commit is
  // built by the real renderSegments, whose action lane hands the failed
  // entry to its read site instead of decoding it in the build: the call
  // resolves with the action's result, the commit carries the server's entry
  // (the loader throws in place at its useLoader read), the page holds the
  // loader as after any rerun, and useAction reports the failure apart from
  // `error`.
  it("resolves the call, commits the failed entry for its read site, and reports revalidationError", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const route = { id: "R0", type: "route", component: "div" };
    const held = {
      id: "R0D0.stock",
      type: "loader",
      loaderId: "stock",
      loaderData: Promise.resolve({
        __loaderResult: true,
        ok: true,
        data: "stock:1",
      }),
    };
    const failed = {
      ...held,
      loaderData: Promise.resolve({
        __loaderResult: true,
        ok: false,
        error: { message: "stock service unavailable" },
        fallback: null,
      }),
    };
    const store = {
      ...createMockStore(),
      getHistoryKey: vi.fn(() => "/"),
      getCachedSegments: vi.fn(() => ({
        segments: [route, held],
        stale: false,
      })),
      setSegmentIds: vi.fn(),
      cacheSegmentsForHistory: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      getHistoryEntryMemory: vi.fn(() => undefined),
      getRouterId: vi.fn(() => undefined),
    };
    const eventController = createEventController();
    const setServerCallback = vi.fn();
    const rendered: unknown[][] = [];
    const onUpdate = vi.fn();
    createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController,
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async () => ({
          metadata: {
            pathname: "/",
            segments: [route, failed],
            matched: ["R0", "R0D0.stock"],
            diff: ["R0", "R0D0.stock"],
            resolvedIds: ["R0", "R0D0.stock"],
            isPartial: true,
          },
          returnValue: { ok: true, data: "saved" },
        })),
        setServerCallback,
      } as any,
      onUpdate,
      renderSegments: async (segments: any[], options: any) => {
        rendered.push(segments);
        return renderSegments(segments, options);
      },
    }).register();

    await expect(
      setServerCallback.mock.calls[0]![0]("hash#save", []),
    ).resolves.toBe("saved");

    expect(rendered[0]![1]).toBe(failed);
    expect(store.cacheSegmentsForHistory.mock.calls[0]![1][1]).toBe(failed);
    expect(store.setSegmentIds).toHaveBeenCalledWith(["R0", "R0D0.stock"]);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(eventController.getActionState("save")).toMatchObject({
        state: "idle",
        error: null,
        result: "saved",
        revalidationError: expect.objectContaining({
          message: "stock service unavailable",
        }),
      }),
    );
  });

  it("reports no revalidationError for a notFound() signal or a rerun that succeeds", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const route = { id: "R0", type: "route", component: "div" };
    const loader = (id: string, entry: unknown) => ({
      id: `R0D${id}`,
      type: "loader",
      loaderId: id,
      loaderData: Promise.resolve(entry),
    });
    const segments = [
      route,
      loader("0.stock", { __loaderResult: true, ok: true, data: 1 }),
      loader("1.item", {
        __loaderResult: true,
        ok: false,
        notFound: true,
        error: { message: "gone" },
        fallback: null,
      }),
    ];
    const store = {
      ...createMockStore(),
      getHistoryKey: vi.fn(() => "/"),
      getCachedSegments: vi.fn(() => ({ segments, stale: false })),
      setSegmentIds: vi.fn(),
      cacheSegmentsForHistory: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      getHistoryEntryMemory: vi.fn(() => undefined),
      getRouterId: vi.fn(() => undefined),
    };
    const eventController = createEventController();
    const setServerCallback = vi.fn();
    createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController,
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async () => ({
          metadata: {
            pathname: "/",
            segments,
            matched: segments.map((s) => s.id),
            diff: segments.map((s) => s.id),
            isPartial: true,
          },
          returnValue: { ok: true, data: "saved" },
        })),
        setServerCallback,
      } as any,
      onUpdate: vi.fn(),
      renderSegments,
    }).register();

    await expect(
      setServerCallback.mock.calls[0]![0]("hash#save", []),
    ).resolves.toBe("saved");
    await vi.waitFor(() =>
      expect(eventController.getActionState("save")).toMatchObject({
        state: "idle",
        result: "saved",
        revalidationError: null,
      }),
    );
  });
});

describe("server-action-bridge action on a page with a prefetch: false hole", () => {
  // The page adopted a prefetch: false prefetch and its fill has not landed:
  // one loader is a hole (browser/partial-update.ts armHoles). An action that
  // revalidates a sibling loader, which throws, commits without waiting for
  // the hole: the action lane leaves a placeholder for its read site
  // (dc-d141: no router wait), and the report skips it.
  it("commits and resolves while the hole is still pending", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const route = { id: "R0", type: "route", component: "div" };
    const held = {
      id: "R0D0.stock",
      type: "loader",
      loaderId: "stock",
      loaderData: Promise.resolve({
        __loaderResult: true,
        ok: true,
        data: "stock:1",
      }),
    };
    const hole = {
      id: "R0D1.price",
      type: "loader",
      loaderId: "price",
      deferred: true,
      loaderData: new Defer<unknown>(),
    };
    const failed = {
      ...held,
      loaderData: Promise.resolve({
        __loaderResult: true,
        ok: false,
        error: { message: "stock service unavailable" },
        fallback: null,
      }),
    };
    const store = {
      ...createMockStore(),
      loaders: new LoaderStore(),
      getHistoryKey: vi.fn(() => "/"),
      getCachedSegments: vi.fn(() => ({
        segments: [route, held, hole],
        stale: false,
      })),
      setSegmentIds: vi.fn(),
      cacheSegmentsForHistory: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      getHistoryEntryMemory: vi.fn(() => undefined),
      getRouterId: vi.fn(() => undefined),
    };
    const eventController = createEventController();
    const setServerCallback = vi.fn();
    const onUpdate = vi.fn();
    createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController,
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async () => ({
          metadata: {
            pathname: "/",
            segments: [route, failed],
            matched: ["R0", "R0D0.stock", "R0D1.price"],
            diff: ["R0", "R0D0.stock"],
            resolvedIds: ["R0", "R0D0.stock"],
            isPartial: true,
          },
          returnValue: { ok: true, data: "saved" },
        })),
        setServerCallback,
      } as any,
      onUpdate,
      renderSegments,
    }).register();

    await expect(
      setServerCallback.mock.calls[0]![0]("hash#save", []),
    ).resolves.toBe("saved");
    expect(hole.loaderData.status).toBe("pending");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const committed = store.cacheSegmentsForHistory.mock.calls[0]![1];
    expect(committed[1]).toBe(failed);
    expect(committed[2]).toBe(hole);
    await vi.waitFor(() =>
      expect(eventController.getActionState("save")).toMatchObject({
        revalidationError: expect.objectContaining({
          message: "stock service unavailable",
        }),
      }),
    );
  });
});

describe("server-action-bridge concurrent actions whose loader fails on its rerun", () => {
  const route = { id: "R0", type: "route", component: "div" };
  const loader = (loaderData: Promise<unknown>) => ({
    id: "R0D0.stock",
    type: "loader",
    loaderId: "stock",
    loaderData,
  });
  const failure = (run: number) => ({
    __loaderResult: true,
    ok: false,
    error: { message: `stock service unavailable (run ${run})` },
    fallback: null,
  });
  const answer = (
    run: number,
    loaderData: Promise<unknown> = Promise.resolve(failure(run)),
  ) => ({
    pathname: "/",
    segments: [route, loader(loaderData)],
    matched: ["R0", "R0D0.stock"],
    diff: ["R0", "R0D0.stock"],
    resolvedIds: ["R0", "R0D0.stock"],
    isPartial: true,
  });

  /**
   * Two overlapping actions, "fast" and "slow": the fast one's answer lands
   * while the slow one is still fetching (concurrent-skip), and the slow one
   * consolidates with a refetch (partial-update.ts, action mode). The loader
   * throws on each rerun. Built by the real renderSegments.
   */
  function setup(fastLoaderData?: Promise<unknown>) {
    stubWindow();
    let releaseSlow!: () => void;
    const slowArrives = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let fetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (fetches++ === 1) await slowArrives;
        return new Response(null, { status: 200 });
      }),
    );
    const held = loader(
      Promise.resolve({ __loaderResult: true, ok: true, data: "stock:1" }),
    );
    const payloads = [
      {
        metadata: answer(2, fastLoaderData),
        returnValue: { ok: true, data: "fast" },
      },
      { metadata: answer(3), returnValue: { ok: true, data: "slow" } },
    ];
    const refetched = { ...answer(4), diff: ["R0D0.stock"] };
    let segmentIds = ["R0", "R0D0.stock"];
    const cache = new Map<string, { segments: unknown[]; stale: boolean }>([
      ["/", { segments: [route, held], stale: false }],
    ]);
    const store = {
      ...createMockStore(),
      loaders: new LoaderStore(),
      getSegmentState: vi.fn(() => ({
        path: "/",
        currentUrl: "http://localhost/",
        currentSegmentIds: segmentIds,
      })),
      getHistoryKey: vi.fn(() => "/"),
      setHistoryKey: vi.fn(),
      getCachedSegments: vi.fn((key: string) => cache.get(key)),
      cacheSegmentsForHistory: vi.fn((key: string, segments: unknown[]) => {
        cache.set(key, { segments, stale: false });
      }),
      setSegmentIds: vi.fn((ids: string[]) => {
        segmentIds = ids;
      }),
      setCurrentUrl: vi.fn(),
      setPath: vi.fn(),
      setInterceptSourceUrl: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      getHistoryEntryMemory: vi.fn(() => undefined),
      getRouterId: vi.fn(() => undefined),
    };
    const fetchPartial = vi.fn(async () => ({
      payload: { metadata: refetched },
      streamComplete: Promise.resolve(),
    }));
    const eventController = createEventController();
    const setServerCallback = vi.fn();
    const rendered: unknown[][] = [];
    const onUpdate = vi.fn();
    createServerActionBridge({
      store: store as any,
      client: { fetchPartial } as any,
      eventController,
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async (response: Promise<Response>) => {
          const payload = payloads.shift();
          await response;
          return payload;
        }),
        setServerCallback,
      } as any,
      onUpdate,
      renderSegments: async (segments: any[], options: any) => {
        rendered.push(segments);
        return renderSegments(segments, options);
      },
    }).register();
    const call = setServerCallback.mock.calls[0]![0] as (
      id: string,
      args: unknown[],
    ) => Promise<unknown>;
    return {
      fast: call("hash#fast", []),
      slow: call("hash#slow", []),
      releaseSlow,
      refetched,
      cache,
      cacheSegmentsForHistory: store.cacheSegmentsForHistory,
      fetchPartial,
      rendered,
      onUpdate,
      eventController,
    };
  }

  // Both calls resolve with their results, the consolidation refetch commits
  // its failed entry for the read site, and the action that ran it reports
  // the failure apart from `error`. The skipped answer is never rendered and
  // reports nothing.
  it("resolves both calls, commits the refetch's failed entry, and reports it to the consolidating action", async () => {
    const t = setup();
    await expect(t.fast).resolves.toBe("fast");
    t.releaseSlow();
    await expect(t.slow).resolves.toBe("slow");

    // One commit, the refetch's, with its own loader entry.
    expect(t.fetchPartial).toHaveBeenCalledTimes(1);
    expect(t.rendered).toHaveLength(1);
    expect(t.rendered[0]![1]).toBe(t.refetched.segments[1]);
    expect(t.onUpdate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(t.eventController.getActionState("fast")).toMatchObject({
        state: "idle",
        error: null,
        result: "fast",
        revalidationError: null,
      });
      expect(t.eventController.getActionState("slow")).toMatchObject({
        state: "idle",
        error: null,
        result: "slow",
        revalidationError: expect.objectContaining({
          message: "stock service unavailable (run 4)",
        }),
      });
    });
  });

  // The skipped answer writes the entry and resolves when its metadata lands,
  // as on main: it never waits for loader chunks of a response it does not
  // render, so a slow or cut chunk cannot hold or fail the call.
  it("a skipped answer writes the entry and resolves before its loader entry arrives", async () => {
    const t = setup(new Promise(() => {}));
    await expect(t.fast).resolves.toBe("fast");
    expect(t.cacheSegmentsForHistory).toHaveBeenCalledTimes(1);

    t.releaseSlow();
    await expect(t.slow).resolves.toBe("slow");
    expect(t.cache.get("/")!.segments[1]).toBe(t.refetched.segments[1]);
  });
});

// A navigation that commits after the action's response was classified, while
// its tree is built, drops the action's commit. The page it committed missed
// the write, so the bridge refetches it, as it does for a navigation committed
// before the response (navigated-away). The error-boundary path has no
// classify step, so it checks the flight too.
describe("server-action-bridge navigation committed during the action's render", () => {
  const route = { id: "R0", type: "route", component: "div" };
  const answer = {
    pathname: "/",
    segments: [route],
    matched: ["R0"],
    diff: ["R0"],
    isPartial: true,
  };

  function setup(
    payload: unknown,
    headers?: Record<string, string>,
    during: "render" | "flight" = "render",
  ) {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // A same-pathname navigation (another history entry) commits while
        // the request is out.
        if (during === "flight") {
          window.location.href = "http://localhost/?page=2";
          window.history.state.key = "k2";
        }
        return new Response(null, { status: 200, headers });
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = {
      ...createMockStore(),
      loaders: new LoaderStore(),
      getHistoryKey: vi.fn(() => "/"),
      getCachedSegments: vi.fn(() => ({ segments: [route], stale: false })),
      setSegmentIds: vi.fn(),
      cacheSegmentsForHistory: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      getRouterId: vi.fn(() => undefined),
    };
    const fetchPartial = vi.fn(() => new Promise(() => {}));
    const onUpdate = vi.fn();
    const setServerCallback = vi.fn();
    createServerActionBridge({
      store: store as any,
      client: { fetchPartial } as any,
      eventController: createEventController(),
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async (response: Promise<Response>) => {
          await response;
          return payload;
        }),
        setServerCallback,
      } as any,
      onUpdate,
      renderSegments: vi.fn(async () => {
        if (during === "render") {
          Object.assign(window.location, {
            href: "http://localhost/other",
            pathname: "/other",
          });
        }
        return "tree";
      }),
    }).register();
    const call = setServerCallback.mock.calls[0]![0] as (
      id: string,
      args: unknown[],
    ) => Promise<unknown>;
    return { call, fetchPartial, onUpdate };
  }

  it("refetches the page on screen, stale, instead of committing", async () => {
    const t = setup({
      metadata: answer,
      returnValue: { ok: true, data: "saved" },
    });
    await expect(t.call("hash#save", [])).resolves.toBe("saved");
    expect(t.onUpdate).not.toHaveBeenCalled();
    expect(t.fetchPartial).toHaveBeenCalledTimes(1);
    expect(t.fetchPartial).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: "http://localhost/other",
        segmentIds: [],
        staleRevalidation: true,
      }),
    );
  });

  it("refetches it after an error-boundary response too", async () => {
    const failure = new Error("out of stock");
    const t = setup({
      metadata: { ...answer, isError: true },
      returnValue: { ok: false, data: failure },
    });
    await expect(t.call("hash#save", [])).rejects.toBe(failure);
    expect(t.onUpdate).not.toHaveBeenCalled();
    expect(t.fetchPartial).toHaveBeenCalledTimes(1);
  });

  it("refetches after an error-boundary response when a same-pathname navigation committed during the flight", async () => {
    const failure = new Error("out of stock");
    const t = setup(
      {
        metadata: { ...answer, isError: true },
        returnValue: { ok: false, data: failure },
      },
      undefined,
      "flight",
    );
    await expect(t.call("hash#save", [])).rejects.toBe(failure);
    expect(t.onUpdate).not.toHaveBeenCalled();
    expect(t.fetchPartial).toHaveBeenCalledWith(
      expect.objectContaining({ targetUrl: "http://localhost/?page=2" }),
    );
  });

  it("does not refetch for an action that called keepClientCache()", async () => {
    const t = setup(
      { metadata: answer, returnValue: { ok: true, data: "saved" } },
      { "x-rango-keep-cache": "1" },
    );
    await expect(t.call("hash#save", [])).resolves.toBe("saved");
    expect(t.fetchPartial).not.toHaveBeenCalled();
  });
});

// An action's refetch of the page on screen never supersedes a navigation the
// user started (dc-t114): it waits for that navigation to settle, then
// refetches what is on screen, whole and stale (dc-q78). A refetch a click
// supersedes runs again for the page that click commits, and a land with a
// navigation in flight schedules the same refetch.
describe("server-action-bridge refetch follows the screen", () => {
  const route = { id: "R0", type: "route", component: "div" };
  const answer = {
    pathname: "/",
    segments: [route],
    matched: ["R0"],
    diff: ["R0"],
    isPartial: true,
  };

  /**
   * One action whose response the test releases. `during` runs while the
   * request is out: a navigation committing (another pathname and history
   * entry) makes the action navigated-away. Each refetch request is answered
   * when the test resolves it.
   */
  function setup(during?: (t: { eventController: any }) => void) {
    stubWindow();
    let release!: () => void;
    const responded = new Promise<void>((resolve) => (release = resolve));
    const eventController = createEventController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        during?.({ eventController });
        await responded;
        return new Response(null, { status: 200 });
      }),
    );
    let historyKey = "/";
    const cache = new Map<string, { segments: unknown[]; stale: boolean }>([
      ["/", { segments: [route], stale: false }],
    ]);
    const store = {
      ...createMockStore(),
      loaders: new LoaderStore(),
      getHistoryKey: vi.fn(() => historyKey),
      setHistoryKey: vi.fn((key: string) => (historyKey = key)),
      getCachedSegments: vi.fn((key: string) => cache.get(key)),
      cacheSegmentsForHistory: vi.fn((key: string, segments: unknown[]) => {
        cache.set(key, { segments, stale: false });
      }),
      setSegmentIds: vi.fn(),
      setCurrentUrl: vi.fn(),
      setPath: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      getRouterId: vi.fn(() => undefined),
    };
    const answers: Array<(value: unknown) => void> = [];
    const fetchPartial = vi.fn(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    const setServerCallback = vi.fn();
    createServerActionBridge({
      store: store as any,
      client: { fetchPartial } as any,
      eventController,
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async (response: Promise<Response>) => {
          await response;
          return { metadata: answer, returnValue: { ok: true, data: "saved" } };
        }),
        setServerCallback,
      } as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    }).register();
    const call = (setServerCallback.mock.calls[0]![0] as Function)(
      "hash#save",
      [],
    ) as Promise<unknown>;
    // A navigation the user started, and its commit (the transaction's end):
    // the page it puts on screen is at `pathname`, under its own entry.
    const navigate = (pathname: string) => {
      const handle = eventController.startNavigation(
        `http://localhost${pathname}`,
      );
      return {
        handle,
        commit() {
          Object.assign(window.location, {
            href: `http://localhost${pathname}`,
            pathname,
          });
          window.history.state.key = pathname;
          historyKey = pathname;
          cache.set(pathname, { segments: [route], stale: false });
          handle.complete(new URL(`http://localhost${pathname}`));
          handle[Symbol.dispose]();
        },
      };
    };
    const refetched = () =>
      fetchPartial.mock.calls.map(
        (args) => (args as unknown as [{ targetUrl: string }])[0].targetUrl,
      );
    // The microtasks a settled navigation's waiter and the refetch's start
    // take.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      call,
      release,
      navigate,
      refetched,
      fetchPartial,
      answers,
      eventController,
      flush,
    };
  }

  it("waits for a navigation in flight when the action answers, then refetches the page it commits", async () => {
    let second!: { handle: any; commit(): void };
    const t = setup(() => {
      // Navigation 1 commits /other, navigation 2 to /slow is still out.
      Object.assign(window.location, {
        href: "http://localhost/other",
        pathname: "/other",
      });
      window.history.state.key = "/other";
      second = t.navigate("/slow");
    });
    t.release();
    await expect(t.call).resolves.toBe("saved");
    await t.flush();
    expect(second.handle.signal.aborted).toBe(false);
    expect(t.fetchPartial).not.toHaveBeenCalled();

    second.commit();
    await t.flush();
    expect(t.fetchPartial).toHaveBeenCalledTimes(1);
    expect(t.fetchPartial).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: "http://localhost/slow",
        segmentIds: [],
        staleRevalidation: true,
      }),
    );
  });

  it("moves its wait to a newer navigation that supersedes the one it waited for", async () => {
    let second!: { handle: any; commit(): void };
    const t = setup(() => {
      Object.assign(window.location, {
        href: "http://localhost/other",
        pathname: "/other",
      });
      window.history.state.key = "/other";
      second = t.navigate("/slow");
    });
    t.release();
    await t.call;
    const third = t.navigate("/third");
    await t.flush();
    expect(second.handle.signal.aborted).toBe(true);
    expect(t.fetchPartial).not.toHaveBeenCalled();

    third.commit();
    await t.flush();
    expect(t.refetched()).toEqual(["http://localhost/third"]);
  });

  it("refetches nothing after a navigation that failed: its error stays on screen", async () => {
    let second!: { handle: any; commit(): void };
    const t = setup(() => {
      Object.assign(window.location, {
        href: "http://localhost/other",
        pathname: "/other",
      });
      window.history.state.key = "/other";
      second = t.navigate("/slow");
    });
    t.release();
    await t.call;
    second.handle[Symbol.dispose]();
    await t.flush();
    expect(t.fetchPartial).not.toHaveBeenCalled();
  });

  it("runs again for the page a click commits when the click leaves the refetch before it committed", async () => {
    const t = setup(() => {
      Object.assign(window.location, {
        href: "http://localhost/other",
        pathname: "/other",
      });
      window.history.state.key = "/other";
    });
    t.release();
    await t.call;
    await t.flush();
    expect(t.refetched()).toEqual(["http://localhost/other"]);

    const click = t.navigate("/pdp");
    // The refetch's response still arrives, and is ignored.
    t.answers[0]!({
      payload: { metadata: answer },
      streamComplete: Promise.resolve(),
    });
    await t.flush();
    expect(t.fetchPartial).toHaveBeenCalledTimes(1);

    click.commit();
    await t.flush();
    expect(t.refetched()).toEqual([
      "http://localhost/other",
      "http://localhost/pdp",
    ]);
  });

  it("schedules the refetch from its land when a navigation is in flight, and none without one", async () => {
    let click!: { handle: any; commit(): void };
    const t = setup(() => {
      click = t.navigate("/next");
    });
    t.release();
    await expect(t.call).resolves.toBe("saved");
    await t.flush();
    expect(t.fetchPartial).not.toHaveBeenCalled();

    click.commit();
    await t.flush();
    expect(t.refetched()).toEqual(["http://localhost/next"]);

    const quiet = setup();
    quiet.release();
    await expect(quiet.call).resolves.toBe("saved");
    await quiet.flush();
    expect(quiet.fetchPartial).not.toHaveBeenCalled();
  });
});

// The follow-up revalidation's rules (server-action-bridge.ts followUp): an
// action owes the page on screen one whole, stale refetch when it did not
// land there; the batch's last exit runs it, after the navigation the user
// started; a redirect clears it; it runs again when a navigation leaves it
// before its commit, or an action starts during it.
describe("server-action-bridge follow-up", () => {
  const layout = { id: "L0", type: "layout", component: "div" };
  const route = { id: "R0", type: "route", component: "div" };
  const answer = {
    pathname: "/",
    segments: [route],
    matched: ["L0", "R0"],
    diff: ["R0"],
    isPartial: true,
  };
  const saved = (data: unknown = "saved") => ({
    metadata: answer,
    returnValue: { ok: true, data },
  });
  const boundary = (failure: unknown) => ({
    metadata: { ...answer, isError: true },
    returnValue: { ok: false, data: failure },
  });

  interface Sent {
    /**
     * Answer the action. `decoded` holds its Flight decode after the
     * response arrived (the response counts as received); `body` keeps its
     * stream open until the test closes it.
     */
    respond(
      payload: unknown,
      headers?: Record<string, string>,
      decoded?: Promise<void>,
      body?: ReadableStream<Uint8Array>,
    ): void;
  }

  /**
   * A bridge whose action requests (`sent`, in order) and refetches
   * (`fetchPartial`, answered through `answers`) the test answers. The page
   * on screen is "/" under history entry "/", with a layout and a route.
   */
  function setup() {
    __resetActionFence();
    stubWindow();
    window.history.state.key = "/";
    const eventController = createEventController();
    let historyKey = "/";
    let interceptSource: string | null = null;
    const cache = new Map<string, { segments: unknown[]; stale: boolean }>([
      ["/", { segments: [layout, route], stale: false }],
    ]);
    const store = {
      ...createMockStore(),
      loaders: new LoaderStore(),
      getSegmentState: vi.fn(() => ({
        path: window.location.pathname,
        currentUrl: window.location.href,
        currentSegmentIds: ["L0", "R0"],
      })),
      getInterceptSourceUrl: vi.fn(() => interceptSource),
      setInterceptSourceUrl: vi.fn((url: string | null) => {
        interceptSource = url;
      }),
      getHistoryKey: vi.fn(() => historyKey),
      setHistoryKey: vi.fn((key: string) => (historyKey = key)),
      getCachedSegments: vi.fn((key: string) => cache.get(key)),
      cacheSegmentsForHistory: vi.fn((key: string, segments: unknown[]) => {
        cache.set(key, { segments, stale: false });
      }),
      setSegmentIds: vi.fn(),
      setCurrentUrl: vi.fn(),
      setPath: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      getRouterId: vi.fn(() => undefined),
    };
    const sent: Sent[] = [];
    const answered = new Map<
      string,
      { payload: unknown; decoded?: Promise<void> }
    >();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            const index = String(sent.length);
            sent.push({
              respond(payload, headers = {}, decoded, body) {
                answered.set(index, { payload, decoded });
                resolve(
                  new Response(body ?? null, {
                    status: 200,
                    headers: { ...headers, "x-test-call": index },
                  }),
                );
              },
            });
          }),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const answers: Array<(value: unknown) => void> = [];
    const fetchPartial = vi.fn(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    const onUpdate = vi.fn();
    const onNavigate = vi.fn(async () => {});
    const setServerCallback = vi.fn();
    createServerActionBridge({
      store: store as any,
      client: { fetchPartial } as any,
      eventController,
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async (response: Promise<Response>) => {
          const index = (await response).headers.get("x-test-call")!;
          const { payload, decoded } = answered.get(index)!;
          await decoded;
          return payload;
        }),
        setServerCallback,
      } as any,
      onUpdate,
      renderSegments: vi.fn(async () => "tree"),
      onNavigate,
    }).register();
    const callback = setServerCallback.mock.calls[0]![0] as (
      id: string,
      args: unknown[],
    ) => Promise<unknown>;
    // The microtasks an action's request, a settled navigation's waiter and
    // a refetch's start take.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    /** Start an action: its call. */
    const act = (id = "hash#save") => {
      const call = callback(id, []);
      call.catch(() => {});
      return call;
    };
    /** Answer action request `index`, once it is out. */
    const respond = async (
      index: number,
      payload: unknown,
      headers?: Record<string, string>,
      decoded?: Promise<void>,
      body?: ReadableStream<Uint8Array>,
    ) => {
      while (!sent[index]) await flush();
      sent[index]!.respond(payload, headers, decoded, body);
    };
    /** A page is on screen: `pathname` under its own history entry. */
    const show = (pathname: string, source: string | null = null) => {
      Object.assign(window.location, {
        href: `http://localhost${pathname}`,
        pathname,
      });
      window.history.state.key = pathname;
      historyKey = pathname;
      interceptSource = source;
      cache.set(pathname, { segments: [layout, route], stale: false });
    };
    /** A navigation the user started, and its commit or failure. */
    const navigate = (
      pathname: string,
      options?: { replace?: boolean; skipLoadingState?: boolean },
    ) => {
      const handle = eventController.startNavigation(
        `http://localhost${pathname}`,
        options,
      );
      return {
        handle,
        commit(source: string | null = null) {
          show(pathname, source);
          handle.complete(new URL(`http://localhost${pathname}`));
          handle[Symbol.dispose]();
        },
      };
    };
    /** Back/Forward to an entry restored from the history cache. */
    const back = (pathname: string, source: string | null = null) => {
      eventController.abortNavigation();
      show(pathname, source);
    };
    /** Answer refetch `index` with the page as it is; it commits. */
    const answerRefetch = (index: number) =>
      answers[index]!({
        payload: { metadata: { ...answer, matched: ["L0", "R0"] } },
        streamComplete: Promise.resolve(),
      });
    const refetches = () =>
      fetchPartial.mock.calls.map((args) => {
        const [request] = args as unknown as [
          { targetUrl: string; segmentIds: string[]; previousUrl: string },
        ];
        return request;
      });
    const followUps = () =>
      refetches()
        .filter((request) => request.segmentIds.length === 0)
        .map((request) => request.targetUrl);
    return {
      act,
      respond,
      show,
      navigate,
      back,
      flush,
      fetchPartial,
      answerRefetch,
      refetches,
      followUps,
      onUpdate,
      onNavigate,
      store,
      eventController,
    };
  }

  it("runs one follow-up for a batch of actions, at the last exit", async () => {
    const t = setup();
    const first = t.act("hash#first");
    const second = t.act("hash#second");
    t.show("/other");

    await t.respond(0, saved("one"));
    await expect(first).resolves.toBe("one");
    await t.flush();
    expect(t.fetchPartial).not.toHaveBeenCalled();

    await t.respond(1, saved("two"));
    await expect(second).resolves.toBe("two");
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/other"]);
  });

  it("runs no follow-up when every action of the batch landed on the page on screen", async () => {
    const t = setup();
    const first = t.act("hash#first");
    const second = t.act("hash#second");

    await t.respond(0, saved("one"));
    await expect(first).resolves.toBe("one");
    await t.respond(1, saved("two"));
    // The consolidation repair, as on main: it holds the layout.
    while (t.fetchPartial.mock.calls.length === 0) await t.flush();
    expect(t.refetches()).toEqual([
      expect.objectContaining({ segmentIds: ["L0"] }),
    ]);
    t.answerRefetch(0);
    await expect(second).resolves.toBe("two");
    await t.flush();
    expect(t.followUps()).toEqual([]);
  });

  it("follows up a keepClientCache() action's sibling, never the keep action", async () => {
    const t = setup();
    const keep = t.act("hash#keep");
    const plain = t.act("hash#plain");
    t.show("/other");

    await t.respond(1, saved("plain"));
    await expect(plain).resolves.toBe("plain");
    await t.respond(0, saved("keep"), { "x-rango-keep-cache": "1" });
    await expect(keep).resolves.toBe("keep");
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/other"]);

    const alone = setup();
    const call = alone.act("hash#keep");
    alone.show("/other");
    await alone.respond(0, saved("keep"), { "x-rango-keep-cache": "1" });
    await expect(call).resolves.toBe("keep");
    await alone.flush();
    expect(alone.fetchPartial).not.toHaveBeenCalled();
  });

  it("follows up a thrown action whose page the user left", async () => {
    const t = setup();
    const failure = new Error("out of stock");
    const call = t.act();
    t.show("/other");

    await t.respond(0, {
      metadata: answer,
      returnValue: { ok: false, data: failure },
    });
    await expect(call).rejects.toBe(failure);
    await t.flush();
    expect(t.onUpdate).not.toHaveBeenCalled();
    expect(t.followUps()).toEqual(["http://localhost/other"]);
  });

  it("follows up a thrown action whose page has a click in flight at its exit, after that click", async () => {
    const t = setup();
    const failure = new Error("out of stock");
    const call = t.act();
    const click = t.navigate("/next");

    await t.respond(0, {
      metadata: answer,
      returnValue: { ok: false, data: failure },
    });
    await expect(call).rejects.toBe(failure);
    await t.flush();
    expect(click.handle.signal.aborted).toBe(false);
    expect(t.fetchPartial).not.toHaveBeenCalled();

    click.commit();
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/next"]);
  });

  it("a redirect owes nothing and clears the batch's debt", async () => {
    const t = setup();
    const first = t.act("hash#first");
    // A header redirect's call never settles: the page navigates.
    t.act("hash#redirect");
    t.show("/other");

    await t.respond(0, saved("one"));
    await expect(first).resolves.toBe("one");
    await t.flush();
    await t.respond(1, saved(), { "X-RSC-Redirect": "http://localhost/done" });
    await t.flush();
    expect(t.onNavigate).toHaveBeenCalledWith(
      "http://localhost/done",
      expect.objectContaining({ replace: true }),
    );
    expect(t.fetchPartial).not.toHaveBeenCalled();
  });

  it("a payload redirect owes nothing and clears the batch's debt", async () => {
    const t = setup();
    const first = t.act("hash#first");
    const redirect = t.act("hash#redirect");
    t.show("/other");

    await t.respond(0, saved("one"));
    await expect(first).resolves.toBe("one");
    await t.flush();
    // A redirect with location state comes back as a Flight payload.
    await t.respond(1, {
      metadata: { ...answer, redirect: { url: "/done" } },
      returnValue: { ok: true, data: "two" },
    });
    await expect(redirect).resolves.toBe("two");
    await t.flush();
    expect(t.onNavigate).toHaveBeenCalledWith(
      "http://localhost/done",
      expect.objectContaining({ replace: true }),
    );
    expect(t.fetchPartial).not.toHaveBeenCalled();
  });

  it("a payload redirect keeps the debt of a sibling that lands during its navigation", async () => {
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let redirecting: ReturnType<typeof t.navigate> | undefined;
    t.onNavigate.mockImplementation(async () => {
      redirecting = t.navigate("/done");
      await gate;
      redirecting.commit();
    });
    const redirect = t.act("hash#redirect");
    const sibling = t.act("hash#sibling");

    await t.respond(0, {
      metadata: { ...answer, redirect: { url: "/done" } },
      returnValue: { ok: true, data: "redirect" },
    });
    while (!redirecting) await t.flush();
    // The redirect's request may predate the sibling's write.
    await t.respond(1, saved("sibling"));
    await expect(sibling).resolves.toBe("sibling");
    await t.flush();
    expect(t.fetchPartial).not.toHaveBeenCalled();

    release();
    await expect(redirect).resolves.toBe("redirect");
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/done"]);
  });

  it("leaves a sibling's error boundary on screen: an action it aborted after its response owes nothing", async () => {
    const t = setup();
    const failure = new Error("out of stock");
    const plain = t.act("hash#plain");
    const failing = t.act("hash#failing");
    let decode!: () => void;

    // The plain action's response is in; its decode waits.
    await t.respond(0, saved("plain"), {}, new Promise((r) => (decode = r)));
    await t.flush();
    await t.respond(1, {
      metadata: { ...answer, isError: true },
      returnValue: { ok: false, data: failure },
    });
    await expect(failing).rejects.toBe(failure);
    decode();
    await expect(plain).resolves.toBeUndefined();
    await t.flush();
    expect(t.onUpdate).toHaveBeenCalledTimes(1);
    expect(t.fetchPartial).not.toHaveBeenCalled();
  });

  it("drops a late error boundary for a page the user left: it aborts nothing, its call rejects, useAction() records the error, and the page on screen is followed up", async () => {
    const t = setup();
    const failure = new Error("out of stock");
    const failing = t.act("hash#failing");
    t.show("/other");
    const sibling = t.act("hash#sibling");

    await t.respond(0, boundary(failure));
    await expect(failing).rejects.toBe(failure);
    expect(t.eventController.getActionState("hash#failing").error).toBe(
      failure,
    );
    expect(t.eventController.getActionState("hash#sibling").state).toBe(
      "loading",
    );
    expect(t.onUpdate).not.toHaveBeenCalled();

    await t.respond(1, saved("sibling"));
    await expect(sibling).resolves.toBe("sibling");
    expect(t.eventController.getActionState("hash#sibling").result).toBe(
      "sibling",
    );
    await t.flush();
    expect(t.onUpdate).toHaveBeenCalledTimes(1);
    expect(t.followUps()).toEqual(["http://localhost/other"]);
  });

  it("an error boundary that shows aborts the other actions and keeps its own error for useAction() while its response streams", async () => {
    const t = setup();
    const failure = new Error("out of stock");
    const sibling = t.act("hash#sibling");
    const failing = t.act("hash#failing");
    let end!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        end = () => controller.close();
      },
    });

    await t.respond(1, boundary(failure), {}, undefined, body);
    await expect(failing).rejects.toBe(failure);
    expect(t.onUpdate).toHaveBeenCalledTimes(1);
    expect(t.eventController.getActionState("hash#sibling").state).toBe("idle");
    expect(t.eventController.getActionState("hash#failing")).toMatchObject({
      state: "streaming",
      error: null,
    });

    end();
    await t.flush();
    expect(t.eventController.getActionState("hash#failing")).toMatchObject({
      state: "idle",
      error: failure,
    });

    await t.respond(0, saved("sibling"));
    await expect(sibling).resolves.toBeUndefined();
    expect(t.onUpdate).toHaveBeenCalledTimes(1);
  });

  it("owes the follow-up again when an action starts during it", async () => {
    const t = setup();
    const first = t.act("hash#first");
    t.show("/other");
    await t.respond(0, saved("one"));
    await expect(first).resolves.toBe("one");
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/other"]);

    // A second action starts while the follow-up is out; the follow-up
    // commits before the action answers.
    const second = t.act("hash#second");
    t.answerRefetch(0);
    await t.flush();
    expect(t.followUps()).toHaveLength(1);

    await t.respond(1, saved("two"));
    await expect(second).resolves.toBe("two");
    await t.flush();
    expect(t.followUps()).toEqual([
      "http://localhost/other",
      "http://localhost/other",
    ]);
  });

  it("an action that starts during the follow-up aborts it: its late answer never commits over the action's", async () => {
    const t = setup();
    const first = t.act("hash#first");
    t.show("/other");
    await t.respond(0, saved("one"));
    await expect(first).resolves.toBe("one");
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/other"]);

    // The follow-up's request left before the second action's write. That
    // action lands on the page on screen and commits its own response.
    const second = t.act("hash#second");
    await t.respond(1, saved("two"));
    await expect(second).resolves.toBe("two");
    await t.flush();
    const commits = t.onUpdate.mock.calls.length;
    expect(commits).toBeGreaterThan(0);

    t.answerRefetch(0);
    await t.flush();
    expect(t.onUpdate).toHaveBeenCalledTimes(commits);
    // Owed again at the second batch's end.
    expect(t.followUps()).toEqual([
      "http://localhost/other",
      "http://localhost/other",
    ]);
  });

  it("a left follow-up runs again only while no newer one started: two never abort each other", async () => {
    const t = setup();
    const first = t.act("hash#first");
    t.show("/q");
    await t.respond(0, saved("one"));
    await expect(first).resolves.toBe("one");
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/q"]);

    // The second action on /q has a click to /r in flight when it lands.
    const second = t.act("hash#second");
    const click = t.navigate("/r");
    await t.respond(1, saved("two"));
    await expect(second).resolves.toBe("two");
    click.commit();
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/q", "http://localhost/r"]);

    // The left first follow-up answers late, then the newer one.
    t.answerRefetch(0);
    await t.flush();
    t.answerRefetch(1);
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/q", "http://localhost/r"]);
  });

  it("waits for a committed click whose fill or stream is still open, and never aborts it", async () => {
    // A prefetch: false click: committed, its fill holds the transaction
    // open (fillHoles) and its stream until the fill's answer streamed.
    const t = setup();
    const call = t.act();
    const click = t.navigate("/fill");
    const stream = click.handle.startStreaming();
    t.show("/fill");
    click.handle.complete(new URL("http://localhost/fill"));
    await t.respond(0, saved());
    await expect(call).resolves.toBe("saved");
    await t.flush();
    expect(click.handle.signal.aborted).toBe(false);
    expect(t.fetchPartial).not.toHaveBeenCalled();

    stream.end();
    await t.flush();
    expect(t.fetchPartial).not.toHaveBeenCalled();
    click.handle[Symbol.dispose]();
    await t.flush();
    expect(click.handle.signal.aborted).toBe(false);
    expect(t.followUps()).toEqual(["http://localhost/fill"]);

    // A click whose transaction ended with its stream still open.
    const s = setup();
    const streamed = s.act();
    const next = s.navigate("/next");
    const nextStream = next.handle.startStreaming();
    next.commit();
    await s.respond(0, saved());
    await expect(streamed).resolves.toBe("saved");
    await s.flush();
    expect(next.handle.signal.aborted).toBe(false);
    expect(s.fetchPartial).not.toHaveBeenCalled();

    nextStream.end();
    await s.flush();
    expect(next.handle.signal.aborted).toBe(false);
    expect(s.followUps()).toEqual(["http://localhost/next"]);
  });

  it("an action that exits while its own page still streams owes nothing", async () => {
    const t = setup();
    // A click committed /p; its stream is still open when the action, sent
    // from /p, lands. The action's own response re-rendered /p.
    const click = t.navigate("/p");
    const stream = click.handle.startStreaming();
    click.commit();
    const call = t.act();
    await t.respond(0, saved());
    await expect(call).resolves.toBe("saved");
    await t.flush();
    expect(t.onUpdate).toHaveBeenCalledTimes(1);

    stream.end();
    await t.flush();
    expect(click.handle.signal.aborted).toBe(false);
    expect(t.fetchPartial).not.toHaveBeenCalled();
  });

  it("a repair that cannot start while the page streams owes the follow-up", async () => {
    // matched names a segment neither the response nor the cache holds:
    // hmr-missing, whose repair refetches the page.
    const missing = {
      metadata: { ...answer, matched: ["L0", "R0", "R1"] },
      returnValue: { ok: true, data: "saved" },
    };
    const t = setup();
    const click = t.navigate("/p");
    const stream = click.handle.startStreaming();
    click.commit();
    const call = t.act();
    await t.respond(0, missing);
    await expect(call).resolves.toBe("saved");
    await t.flush();
    // The repair would abort the click's stream: it does not start.
    expect(click.handle.signal.aborted).toBe(false);
    expect(t.fetchPartial).not.toHaveBeenCalled();

    stream.end();
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/p"]);

    // A keepClientCache() action owes nothing, as with a click in flight.
    const keep = setup();
    const keepClick = keep.navigate("/p");
    const keepStream = keepClick.handle.startStreaming();
    keepClick.commit();
    const kept = keep.act();
    await keep.respond(0, missing, { "x-rango-keep-cache": "1" });
    await expect(kept).resolves.toBe("saved");
    keepStream.end();
    await keep.flush();
    expect(keepClick.handle.signal.aborted).toBe(false);
    expect(keep.fetchPartial).not.toHaveBeenCalled();
  });

  it("a keepClientCache() action that lands last owes a sibling's consolidation that cannot start", async () => {
    const t = setup();
    const click = t.navigate("/p");
    const stream = click.handle.startStreaming();
    click.commit();
    const plain = t.act("hash#plain");
    const keep = t.act("hash#keep");
    // The plain action lands first and renders nothing: the last to land
    // consolidates. That repair cannot start while /p streams.
    await t.respond(0, saved("plain"));
    await expect(plain).resolves.toBe("plain");
    await t.respond(1, saved("keep"), { "x-rango-keep-cache": "1" });
    await expect(keep).resolves.toBe("keep");
    await t.flush();
    expect(t.onUpdate).not.toHaveBeenCalled();
    expect(t.fetchPartial).not.toHaveBeenCalled();

    stream.end();
    await t.flush();
    expect(click.handle.signal.aborted).toBe(false);
    expect(t.followUps()).toEqual(["http://localhost/p"]);
  });

  it("runs no follow-up while an intercept is on screen", async () => {
    const t = setup();
    const call = t.act();
    // An intercept opened during the flight, over the page the action ran on.
    t.show("/item", "http://localhost/");
    await t.respond(0, saved());
    await expect(call).resolves.toBe("saved");
    await t.flush();
    expect(t.fetchPartial).not.toHaveBeenCalled();
  });

  it("drops the debt when the click in flight at the exit commits an intercept", async () => {
    const t = setup();
    const call = t.act();
    const click = t.navigate("/item");
    await t.respond(0, saved());
    await expect(call).resolves.toBe("saved");
    await t.flush();
    expect(t.fetchPartial).not.toHaveBeenCalled();

    click.commit("http://localhost/");
    await t.flush();
    expect(t.fetchPartial).not.toHaveBeenCalled();
    // Closing the intercept starts no follow-up either: the debt is gone.
    t.back("/");
    await t.flush();
    expect(t.fetchPartial).not.toHaveBeenCalled();
  });

  it("follows up the page underneath, without the source, when the intercept closed after the response", async () => {
    const t = setup();
    t.show("/item", "http://localhost/");
    const call = t.act();
    let decode!: () => void;
    await t.respond(0, saved(), {}, new Promise((r) => (decode = r)));
    await t.flush();
    t.back("/");
    decode();
    await expect(call).resolves.toBe("saved");
    await t.flush();
    expect(t.onUpdate).not.toHaveBeenCalled();
    expect(t.refetches()).toEqual([
      expect.objectContaining({
        targetUrl: "http://localhost/",
        segmentIds: [],
        previousUrl: "http://localhost/",
      }),
    ]);
  });

  it("a late response for an action whose page was left writes nothing before its exit", async () => {
    for (const late of [
      {
        payload: {
          metadata: { ...answer, locationState: { flash: "added" } },
          returnValue: { ok: true, data: "saved" },
        },
        settles: (call: Promise<unknown>) =>
          expect(call).resolves.toBe("saved"),
      },
      {
        payload: {
          metadata: { ...answer, isError: true },
          returnValue: { ok: false, data: new Error("out of stock") },
        },
        settles: (call: Promise<unknown>) =>
          expect(call).rejects.toThrow("out of stock"),
      },
    ]) {
      const t = setup();
      t.show("/item", "http://localhost/");
      const call = t.act();
      // Back out of the intercept before the response: the action keeps running.
      t.back("/");
      const state = t.eventController.getLocationState();
      await t.respond(0, late.payload);
      await late.settles(call);
      expect(t.store.cacheSegmentsForHistory).not.toHaveBeenCalled();
      expect(t.store.setSegmentIds).not.toHaveBeenCalled();
      expect(t.store.rememberDisplayedEntry).not.toHaveBeenCalled();
      expect(window.history.replaceState).not.toHaveBeenCalled();
      expect(t.eventController.getLocationState()).toBe(state);
      expect(t.onUpdate).not.toHaveBeenCalled();
      await t.flush();
      // Its exit: the follow-up of the page underneath.
      expect(t.followUps()).toEqual(["http://localhost/"]);
      vi.unstubAllGlobals();
    }
  });

  it("a repair refetch never supersedes a navigation the user started", async () => {
    // matched names a segment neither the response nor the cache holds:
    // hmr-missing, whose repair refetches the page.
    const missing = {
      metadata: { ...answer, matched: ["L0", "R0", "R1"] },
      returnValue: { ok: true, data: "saved" },
    };
    const t = setup();
    const call = t.act();
    const click = t.navigate("/next");
    await t.respond(0, missing);
    await expect(call).resolves.toBe("saved");
    await t.flush();
    expect(click.handle.signal.aborted).toBe(false);
    expect(t.fetchPartial).not.toHaveBeenCalled();
    click.commit();
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/next"]);

    // A keepClientCache() action owes nothing: the click's request was
    // read after its write.
    const keep = setup();
    const kept = keep.act();
    const keepClick = keep.navigate("/next");
    await keep.respond(0, missing, { "x-rango-keep-cache": "1" });
    await expect(kept).resolves.toBe("saved");
    keepClick.commit();
    await keep.flush();
    expect(keepClick.handle.signal.aborted).toBe(false);
    expect(keep.fetchPartial).not.toHaveBeenCalled();
  });

  it("waits for a refresh() in flight at the land, then follows up the page it commits", async () => {
    const t = setup();
    const call = t.act();
    const refresh = t.navigate("/", { replace: true });
    await t.respond(0, saved());
    await expect(call).resolves.toBe("saved");
    await t.flush();
    expect(refresh.handle.signal.aborted).toBe(false);
    expect(t.fetchPartial).not.toHaveBeenCalled();

    refresh.commit();
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/"]);
  });

  it("runs again after a refresh() that leaves it before its commit", async () => {
    const t = setup();
    const call = t.act();
    t.show("/other");
    await t.respond(0, saved());
    await expect(call).resolves.toBe("saved");
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/other"]);

    const refresh = t.navigate("/other", { replace: true });
    // The left follow-up's response still arrives, and is ignored.
    t.answerRefetch(0);
    await t.flush();
    expect(t.followUps()).toHaveLength(1);

    refresh.commit();
    await t.flush();
    expect(t.followUps()).toEqual([
      "http://localhost/other",
      "http://localhost/other",
    ]);
  });

  it("runs again for the restored entry when Back leaves it, and supersedes that entry's SWR", async () => {
    const t = setup();
    t.show("/other");
    const call = t.act();
    t.show("/third");
    await t.respond(0, saved());
    await expect(call).resolves.toBe("saved");
    await t.flush();
    expect(t.followUps()).toEqual(["http://localhost/third"]);

    // Back, restored from the history cache: no navigation of its own.
    t.back("/other");
    t.answerRefetch(0);
    await t.flush();
    expect(t.followUps()).toEqual([
      "http://localhost/third",
      "http://localhost/other",
    ]);

    // The restored entry's stale-while-revalidate starts after it and
    // leaves it: it runs again, and leaves the SWR.
    const swr = t.navigate("/other", { replace: true, skipLoadingState: true });
    t.answerRefetch(1);
    await t.flush();
    expect(swr.handle.signal.aborted).toBe(true);
    expect(t.followUps()).toEqual([
      "http://localhost/third",
      "http://localhost/other",
      "http://localhost/other",
    ]);
  });
});
