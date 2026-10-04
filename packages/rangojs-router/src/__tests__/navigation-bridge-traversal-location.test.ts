import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundTransaction } from "../browser/navigation-transaction";
import type { NavigationUpdate, ResolvedSegment } from "../browser/types";

/**
 * #1031: on back/forward the controller's location (what usePathname,
 * useSearchParams and useNavigation().location read) moves where the entry
 * commits, not at the popstate event.
 *
 * The real event controller, transaction and store. Only the partial updater
 * is replaced, by one that commits its transaction when the test lets the
 * response arrive, which is what partial-update.ts does with a payload.
 */

const { fetchPartialUpdateMock } = vi.hoisted(() => ({
  fetchPartialUpdateMock: vi.fn(),
}));

vi.mock("../browser/partial-update.js", async () => ({
  ...(await vi.importActual<object>("../browser/partial-update.js")),
  createPartialUpdater: vi.fn(() => fetchPartialUpdateMock),
}));

vi.mock("../browser/scroll-restoration.js", () => ({
  handleNavigationStart: vi.fn(),
  handleNavigationEnd: vi.fn(),
  handleTraversalStart: vi.fn(),
  ensureHistoryKey: vi.fn(),
  getHistoryStateKey: vi.fn(() => "entry-key"),
}));

import { ServerRedirect } from "../errors";
import { createEventController } from "../browser/event-controller";
import { createNavigationBridge } from "../browser/navigation-bridge";
import {
  createNavigationStore,
  generateHistoryKey,
} from "../browser/navigation-store";

const LEAVING = "http://localhost/list?page=23";
const ENTRY = "http://localhost/list?page=2";
const ENTRY_STATE = { key: "entry-2", idx: 1, state: { from: "list" } };

function seg(
  id: string,
  extra: Partial<ResolvedSegment> = {},
): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type: "route",
    component: null,
    ...extra,
  } as ResolvedSegment;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The page at LEAVING is on screen; the browser has already moved to ENTRY
 * (window.location, history.state), as it has when popstate fires.
 */
function setup(options: { cached?: ResolvedSegment[] } = {}) {
  vi.stubGlobal("window", {
    location: { href: ENTRY, origin: "http://localhost" },
    history: { state: ENTRY_STATE, replaceState: vi.fn(), pushState: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  const store = createNavigationStore({
    initialLocation: { href: LEAVING },
    initialHistoryKey: generateHistoryKey(LEAVING),
    initialSegments: [seg("R0", { params: { list: "leaving" } })],
    initialSegmentIds: ["R0"],
    crossTabSync: false,
  });
  if (options.cached) {
    store.cacheSegmentsForHistory(generateHistoryKey(ENTRY), options.cached, {
      handle: {},
    });
  }
  const eventController = createEventController({
    initialLocation: new URL(LEAVING),
  });
  eventController.setParams({ list: "leaving" });
  // What the hooks would read at each update the bridge hands to React.
  const updates: {
    update: NavigationUpdate;
    location: string;
    params: Record<string, string>;
  }[] = [];
  const onUpdate = vi.fn((update: NavigationUpdate) => {
    updates.push({
      update,
      location: eventController.getLocation().href,
      params: eventController.getParams(),
    });
  });
  const render = deferred<string>();
  const bridge = createNavigationBridge({
    store,
    client: {} as any,
    eventController,
    onUpdate,
    renderSegments: vi.fn(() => render.promise),
  });
  return { store, eventController, bridge, updates, render };
}

/** What useNavigation() reports, minus the fields no test here reads. */
function navigation(
  eventController: ReturnType<typeof createEventController>,
): { state: string; location: string; pendingUrl: string | null } {
  const { state, location, pendingUrl } = eventController.getState();
  return { state, location: location.href, pendingUrl };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchPartialUpdateMock.mockReset();
});

describe("navigation-bridge: the location on back/forward (#1031)", () => {
  it("a refetched traversal leaves the location alone until its transaction commits", async () => {
    const { eventController, bridge, updates } = setup();
    const response = deferred();
    fetchPartialUpdateMock.mockImplementation(
      async (
        _url: string,
        _ids: unknown,
        _retry: boolean,
        _signal: AbortSignal,
        tx: BoundTransaction,
      ) => {
        await response.promise;
        tx.commit(["R1"], [seg("R1")]);
      },
    );

    const traversal = bridge.handlePopstate();
    await vi.waitFor(() => expect(fetchPartialUpdateMock).toHaveBeenCalled());

    // The request is out and the page being left is still on screen.
    expect(navigation(eventController)).toEqual({
      state: "loading",
      location: LEAVING,
      pendingUrl: ENTRY,
    });
    expect(fetchPartialUpdateMock.mock.calls[0][4]).toMatchObject({
      traversal: true,
    });

    response.resolve();
    await traversal;

    expect(navigation(eventController)).toEqual({
      state: "idle",
      location: ENTRY,
      pendingUrl: null,
    });
    // The fetch path hands React nothing itself: partial-update.ts does.
    expect(updates).toEqual([]);
  });

  it("a traversal restored from the history cache sets the location in its restore block, with params and before the update", async () => {
    const cached = [seg("R2", { params: { list: "entry" } })];
    const { store, eventController, bridge, updates, render } = setup({
      cached,
    });

    const traversal = bridge.handlePopstate();
    await Promise.resolve();

    // The cached tree is still being built: nothing of the entry is out yet.
    expect(eventController.getLocation().href).toBe(LEAVING);
    expect(eventController.getParams()).toEqual({ list: "leaving" });
    expect(updates).toEqual([]);

    render.resolve("cached tree");
    await traversal;

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      location: ENTRY,
      params: { list: "entry" },
      update: { root: "cached tree", metadata: { params: { list: "entry" } } },
    });
    expect(eventController.getLocationState()).toEqual({
      state: { from: "list" },
    });
    // No fetch and no transaction: the restore is the whole commit.
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
    expect(navigation(eventController)).toEqual({
      state: "idle",
      location: ENTRY,
      pendingUrl: null,
    });
    expect(store.getSegmentState().currentUrl).toBe(ENTRY);
  });

  it.each([
    { label: "a network failure", error: new TypeError("Failed to fetch") },
    {
      label: "an unprocessable response",
      error: new Error("undecodable Flight body"),
    },
  ])(
    "a refetched traversal that fails ($label) reports the entry with its error boundary",
    async ({ error }) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { eventController, bridge, updates } = setup();
      const response = deferred();
      fetchPartialUpdateMock.mockImplementation(() => response.promise);

      const traversal = bridge.handlePopstate();
      await vi.waitFor(() => expect(fetchPartialUpdateMock).toHaveBeenCalled());
      expect(eventController.getLocation().href).toBe(LEAVING);

      response.reject(error);
      await traversal;

      // History is on the entry and its error boundary replaces the page
      // being left: the hooks report the entry in the boundary's batch.
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        location: ENTRY,
        update: { metadata: { isError: true } },
      });
      expect(navigation(eventController)).toEqual({
        state: "idle",
        location: ENTRY,
        pendingUrl: null,
      });
    },
  );

  it("a refetched traversal superseded by another navigation moves nothing", async () => {
    const { eventController, bridge, updates } = setup();
    const response = deferred();
    fetchPartialUpdateMock.mockImplementation(() => response.promise);

    const traversal = bridge.handlePopstate();
    await vi.waitFor(() => expect(fetchPartialUpdateMock).toHaveBeenCalled());

    // What a newer navigation does first (startNavigation aborts the entry).
    eventController.abortNavigation();
    response.reject(new DOMException("Navigation aborted", "AbortError"));
    await traversal;

    expect(updates).toEqual([]);
    expect(eventController.getLocation().href).toBe(LEAVING);
  });
});

describe("navigation-bridge: a refetched traversal the server redirects (#1047)", () => {
  it("follows the redirect as a replace, without an error boundary or the redirecting URL as location", async () => {
    const { eventController, bridge, updates } = setup();
    const navigate = vi
      .spyOn(bridge, "navigate")
      .mockResolvedValue(undefined as never);
    const setLocation = vi.spyOn(eventController, "setLocation");
    const response = deferred();
    fetchPartialUpdateMock.mockImplementation(() => response.promise);

    const traversal = bridge.handlePopstate();
    await vi.waitFor(() => expect(fetchPartialUpdateMock).toHaveBeenCalled());

    response.reject(
      new ServerRedirect("/login?rejected=1", { reason: "expired" }),
    );
    await traversal;

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("http://localhost/login?rejected=1", {
      state: { reason: "expired" },
      replace: true,
      _skipCache: true,
      _redirectHops: 1,
    });
    expect(updates).toEqual([]);
    expect(setLocation).not.toHaveBeenCalled();
  });

  it("blocks a redirect to another origin the way the push path does", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { eventController, bridge, updates } = setup();
    const navigate = vi
      .spyOn(bridge, "navigate")
      .mockResolvedValue(undefined as never);
    const response = deferred();
    fetchPartialUpdateMock.mockImplementation(() => response.promise);

    const traversal = bridge.handlePopstate();
    await vi.waitFor(() => expect(fetchPartialUpdateMock).toHaveBeenCalled());

    response.reject(
      new ServerRedirect("https://evil.example/login", undefined),
    );
    await traversal;

    expect(navigate).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[rango] Redirect blocked"),
    );
    expect(eventController.getLocation().href).toBe(LEAVING);
  });
});

/** Both pushes differ from the page on screen, so the second aborts the first. */
const PUSH_A = "http://localhost/a";
const PUSH_B = "http://localhost/b";

describe("navigation-bridge: a superseded push whose response is a redirect", () => {
  it("does not follow the redirect over the newer navigation", async () => {
    const { bridge, updates } = setup();
    const navigate = vi.spyOn(bridge, "navigate");
    const responses = new Map<string, ReturnType<typeof deferred<void>>>();
    fetchPartialUpdateMock.mockImplementation((url: string) => {
      // A redirect followed over B would land here; settle it so the
      // assertion below reports it rather than the test hanging.
      if (url.endsWith("/login")) return Promise.resolve();
      const response = deferred<void>();
      responses.set(url, response);
      return response.promise;
    });

    const first = bridge.navigate(PUSH_A);
    await vi.waitFor(() => expect(responses.has(PUSH_A)).toBe(true));
    const second = bridge.navigate(PUSH_B);
    await vi.waitFor(() => expect(responses.has(PUSH_B)).toBe(true));

    responses.get(PUSH_A)!.reject(new ServerRedirect("/login", undefined));
    await first;

    expect(navigate.mock.calls.map(([url]) => url)).toEqual([PUSH_A, PUSH_B]);

    responses.get(PUSH_B)!.resolve(undefined);
    await second;
    expect(updates).toEqual([]);
  });
});

describe("navigation-bridge: a server redirect loop", () => {
  const HOP_LIMIT = 20;

  function loop() {
    const ctx = setup();
    const navigate = vi.spyOn(ctx.bridge, "navigate");
    // Resolves instead of redirecting past 50 calls so a missing bound fails
    // the assertion rather than hanging the run.
    fetchPartialUpdateMock.mockImplementation((url: string) => {
      if (navigate.mock.calls.length > 50) return Promise.resolve();
      const next = url.endsWith("/ping") ? "/pong" : "/ping";
      return Promise.reject(new ServerRedirect(next, undefined));
    });
    return { ...ctx, navigate };
  }

  it("a push stops at the hop limit and renders the error boundary", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { bridge, updates, navigate } = loop();

    await bridge.navigate("http://localhost/ping");

    expect(navigate).toHaveBeenCalledTimes(HOP_LIMIT + 1);
    expect(updates).toHaveLength(1);
    expect((updates[0].update as any).metadata.isError).toBe(true);
    const loopLogs = consoleError.mock.calls.filter(([message]) =>
      String(message).includes("redirect loop"),
    );
    expect(loopLogs).toHaveLength(1);
    expect(String(loopLogs[0][0])).toContain(`${HOP_LIMIT} redirects`);
    expect(String(loopLogs[0][0])).toMatch(/http:\/\/localhost\/(ping|pong)/);
  });

  it("a traversal stops at the hop limit the same way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { bridge, updates, navigate } = loop();

    await bridge.handlePopstate();

    // The traversal's own fetch is not a navigate() call.
    expect(navigate).toHaveBeenCalledTimes(HOP_LIMIT);
    expect(updates).toHaveLength(1);
    expect((updates[0].update as any).metadata.isError).toBe(true);
  });

  it("a new user navigation starts again at zero hops", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { bridge, updates, navigate } = loop();

    await bridge.navigate("http://localhost/ping");
    navigate.mockClear();
    updates.length = 0;
    await bridge.navigate("http://localhost/ping");

    expect(navigate).toHaveBeenCalledTimes(HOP_LIMIT + 1);
    expect(updates).toHaveLength(1);
  });

  it("a single redirect is followed with one hop counted", async () => {
    const { bridge, updates } = setup();
    const navigate = vi.spyOn(bridge, "navigate");
    fetchPartialUpdateMock.mockImplementation((url: string) =>
      url.endsWith("/login")
        ? Promise.resolve()
        : Promise.reject(new ServerRedirect("/login", undefined)),
    );

    await bridge.navigate("http://localhost/ping");

    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate.mock.calls[1][0]).toBe("http://localhost/login");
    expect((navigate.mock.calls[1][1] as any)._redirectHops).toBe(1);
    expect(updates).toEqual([]);
  });
});
