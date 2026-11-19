// @vitest-environment happy-dom
import { Suspense, use, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createHandle } from "../../handle.js";
import { useHandle } from "../../browser/react/use-handle.js";
import {
  useFetchLoader,
  useLoader,
  useRefreshLoaders,
  useSearchParams,
} from "../../client.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";

/**
 * Userland: the handle values a loader read (`load()`) pushes, applied to the
 * page from the reply, against the page's history entry and the reads that
 * race it. What the page shows is read from the DOM a consumer renders.
 */

const Titles = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_loader_read_titles__",
);
const ItemLoader = {
  __brand: "loader",
  $$id: "loader-read#ItemLoader",
} as unknown as LoaderDefinition<string>;

const text = (id: string): string =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

function TitleReader(): ReactNode {
  return <p data-testid="title">{useHandle(Titles).join(" / ")}</p>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (ms = 20) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "");
});

describe("a loader read's handle values", () => {
  it("a read applied while the document is still hydrating shows once it hydrated, and its history entry keeps it for Back", async () => {
    // A boundary that suspends on the client only (a lazy chunk still
    // loading) keeps the hydration window open after the document is
    // revealed.
    const chunk = deferred<void>();
    function ClientChunk({ children }: { children: ReactNode }) {
      if (typeof window !== "undefined") use(chunk.promise);
      return children;
    }
    function Page(): ReactNode {
      const { data, load } = useLoader(ItemLoader);
      return (
        <>
          <TitleReader />
          <p data-testid="data">{data}</p>
          <button data-testid="load" onClick={() => void load()} />
          <Suspense fallback={<i>loading</i>}>
            <ClientChunk>
              <p>later</p>
            </ClientChunk>
          </Suspense>
        </>
      );
    }
    const { router, getByTestId } = await renderRoute(
      [{ path: "/items", Component: Page }],
      {
        request: "/items?id=1",
        loaders: [[ItemLoader, "one"]],
        handles: [[Titles, ["Item one"]]],
        hydrate: true,
      },
    );
    router.respondToLoads({
      loaders: [[ItemLoader, "renamed"]],
      handles: [[Titles, ["Renamed"]]],
    });
    await act(async () => {
      fireEvent.click(getByTestId("load"));
    });
    await tick();
    // The reply arrived and its values wait: the window is open, and readers
    // show the document's values until every boundary hydrated.
    expect(router.eventController.getHydrationSnapshot()).toBeDefined();
    expect(text("title")).toBe("Item one");

    await act(async () => chunk.resolve());
    await tick();
    expect(router.eventController.getHydrationSnapshot()).toBeUndefined();
    expect(text("data")).toBe("renamed");
    // The seeded value is the route handler's; the read's follows it.
    expect(text("title")).toBe("Item one / Renamed");
    // What a back/forward onto the entry restores (the history cache).
    const entry = router.store.getCachedSegments(router.store.getHistoryKey());
    expect(Object.values(entry?.handleData?.[Titles.$$id] ?? {})).toEqual([
      ["Item one", "Renamed"],
    ]);
  });

  it("a newer read that fails: the page keeps the data and title it showed, and the older read's never show", async () => {
    function Page(): ReactNode {
      const { data, error, load } = useLoader(ItemLoader, {
        throwOnError: false,
      });
      return (
        <>
          <TitleReader />
          <p data-testid="data">{data}</p>
          <p data-testid="error">{error?.message ?? ""}</p>
          <button data-testid="load" onClick={() => void load()} />
        </>
      );
    }
    const { router, getByTestId } = await renderRoute(
      [{ path: "/items", Component: Page }],
      {
        request: "/items?id=1",
        loaders: [[ItemLoader, "one"]],
        handles: [[Titles, ["Item one"]]],
      },
    );
    const older = deferred<string>();
    router.respondToLoads({
      loaders: [[ItemLoader, older.promise]],
      handles: [[Titles, ["Older"]]],
    });
    await act(async () => {
      fireEvent.click(getByTestId("load"));
    });
    const failed = Promise.reject(new Error("offline"));
    failed.catch(() => {});
    router.respondToLoads({
      loaders: [[ItemLoader, failed]],
      handles: [[Titles, ["Newer"]]],
    });
    await act(async () => {
      fireEvent.click(getByTestId("load"));
    });
    await tick();
    expect(text("error")).toBe("offline");

    await act(async () => older.resolve("older"));
    await tick();
    // As a navigation superseded by one that fails: the page stays what it
    // was, its data and its title together.
    expect(text("data")).toBe("one");
    expect(text("title")).toBe("Item one");
  });
});

// Back onto a page whose data a read refreshed: the history entry is the
// page as the screen showed it, its data and its title together.
interface Item {
  name: string;
}
const ObjLoader = {
  __brand: "loader",
  $$id: "loader-read#ObjLoader",
} as unknown as LoaderDefinition<Item>;

type Shape = "plain" | "keyed" | "group" | "selector" | "both";

/** One reader of ObjLoader per shape, with its own way to refresh. */
function Reader({ shape }: { shape: Shape }): ReactNode {
  const refreshGroups = useRefreshLoaders();
  const { data, load } = useLoader(
    ObjLoader,
    shape === "keyed"
      ? { key: "k" }
      : shape === "group"
        ? { refreshGroup: "live" }
        : undefined,
  );
  const refresh = (): void =>
    void (shape === "group" ? refreshGroups("live") : load());
  return (
    <>
      <p data-testid="data">{data.name}</p>
      <button data-testid="load" onClick={refresh} />
    </>
  );
}

function SelectedTitle(): ReactNode {
  return <p data-testid="title">{useHandle(Titles, (t) => t.join(" / "))}</p>;
}

/** One component reading the loader and the handle together. */
function Both(): ReactNode {
  const { data, load } = useLoader(ObjLoader);
  const titles = useHandle(Titles);
  return (
    <>
      <p data-testid="data">{data.name}</p>
      <p data-testid="title">{titles.join(" / ")}</p>
      <button data-testid="load" onClick={() => void load()} />
    </>
  );
}

/** The page; with `onlyOn`, its reader renders only on that `id`. */
function pageOf(shape: Shape, onlyOn?: string) {
  return function Page(): ReactNode {
    const [search] = useSearchParams();
    if (onlyOn !== undefined && search.get("id") !== onlyOn) {
      return <TitleReader />;
    }
    if (shape === "both") return <Both />;
    return (
      <>
        {shape === "selector" ? <SelectedTitle /> : <TitleReader />}
        <Reader shape={shape} />
      </>
    );
  };
}

type Router = Awaited<ReturnType<typeof renderRoute>>["router"];

async function renderItemOne(Page: () => ReactNode) {
  return renderRoute([{ path: "/items", Component: Page }], {
    request: "/items?id=1",
    loaders: [[ObjLoader, { name: "one" }]],
    handles: [[Titles, ["Item one"]]],
  });
}

function respondRenamed(
  router: Router,
  value: Item | Promise<Item> = { name: "renamed" },
): void {
  router.respondToLoads({
    loaders: [[ObjLoader, value]],
    handles: [[Titles, ["Renamed"]]],
  });
}

const click = (testId: string) =>
  act(async () => {
    fireEvent.click(document.querySelector(`[data-testid="${testId}"]`)!);
  });

const navigateToTwo = (router: Router) =>
  router.navigate("/items?id=2", {
    loaders: [[ObjLoader, { name: "two" }]],
    handles: [[Titles, ["Item two"]]],
    state: [],
  });

const goBack = () =>
  act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 20));
  });

const shown = (): string[] => [text("data"), text("title")];

describe("Back shows the page as it was left", () => {
  it("Back after a same-route navigation shows the refreshed data with its title", async () => {
    const { router } = await renderItemOne(pageOf("plain"));
    respondRenamed(router);
    await click("load");
    await tick();
    expect(shown()).toEqual(["renamed", "Item one / Renamed"]);
    await navigateToTwo(router);
    expect(shown()).toEqual(["two", "Item two"]);
    await goBack();
    expect(shown()).toEqual(["renamed", "Item one / Renamed"]);
  });

  it("Back after the reader unmounted", async () => {
    const { router } = await renderItemOne(pageOf("plain", "1"));
    respondRenamed(router);
    await click("load");
    await tick();
    await navigateToTwo(router);
    expect(shown()).toEqual(["", "Item two"]);
    await goBack();
    expect(shown()).toEqual(["renamed", "Item one / Renamed"]);
  });

  it("a read that replies after the page was left lands on its own entry: Back shows its data and title", async () => {
    const { router } = await renderItemOne(pageOf("plain", "1"));
    let reply!: (value: Item) => void;
    respondRenamed(router, new Promise<Item>((r) => (reply = r)));
    await click("load");
    await navigateToTwo(router);
    await act(async () => reply({ name: "renamed" }));
    await tick();
    // The page on screen is not the read's: its title stays.
    expect(shown()).toEqual(["", "Item two"]);
    await goBack();
    expect(shown()).toEqual(["renamed", "Item one / Renamed"]);
  });

  it("a read in flight across a navigation to new params of the route lands nowhere", async () => {
    const { router } = await renderItemOne(pageOf("plain"));
    let reply!: (value: Item) => void;
    respondRenamed(router, new Promise<Item>((r) => (reply = r)));
    await click("load");
    await navigateToTwo(router);
    await act(async () => reply({ name: "renamed" }));
    await tick();
    expect(shown()).toEqual(["two", "Item two"]);
    await goBack();
    expect(shown()).toEqual(["one", "Item one"]);
  });

  it("a read lands across an action that kept its loader, and Back keeps both", async () => {
    const { router } = await renderItemOne(pageOf("plain"));
    let reply!: (value: Item) => void;
    respondRenamed(router, new Promise<Item>((r) => (reply = r)));
    await click("load");
    // The action re-renders the page; the loader keeps its data.
    await router.action();
    await act(async () => reply({ name: "renamed" }));
    await tick();
    expect(shown()).toEqual(["renamed", "Item one / Renamed"]);
    await navigateToTwo(router);
    await goBack();
    expect(shown()).toEqual(["renamed", "Item one / Renamed"]);
  });

  it("an action that re-runs the loader after a read replaces the read's data and title", async () => {
    const { router } = await renderItemOne(pageOf("plain"));
    respondRenamed(router);
    await click("load");
    await tick();
    await router.action({
      loaders: [[ObjLoader, { name: "acted" }]],
      handles: [[Titles, ["Item acted"]]],
    });
    expect(shown()).toEqual(["acted", "Item acted"]);
    await navigateToTwo(router);
    await goBack();
    expect(shown()).toEqual(["acted", "Item acted"]);
  });

  it.each<Shape>(["keyed", "group", "selector", "both"])(
    "Back shows the read's data and title to a %s reader",
    async (shape) => {
      const { router } = await renderItemOne(pageOf(shape));
      respondRenamed(router);
      await click("load");
      await tick();
      expect(shown()).toEqual(["renamed", "Item one / Renamed"]);
      await navigateToTwo(router);
      await goBack();
      expect(shown()).toEqual(["renamed", "Item one / Renamed"]);
    },
  );

  it("a late document push keeps the read's title", async () => {
    const { router } = await renderItemOne(pageOf("plain"));
    respondRenamed(router);
    await click("load");
    await tick();
    // The route handler's values arrive late; the read's stay beside them.
    await router.pushLateHandles([[Titles, ["Item one", "Late"]]]);
    expect(shown()).toEqual(["renamed", "Item one / Late / Renamed"]);
    // The loader's own late push from the document is older than the read.
    await router.pushLateHandles([[Titles, ["Item one (document)"]]], {
      pushedBy: ObjLoader,
    });
    expect(text("title")).toBe("Item one / Late / Renamed");
    // The entry is written from what the page shows.
    const entry = router.store.getCachedSegments(router.store.getHistoryKey());
    expect(Object.values(entry?.handleData?.[Titles.$$id] ?? {})).toEqual([
      ["Item one", "Late", "Renamed"],
    ]);
    await navigateToTwo(router);
    await goBack();
    expect(shown()).toEqual(["renamed", "Item one / Late / Renamed"]);
  });

  it("a load() of a loader the page does not register keeps its data and leaves the title, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const SearchLoader = {
      __brand: "loader",
      $$id: "loader-read#SearchLoader",
    } as unknown as LoaderDefinition<Item>;
    function Search(): ReactNode {
      const { data, load } = useFetchLoader(SearchLoader);
      return (
        <>
          <p data-testid="search">{data?.name ?? "none"}</p>
          <button data-testid="search-load" onClick={() => void load()} />
        </>
      );
    }
    function Page(): ReactNode {
      return (
        <>
          <TitleReader />
          <Reader shape="plain" />
          <Search />
        </>
      );
    }
    const { router } = await renderItemOne(Page);
    router.respondToLoads({
      loaders: [[SearchLoader, { name: "found" }]],
      handles: [[Titles, ["Found"]]],
    });
    await click("search-load");
    await tick();
    expect([text("search"), ...shown()]).toEqual(["found", "one", "Item one"]);
    const warned = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) =>
        message.includes('Loader "loader-read#SearchLoader"'),
      );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("no segment on this page registers it");
    warn.mockRestore();
  });
});

describe("renderRoute's history entries", () => {
  it("Back restores the page from the store's history cache", async () => {
    const { router } = await renderItemOne(pageOf("plain"));
    const key = router.store.getHistoryKey();
    const segmentId = router.segmentId();
    await navigateToTwo(router);
    // What production's history cache holds is what Back renders.
    router.store.updateCacheHandleData(key, {
      [Titles.$$id]: { [segmentId]: ["From the cache"] },
    });
    await goBack();
    expect(text("title")).toBe("From the cache");
  });

  it("action() and refresh() re-cache the entry on screen", async () => {
    const { router } = await renderItemOne(pageOf("plain"));
    const key = router.store.getHistoryKey();
    const loaderData = () =>
      router.store
        .getCachedSegments(key)
        ?.segments.find((s) => s.loaderId === ObjLoader.$$id)?.loaderData;
    expect(loaderData()).toEqual({ name: "one" });
    await router.action({ loaders: [[ObjLoader, { name: "acted" }]] });
    expect(loaderData()).toEqual({ name: "acted" });
    await router.refresh({ loaders: [[ObjLoader, { name: "refreshed" }]] });
    expect(loaderData()).toEqual({ name: "refreshed" });
  });
});
