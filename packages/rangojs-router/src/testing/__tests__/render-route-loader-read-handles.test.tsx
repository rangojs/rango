// @vitest-environment happy-dom
import { Suspense, use, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createHandle } from "../../handle.js";
import { useHandle } from "../../browser/react/use-handle.js";
import { useLoader } from "../../use-loader.js";
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
