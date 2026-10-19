import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventController } from "../browser/event-controller";
import { createServerActionBridge } from "../browser/server-action-bridge";
import { renderSegments } from "../segment-system";
import { LoaderStore } from "../loader-store";
import { Defer } from "../browser/defer";

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
