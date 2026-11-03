// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity, useEffect, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  Outlet,
  useFetchLoader,
  useLoader,
  useNavigation,
  useRefreshLoaders,
} from "../../client.js";
import { EMPTY_LOADER_SNAPSHOT } from "../../loader-store.js";
import type { LoaderDefinition } from "../../types.js";
import {
  renderRoute,
  type RenderRouteSpec,
  type TestRouterHandle,
} from "../render-route.js";

// A refreshed answer (load(), or a refreshGroup refresh) lives in the client
// LoaderStore. skills/hooks/data.md: "Registered-loader reads (keyed or not)
// reset on navigation from fresh route data". These tests ask what a reader
// draws, in every frame, once a navigation, an action or a refresh brought
// route data other than the data a refresh was requested for: a reader that
// MOUNTS after the navigation, and one that stays mounted across it. The
// refresh goes through renderRoute's loader endpoint (respondToLoads).

interface Data {
  label: string;
}
interface Page {
  name: "home" | "a" | "b" | "c";
}

// The shape the Vite plugin leaves in a client bundle for an export-only
// createLoader(fn, true) file.
const DataLoader = {
  __brand: "loader",
  $$id: "loader-remount#DataLoader",
} as unknown as LoaderDefinition<Data>;
// Tells the route component which page it is on, in the same commit as the
// data, so no frame mixes a page with another page's URL.
const PageLoader = {
  __brand: "loader",
  $$id: "loader-remount#PageLoader",
} as unknown as LoaderDefinition<Page>;

// One static route, the page chosen by the query: the route params stay
// empty, so no segment key changes between pages (segment-system.tsx keys are
// param-bearing) and only what a test unmounts on purpose remounts.
const url = (page: Page["name"]): string => `/p?page=${page}`;

type Mode = "keyed" | "plain" | "group" | "keyedGroup" | "fetchKeyed";

/** What each mode's reader passes to useLoader, and how it refreshes. */
function useRead(mode: Mode) {
  const refresh = useRefreshLoaders();
  const options =
    mode === "keyed" || mode === "fetchKeyed"
      ? { key: "k" }
      : mode === "group"
        ? { refreshGroup: "live" }
        : mode === "keyedGroup"
          ? { key: "k", refreshGroup: "live" }
          : undefined;
  // A registered loader read through useFetchLoader shares the same store.
  const result =
    mode === "fetchKeyed"
      ? // eslint-disable-next-line react-hooks/rules-of-hooks -- mode is fixed per component
        useFetchLoader(DataLoader, options)
      : // eslint-disable-next-line react-hooks/rules-of-hooks -- mode is fixed per component
        useLoader(DataLoader, options);
  return {
    ...result,
    refresh: () =>
      mode === "group" || mode === "keyedGroup"
        ? refresh("live")
        : result.load(),
  };
}

/** Every label a reader rendered, in order, across all mounts of the test. */
let frames: string[];
/** The same, per named reader. */
let framesOf: Record<string, string[]>;
/** Mounts and unmounts of every reader instance. */
let mounts: number;
let unmounts: number;

function makeReader(mode: Mode, testId = "data", name = testId) {
  return function Reader(): ReactNode {
    const { data, isLoading, error, refresh } = useRead(mode);
    const label = data?.label ?? "";
    frames.push(label);
    (framesOf[name] ??= []).push(label);
    useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    return (
      <>
        <p data-testid={testId}>{label}</p>
        <p data-testid={`${testId}-loading`}>{String(isLoading)}</p>
        <p data-testid={`${testId}-error`}>{error?.message ?? ""}</p>
        <button
          data-testid={`${testId}-refresh`}
          onClick={() => void refresh().catch(() => {})}
        />
      </>
    );
  };
}

// Distinct component types, as distinct routes have: A's reader is never B's.
function pageRoutes(
  mode: Mode,
  spec: Partial<RenderRouteSpec> = {},
): RenderRouteSpec[] {
  const ReaderA = makeReader(mode, "data", "A");
  const ReaderB = makeReader(mode, "data", "B");
  const ReaderC = makeReader(mode, "data", "C");
  function Route(): ReactNode {
    const { data: page } = useLoader(PageLoader);
    if (page.name === "a") return <ReaderA />;
    if (page.name === "b") return <ReaderB />;
    if (page.name === "c") return <ReaderC />;
    return <p data-testid="home">home</p>;
  }
  return [{ path: "/p", Component: Route, ...spec }];
}

const text = (id: string): string =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

/** The response of a navigation to `name`: its page, and its data if it has the loader. */
const at = (name: Page["name"], data?: Data | Promise<Data>) =>
  ({
    loaders: [
      [PageLoader, { name }],
      ...(data ? ([[DataLoader, data]] as const) : []),
    ],
  }) as const;

/** The loader endpoint answers `label` from now on; the reader refreshes. */
async function refreshNow(
  router: TestRouterHandle,
  label: string,
  testId = "data",
): Promise<void> {
  router.respondToLoads({ loaders: [[DataLoader, { label }]] });
  fireEvent.click(document.querySelector(`[data-testid="${testId}-refresh"]`)!);
  await waitFor(() => expect(text(testId)).toBe(label));
}

/** The page routes of `mode`, opened on the page without the loader. */
function renderPages(mode: Mode, spec: Partial<RenderRouteSpec> = {}) {
  return renderRoute(pageRoutes(mode, spec), {
    request: url("home"),
    loaders: [[PageLoader, { name: "home" }]],
  });
}

/** A load() that stays pending until `answer` settles. */
async function startPendingLoad(
  router: TestRouterHandle,
): Promise<ReturnType<typeof deferred<Data>>> {
  const answer = deferred<Data>();
  router.respondToLoads({ loaders: [[DataLoader, answer.promise]] });
  fireEvent.click(document.querySelector('[data-testid="data-refresh"]')!);
  await waitFor(() => expect(text("data-loading")).toBe("true"));
  return answer;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const distinct = (values: string[]): string[] => [...new Set(values)];

beforeEach(() => {
  frames = [];
  framesOf = {};
  mounts = 0;
  unmounts = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each([
  { id: "keyed: useLoader(L, { key })", mode: "keyed" as const },
  { id: "keyed + refreshGroup", mode: "keyedGroup" as const },
  {
    id: "keyed useFetchLoader of a registered loader",
    mode: "fetchKeyed" as const,
  },
  { id: "control: no key", mode: "plain" as const },
  {
    id: "control: refreshGroup without a key",
    mode: "group" as const,
  },
])("renderRoute: a reader that remounts on another route $id", ({ mode }) => {
  it("A (refreshed) -> a page without the loader -> B: B's reader draws B's data", async () => {
    const { router } = await renderPages(mode);

    await router.navigate(url("a"), at("a", { label: "A route data" }));
    expect(text("data")).toBe("A route data");
    await refreshNow(router, "A refreshed");

    await router.navigate(url("home"), at("home"));
    expect(text("data")).toBe("");
    expect(text("home")).toBe("home");
    expect(unmounts).toBe(1);

    frames = [];
    await router.navigate(url("b"), at("b", { label: "B route data" }));
    await settle();
    expect(mounts).toBe(2);
    // Every render of B's reader, first to last, draws B's data.
    expect(distinct(frames)).toEqual(["B route data"]);
    expect(text("data")).toBe("B route data");
  });

  it("A (refreshed) -> B directly, A's reader unmounting as B's mounts: B's data", async () => {
    const { router } = await renderPages(mode);

    await router.navigate(url("a"), at("a", { label: "A route data" }));
    await refreshNow(router, "A refreshed");

    frames = [];
    await router.navigate(url("b"), at("b", { label: "B route data" }));
    await settle();
    expect(mounts).toBe(2);
    expect(unmounts).toBe(1);
    expect(distinct(frames)).toEqual(["B route data"]);
    expect(text("data")).toBe("B route data");
  });

  it("A (never refreshed) -> a page without the loader -> B: B's data", async () => {
    const { router } = await renderPages(mode);

    await router.navigate(url("a"), at("a", { label: "A route data" }));
    await router.navigate(url("home"), at("home"));
    frames = [];
    await router.navigate(url("b"), at("b", { label: "B route data" }));
    await settle();
    expect(distinct(frames)).toEqual(["B route data"]);
  });

  it("A (refreshed) -> a page without the loader -> A again: the second visit's data", async () => {
    const { router } = await renderPages(mode);

    await router.navigate(url("a"), at("a", { label: "A visit 1" }));
    await refreshNow(router, "A visit 1 refreshed");

    await router.navigate(url("home"), at("home"));
    expect(text("data")).toBe("");
    expect(unmounts).toBe(1);

    frames = [];
    await router.navigate(url("a"), at("a", { label: "A visit 2" }));
    await settle();
    expect(mounts).toBe(2);
    expect(distinct(frames)).toEqual(["A visit 2"]);
    expect(text("data")).toBe("A visit 2");
  });
});

// A reader that stays mounted across a navigation (a layout's).
describe.each([
  { id: "keyed", mode: "keyed" as const },
  { id: "keyed + refreshGroup", mode: "keyedGroup" as const },
  { id: "no key", mode: "plain" as const },
  { id: "refreshGroup without a key", mode: "group" as const },
])(
  "renderRoute: a reader that stays mounted across A -> B ($id)",
  ({ mode }) => {
    function layoutRoutes(
      leaf: Partial<RenderRouteSpec> = {},
    ): RenderRouteSpec[] {
      const LayoutReader = makeReader(mode);
      function Layout(): ReactNode {
        return (
          <>
            <LayoutReader />
            <Outlet />
          </>
        );
      }
      function Leaf(): ReactNode {
        return <p data-testid="leaf">leaf</p>;
      }
      return [
        { path: "/", Component: Layout, loaderIds: [DataLoader.$$id] },
        { path: "/p", Component: Leaf, ...leaf },
      ];
    }
    /** The layout opened on page A, its reader showing A's route data. */
    const renderLayout = (leaf: Partial<RenderRouteSpec> = {}) =>
      renderRoute(layoutRoutes(leaf), {
        request: url("a"),
        loaders: [[DataLoader, { label: "A route data" }]],
      });

    it("shows B's data after a refresh on A, on the one mounted reader", async () => {
      const { router } = await renderLayout();
      expect(text("data")).toBe("A route data");
      await refreshNow(router, "A refreshed");

      await router.navigate(url("b"), {
        loaders: [[DataLoader, { label: "B route data" }]],
      });
      await settle();
      expect(text("data")).toBe("B route data");
      // The same reader instance throughout: not a remount.
      expect(mounts).toBe(1);
      expect(unmounts).toBe(0);
    });

    it("every frame from the commit on draws B's data, with no extra render", async () => {
      // The reader's frames across A -> B, with or without a refresh on A.
      const framesToB = async (refreshFirst: boolean): Promise<string[]> => {
        const { router } = await renderLayout();
        if (refreshFirst) await refreshNow(router, "A refreshed");
        frames = [];
        await router.navigate(url("b"), {
          loaders: [[DataLoader, { label: "B route data" }]],
        });
        await settle();
        const seen = frames;
        cleanup();
        return seen;
      };
      const plain = await framesToB(false);
      mounts = 0;
      const refreshed = await framesToB(true);
      expect(distinct(refreshed)).toEqual(["B route data"]);
      expect(refreshed.length).toBeLessThanOrEqual(plain.length);
      expect(mounts).toBe(1);
    });

    it("keeps its refresh across a navigation that brings the same route data", async () => {
      const { router } = await renderLayout();
      await refreshNow(router, "A refreshed");

      frames = [];
      await router.navigate(url("b"));
      await settle();
      expect(text("leaf")).toBe("leaf");
      expect(distinct(frames)).toEqual(["A refreshed"]);
    });

    it("transition(): keeps its refresh while the next page's data streams, then B's data in the commit", async () => {
      const { router } = await renderLayout({ transition: {} });
      await refreshNow(router, "A refreshed");

      const next = deferred<Data>();
      frames = [];
      await router.navigate(url("b"), {
        loaders: [[DataLoader, next.promise]],
      });
      // React holds A: the reader shows the data on screen, loading.
      expect(text("data")).toBe("A refreshed");
      expect(text("data-loading")).toBe("true");
      expect(distinct(frames)).toEqual(["A refreshed"]);

      frames = [];
      await act(async () => next.resolve({ label: "B route data" }));
      await settle();
      expect(distinct(frames)).toEqual(["B route data"]);
      expect(text("data-loading")).toBe("false");
      expect(mounts).toBe(1);
    });

    it("a response stream that ends before the commit: B's data from the first frame", async () => {
      const { router } = await renderLayout();
      await refreshNow(router, "A refreshed");

      frames = [];
      await router.navigate(url("b"), {
        loaders: [[DataLoader, { label: "B route data" }]],
        streamUntil: Promise.resolve(),
      });
      await settle();
      expect(distinct(frames)).toEqual(["B route data"]);
    });

    it("an action that re-runs the loader: its data in the action's commit", async () => {
      const { router } = await renderLayout();
      await refreshNow(router, "A refreshed");

      frames = [];
      await router.action({
        loaders: [[DataLoader, { label: "after the action" }]],
      });
      await settle();
      expect(distinct(frames)).toEqual(["after the action"]);
    });

    it("an action that does not re-run the loader keeps the refresh", async () => {
      const { router } = await renderLayout();
      await refreshNow(router, "A refreshed");

      frames = [];
      await router.action();
      await settle();
      expect(distinct(frames)).toEqual(["A refreshed"]);
    });

    it("router.refresh() with new loader data: that data in its commit", async () => {
      const { router } = await renderLayout();
      await refreshNow(router, "A refreshed");

      frames = [];
      await router.refresh({
        loaders: [[DataLoader, { label: "A revalidated" }]],
      });
      await settle();
      expect(distinct(frames)).toEqual(["A revalidated"]);
    });

    it("a stale page revalidating after the click: no frame draws the refresh", async () => {
      const { router } = await renderLayout();
      // The prefetch carries the data of now; the action makes it stale and
      // brings new data for the revalidation.
      router.prefetch(url("b"));
      await router.action({
        loaders: [[DataLoader, { label: "after the action" }]],
      });
      await refreshNow(router, "refreshed after the action");

      frames = [];
      await router.navigate(url("b"));
      await waitFor(() => expect(router.revalidations()).toHaveLength(1));
      await settle();
      expect(text("data")).toBe("after the action");
      expect(frames).not.toContain("refreshed after the action");
    });

    it("useNavigation() and the data commit together", async () => {
      function NavReader(): ReactNode {
        const { data } = useRead(mode);
        const { state } = useNavigation();
        frames.push(`${state}|${data?.label}`);
        return null;
      }
      const Reader = makeReader(mode);
      function Layout(): ReactNode {
        return (
          <>
            <NavReader />
            <Reader />
            <Outlet />
          </>
        );
      }
      const { router } = await renderRoute(
        [
          { path: "/", Component: Layout, loaderIds: [DataLoader.$$id] },
          { path: "/p", Component: () => <p data-testid="leaf">leaf</p> },
        ],
        {
          request: url("a"),
          loaders: [[DataLoader, { label: "A route data" }]],
        },
      );
      await refreshNow(router, "A refreshed");

      frames = [];
      await router.navigate(url("b"), {
        loaders: [[DataLoader, { label: "B route data" }]],
      });
      await settle();
      const navFrames = frames.filter((f) => f.includes("|"));
      // Loading frames still show the page being left; idle ones show B.
      for (const frame of navFrames) {
        expect(["loading|A refreshed", "idle|B route data"]).toContain(frame);
      }
      expect(navFrames.at(-1)).toBe("idle|B route data");
    });
  },
);

// Readers of one page share a refresh.
describe("renderRoute: readers of one page share a refresh", () => {
  it("a layout reader and a route reader of the same loader converge", async () => {
    const LayoutReader = makeReader("keyed", "layout");
    const RouteReader = makeReader("keyed", "route");
    function Layout(): ReactNode {
      return (
        <>
          <LayoutReader />
          <Outlet />
        </>
      );
    }
    const { router } = await renderRoute(
      [
        { path: "/", Component: Layout, loaderIds: [DataLoader.$$id] },
        {
          path: "/p",
          Component: RouteReader,
          loaderIds: [DataLoader.$$id],
        },
      ],
      {
        request: url("a"),
        loaders: [[DataLoader, { label: "A route data" }]],
      },
    );
    await refreshNow(router, "A refreshed", "route");
    expect(text("layout")).toBe("A refreshed");
  });

  it("a reader that mounts later on the same page adopts the refresh", async () => {
    const First = makeReader("keyed", "first");
    const Late = makeReader("keyed", "late");
    function Page(): ReactNode {
      const [shown, setShown] = useState(false);
      return (
        <>
          <First />
          <button data-testid="show-late" onClick={() => setShown(true)} />
          {shown && <Late />}
        </>
      );
    }
    const { router } = await renderRoute([{ path: "/p", Component: Page }], {
      request: url("a"),
      loaders: [[DataLoader, { label: "A route data" }]],
    });
    await refreshNow(router, "A refreshed", "first");

    frames = [];
    fireEvent.click(document.querySelector('[data-testid="show-late"]')!);
    await settle();
    expect(text("late")).toBe("A refreshed");
    expect(distinct(frames)).toEqual(["A refreshed"]);
  });
});

// A load() still in flight when its reader unmounts: the sticky bucket keeps
// its request slot (loader-store.ts), so the answer lands after the
// navigation, while a reader of another page is on screen.
describe("renderRoute: a load() in flight across the navigation", () => {
  it("A's late answer does not replace B's route data, nor show as B's loading", async () => {
    const { router } = await renderPages("keyed");
    await router.navigate(url("a"), at("a", { label: "A route data" }));

    const answer = await startPendingLoad(router);

    await router.navigate(url("home"), at("home"));
    await router.navigate(url("b"), at("b", { label: "B route data" }));
    await settle();
    expect(text("data")).toBe("B route data");
    expect(text("data-loading")).toBe("false");

    frames = [];
    await act(async () => answer.resolve({ label: "A late" }));
    await settle();
    expect(text("data")).toBe("B route data");
    expect(distinct(frames)).not.toContain("A late");
  });

  it("A's late failure does not show as B's error", async () => {
    const { router } = await renderPages("keyed");
    await router.navigate(url("a"), at("a", { label: "A route data" }));

    const answer = await startPendingLoad(router);

    await router.navigate(url("home"), at("home"));
    await router.navigate(url("b"), at("b", { label: "B route data" }));
    await act(async () => answer.reject(new Error("A failed")));
    await settle();
    expect(text("data")).toBe("B route data");
    expect(text("data-error")).toBe("");
    expect(text("data-loading")).toBe("false");
  });
});

// useLoader(L, { refreshGroup }) without a key refreshes a bucket of its own
// (use-loader.tsx). No other reader ever names that bucket, so it lives only
// as long as its reader.
describe("renderRoute: a refreshGroup reader without a key, after it unmounts", () => {
  /** Page A's reader mounted, and the bucket key it subscribed to. */
  async function openA(router: TestRouterHandle): Promise<string> {
    const subscribe = vi.spyOn(router.store.loaders, "subscribe");
    await router.navigate(url("a"), at("a", { label: "A route data" }));
    const bucketKey = subscribe.mock.calls
      .map(([key]) => key)
      .find((key) => key.startsWith(`${DataLoader.$$id}::`));
    subscribe.mockRestore();
    expect(bucketKey).toBeDefined();
    return bucketKey!;
  }

  /** No entry left: a reset entry would keep counting its request ids. */
  function expectFreed(router: TestRouterHandle, bucketKey: string): void {
    expect(router.store.loaders.getSnapshot(bucketKey)).toBe(
      EMPTY_LOADER_SNAPSHOT,
    );
    expect(router.store.loaders.reserveRequestId(bucketKey)).toBe(1);
  }

  it("its refreshed bucket is freed", async () => {
    const { router } = await renderPages("group");
    const bucketKey = await openA(router);
    await refreshNow(router, "A refreshed");
    expect(router.store.loaders.getSnapshot(bucketKey).value).toEqual({
      label: "A refreshed",
    });

    await router.navigate(url("home"), at("home"));
    await settle();
    expect(unmounts).toBe(1);
    expectFreed(router, bucketKey);
  });

  it("a refresh in flight at the unmount: freed once it settles", async () => {
    const { router } = await renderPages("group");
    const bucketKey = await openA(router);
    const answer = await startPendingLoad(router);

    await router.navigate(url("home"), at("home"));
    await settle();
    expect(unmounts).toBe(1);
    await act(async () => answer.resolve({ label: "A late" }));
    await settle();
    expectFreed(router, bucketKey);
  });
});

// A navigation a newer one replaced before its commit.
describe("renderRoute: a navigation aborted by a newer one", () => {
  it("A (refreshed) -> B held by transition() -> C: C's reader draws C's data", async () => {
    const { router } = await renderPages("keyed", { transition: {} });
    await router.navigate(url("a"), at("a", { label: "A route data" }));
    await refreshNow(router, "A refreshed");

    const held = deferred<Data>();
    await router.navigate(url("b"), at("b", held.promise));
    expect(text("data")).toBe("A refreshed");
    await router.navigate(url("c"), at("c", { label: "C route data" }));
    await settle();
    expect(text("data")).toBe("C route data");
    expect(distinct(framesOf.C!)).toEqual(["C route data"]);
    await act(async () => held.resolve({ label: "B late" }));
    await settle();
    expect(text("data")).toBe("C route data");
  });
});

// The same route with the next param: outside a transition() scope the route's
// segment key carries its params (segment-system.tsx), so the reader remounts
// with the new page, with no page without the loader in between.
describe.each([
  { id: "keyed", mode: "keyed" as const },
  { id: "no key", mode: "plain" as const },
  { id: "refreshGroup without a key", mode: "group" as const },
])(
  "renderRoute: a reader that remounts on the next param of one route ($id)",
  ({ mode }) => {
    it("/items/1 (refreshed) -> /items/2: the second item's data", async () => {
      const { router } = await renderRoute(
        [{ path: "/items/:id", Component: makeReader(mode) }],
        {
          request: "/items/1",
          loaders: [[DataLoader, { label: "item 1" }]],
        },
      );
      await refreshNow(router, "item 1 refreshed");

      frames = [];
      await router.navigate("/items/2", {
        loaders: [[DataLoader, { label: "item 2" }]],
      });
      await settle();
      expect(mounts).toBe(2);
      expect(distinct(frames)).toEqual(["item 2"]);
      expect(text("data")).toBe("item 2");
    });
  },
);

// The endpoint answers a plain load() only.
describe("renderRoute: a load() with params", () => {
  it("is answered with a loaderError, not passed to the real fetch", async () => {
    const realFetch = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", realFetch);
    function Reader(): ReactNode {
      const { load, error } = useLoader(DataLoader, {
        key: "k",
        throwOnError: false,
      });
      return (
        <>
          <p data-testid="data-error">{error?.message ?? ""}</p>
          <button
            data-testid="data-params"
            onClick={() => void load({ params: { q: "1" } }).catch(() => {})}
          />
        </>
      );
    }
    await renderRoute(
      [{ path: "/p", Component: Reader, loaderIds: [DataLoader.$$id] }],
      {
        request: url("a"),
        loaders: [[DataLoader, { label: "A route data" }]],
      },
    );

    fireEvent.click(document.querySelector('[data-testid="data-params"]')!);
    await waitFor(() =>
      expect(text("data-error")).toMatch(/does not answer parameterized load/),
    );
    expect(realFetch).not.toHaveBeenCalled();
  });
});

// A hidden <Activity> runs its children's effect cleanup as an unmount does.
// skills/hooks/data.md: a grouped read without a key is back on the route's
// data when it shows again; a key keeps the refreshed value.
describe.each([
  { id: "without a key", mode: "group" as const, shown: "A route data" },
  { id: "with a key", mode: "keyedGroup" as const, shown: "A refreshed" },
])(
  "renderRoute: a refreshGroup reader $id inside a hidden <Activity>",
  ({ mode, shown }) => {
    it("shows again with " + shown, async () => {
      const Reader = makeReader(mode);
      function Route(): ReactNode {
        const [visible, setVisible] = useState(true);
        return (
          <>
            <button
              data-testid="toggle"
              onClick={() => setVisible((v) => !v)}
            />
            <Activity mode={visible ? "visible" : "hidden"}>
              <Reader />
            </Activity>
          </>
        );
      }
      const { router } = await renderRoute([{ path: "/p", Component: Route }], {
        request: url("a"),
        loaders: [[DataLoader, { label: "A route data" }]],
      });
      await refreshNow(router, "A refreshed");

      fireEvent.click(document.querySelector('[data-testid="toggle"]')!);
      await settle();
      expect(unmounts).toBe(1);
      fireEvent.click(document.querySelector('[data-testid="toggle"]')!);
      await settle();
      expect(mounts).toBe(2);
      expect(text("data")).toBe(shown);
    });
  },
);
