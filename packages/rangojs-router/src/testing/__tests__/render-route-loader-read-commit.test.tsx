// @vitest-environment happy-dom
import { Component, use, useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createHandle } from "../../handle.js";
import { useHandle } from "../../browser/react/use-handle.js";
import {
  Outlet,
  useLoader,
  useRefreshLoaders,
  useSearchParams,
} from "../../client.js";
import type { LoaderDefinition } from "../../types.js";
import { WIRE } from "../../wire-params.js";
import { renderRoute } from "../render-route.js";

/**
 * Userland: a page read (`load()`, a group refresh) against a commit onto the
 * page that kept the loader (a server action that did not re-run it). The
 * commit's tree is built from the page's history entry, which holds the data
 * of the reads that landed before it was built, and React commits it later:
 * a read that lands in between, or is in flight across it, is newer than what
 * the tree carries. What the page shows is read from the DOM a consumer
 * renders.
 */

interface Item {
  name: string;
}
const ItemLoader = {
  __brand: "loader",
  $$id: "loader-read-commit#ItemLoader",
} as unknown as LoaderDefinition<Item>;
// A second loader of the page, which the action re-runs.
const CountLoader = {
  __brand: "loader",
  $$id: "loader-read-commit#CountLoader",
} as unknown as LoaderDefinition<{ count: number; page?: string }>;
// A loader whose result is a string: no identity to record.
const NoteLoader = {
  __brand: "loader",
  $$id: "loader-read-commit#NoteLoader",
} as unknown as LoaderDefinition<string>;
const Titles = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_loader_read_commit_titles__",
);

const text = (id: string): string =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A test that never rejects it leaves nothing unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const tick = (ms = 20) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

const click = (testId: string) =>
  act(async () => {
    fireEvent.click(document.querySelector(`[data-testid="${testId}"]`)!);
  });

// While set, the page's next render suspends on it: React holds the commit
// that render belongs to, as it holds a transition whose content is not ready.
let hold: Promise<void> | undefined;
function Held(): null {
  if (hold) use(hold);
  return null;
}
// Set before a held commit is released: the page then renders a second
// reader of the item, which mounts with that commit.
let lateReader = false;
// Set before the render: the layout's reader remounts on each page, and a
// keyed reader of the item sits beside it.
let remountReader = false;
let keyedSibling = false;
// Set before the render: the readers sit in the route's component, mounted
// per page (CountLoader's `page`), not in the layout.
let leafReader = false;
// Every committed frame of the main reader's data, from the moment a test
// clears it.
let frames: string[] = [];
// Set before the render: readers take a failed read as `error`
// (throwOnError: false) instead of throwing it.
let quietErrors = false;

type Shape = "plain" | "keyed" | "group";

/** One reader of ItemLoader per shape, with its own way to refresh. */
function Reader({ shape, id = "" }: { shape: Shape; id?: string }): ReactNode {
  const refreshGroups = useRefreshLoaders();
  const bucket =
    shape === "keyed"
      ? { key: "k" }
      : shape === "group"
        ? { refreshGroup: "live" }
        : undefined;
  const { data, isLoading, error, load } = useLoader(
    ItemLoader,
    quietErrors ? { ...bucket, throwOnError: false } : bucket,
  );
  useLayoutEffect(() => {
    if (id === "") frames.push(data.name);
  });
  // A failed read is asserted where the hook reports it (`error`, or the
  // error boundary with throwOnError); the button ignores the rejection.
  const refresh = (): void =>
    void (shape === "group" ? refreshGroups("live") : load()).catch(
      () => undefined,
    );
  return (
    <>
      <p data-testid={`${id}data`}>{data.name}</p>
      <p data-testid={`${id}loading`}>{String(isLoading)}</p>
      <p data-testid={`${id}error`}>{error?.message ?? "none"}</p>
      <button data-testid={`${id}load`} onClick={refresh} />
      <button
        data-testid={`${id}load-params`}
        onClick={() => void load({ params: { q: "local" } })}
      />
    </>
  );
}

/** The error boundary a reader's thrown read (throwOnError) reaches. */
class Caught extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  override render(): ReactNode {
    return this.state.error ? (
      <p data-testid="caught">{this.state.error.message}</p>
    ) : (
      this.props.children
    );
  }
}

function pageOf(shape: Shape, sibling?: Shape) {
  return function Page(): ReactNode {
    return (
      <>
        <p data-testid="title">{useHandle(Titles).join(" / ")}</p>
        <Reader shape={shape} />
        {sibling && <Reader shape={sibling} id="sibling-" />}
        <Held />
      </>
    );
  };
}

type Router = Awaited<ReturnType<typeof renderRoute>>["router"];

// How the server's data for the item reaches the page. Production streams
// it: the page's history entry holds the promise, the reader what it
// resolved to. A test's plain seed is one object for both.
let sentAs: "a value" | "a stream" = "a value";
const itemOne = (): Item | Promise<Item> =>
  sentAs === "a stream" ? Promise.resolve({ name: "one" }) : { name: "one" };

async function renderItem(shape: Shape, sibling?: Shape): Promise<Router> {
  const { router } = await renderRoute(
    [{ path: "/items", Component: pageOf(shape, sibling) }],
    {
      request: "/items?id=1",
      loaders: [
        [ItemLoader, itemOne()],
        [CountLoader, { count: 0 }],
      ],
      handles: [[Titles, ["Item one"]]],
    },
  );
  return router;
}

/** What a read of the item answers from now on, and the title it pushes. */
function respond(
  router: Router,
  name: string,
  value: Item | Promise<Item> = { name },
): void {
  router.respondToLoads({
    loaders: [[ItemLoader, value]],
    handles: [[Titles, [name]]],
  });
}

/** A read that landed: the page shows it, and its entry holds it. */
async function landRead(router: Router, name: string): Promise<void> {
  respond(router, name);
  await click("load");
  await tick();
  // A loaded machine can take longer than one tick to answer: wait for the
  // screen, whatever bucket the reader's shape reads.
  for (let i = 0; text("data") !== name && i < 50; i++) await tick();
  expect(text("data")).toBe(name);
}

const shown = (): string[] => [text("data"), text("title")];

const entryData = (router: Router): unknown =>
  router.store
    .getCachedSegments(router.store.getHistoryKey())
    ?.segments.find((s) => s.loaderId === ItemLoader.$$id)?.loaderData;

const goBack = () =>
  act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 20));
  });

const goForward = () =>
  act(async () => {
    window.history.forward();
    await new Promise((r) => setTimeout(r, 20));
  });

// renderRoute's loader endpoint answers plain reads only: a load({ params })
// gets the same answer here, its params dropped.
let endpoint: typeof fetch | undefined;
function answerParamsLoads(): void {
  const answer = (endpoint = globalThis.fetch);
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    url.searchParams.delete(WIRE.loaderParams);
    return answer(url.toString(), init);
  };
}

afterEach(() => {
  // Back to renderRoute's endpoint, which its unmount then removes.
  if (endpoint) globalThis.fetch = endpoint;
  endpoint = undefined;
  hold = undefined;
  lateReader = false;
  remountReader = false;
  keyedSibling = false;
  leafReader = false;
  quietErrors = false;
  frames = [];
  cleanup();
  window.history.replaceState(null, "");
});

const SHAPES: Shape[] = ["plain", "keyed", "group"];

describe.each(["a value", "a stream"] as const)(
  "the item's data sent as %s",
  (wire) => {
    beforeEach(() => {
      sentAs = wire;
    });

    describe("a page read against an action's commit that kept its loader", () => {
      it.each(SHAPES)(
        "a %s reader's read in flight across the commit lands, and stays loading until it does",
        async (shape) => {
          const router = await renderItem(shape);
          await landRead(router, "first");
          expect(shown()).toEqual(["first", "Item one / first"]);

          const reply = deferred<Item>();
          respond(router, "second", reply.promise);
          await click("load");
          expect(text("loading")).toBe("true");
          // The action keeps the item's loader: its tree carries the first
          // read's data, from the entry.
          await router.action();
          expect(shown()).toEqual(["first", "Item one / first"]);
          expect(text("loading")).toBe("true");

          await act(async () => reply.resolve({ name: "second" }));
          await tick();
          expect(shown()).toEqual(["second", "Item one / second"]);
          expect(text("loading")).toBe("false");
          expect(entryData(router)).toEqual({ name: "second" });
        },
      );

      it.each(SHAPES)(
        "a %s reader's read that lands between the action's answer and its commit stays",
        async (shape) => {
          const router = await renderItem(shape);
          await landRead(router, "first");

          // The action's answer keeps the item's loader and re-runs the count,
          // whose data is still streaming: the tree is built from the entry as
          // it is now and commits when that data is in.
          const count = deferred<{ count: number }>();
          const acted = router.action({
            loaders: [[CountLoader, count.promise]],
          });
          await tick();
          await landRead(router, "second");
          expect(shown()).toEqual(["second", "Item one / second"]);

          await act(async () => count.resolve({ count: 1 }));
          await acted;
          await tick();
          expect(shown()).toEqual(["second", "Item one / second"]);
          expect(entryData(router)).toEqual({ name: "second" });
        },
      );

      it.each(SHAPES)(
        "a %s reader's read that lands while React holds the action's commit stays",
        async (shape) => {
          const router = await renderItem(shape);
          await landRead(router, "first");

          const release = deferred<void>();
          hold = release.promise;
          // Handed to React, which holds it: the tree carries the first read.
          await router.action();
          await landRead(router, "second");

          hold = undefined;
          await act(async () => release.resolve());
          await tick();
          expect(shown()).toEqual(["second", "Item one / second"]);
          expect(entryData(router)).toEqual({ name: "second" });
        },
      );

      it("several reads that land before the commit: the last one stays", async () => {
        const router = await renderItem("plain");
        await landRead(router, "first");

        const count = deferred<{ count: number }>();
        const acted = router.action({
          loaders: [[CountLoader, count.promise]],
        });
        await tick();
        await landRead(router, "second");
        await landRead(router, "third");

        await act(async () => count.resolve({ count: 1 }));
        await acted;
        await tick();
        expect(shown()).toEqual(["third", "Item one / third"]);
        expect(entryData(router)).toEqual({ name: "third" });
      });

      it("Back onto the page shows the read that stayed", async () => {
        const router = await renderItem("plain");
        await landRead(router, "first");
        const count = deferred<{ count: number }>();
        const acted = router.action({
          loaders: [[CountLoader, count.promise]],
        });
        await tick();
        await landRead(router, "second");
        await act(async () => count.resolve({ count: 1 }));
        await acted;
        await tick();

        await router.navigate("/items?id=2", {
          loaders: [[ItemLoader, { name: "two" }]],
          handles: [[Titles, ["Item two"]]],
          state: [],
        });
        expect(shown()).toEqual(["two", "Item two"]);
        await goBack();
        expect(shown()).toEqual(["second", "Item one / second"]);
      });

      it("a reader of the loader on another bucket does not undo it", async () => {
        // The keyed reader refreshes; the plain one never did, so its bucket is
        // empty and it shows what the tree carries.
        const router = await renderItem("keyed", "plain");
        await landRead(router, "first");
        expect(text("sibling-data")).toBe("one");

        const count = deferred<{ count: number }>();
        const acted = router.action({
          loaders: [[CountLoader, count.promise]],
        });
        await tick();
        await landRead(router, "second");

        await act(async () => count.resolve({ count: 1 }));
        await acted;
        await tick();
        expect(shown()).toEqual(["second", "Item one / second"]);
        // The tree was built from the entry when it held the first read.
        expect(text("sibling-data")).toBe("first");
      });

      it("a plain reader and a keyed reader that each refreshed keep their own read", async () => {
        const router = await renderItem("plain", "keyed");
        await landRead(router, "plain read");
        respond(router, "keyed read");
        await click("sibling-load");
        await tick();
        // The entry holds the read that landed last.
        expect(entryData(router)).toEqual({ name: "keyed read" });

        frames = [];
        await router.action();
        expect(frames.every((name) => name === "plain read")).toBe(true);
        expect(text("data")).toBe("plain read");
        expect(text("sibling-data")).toBe("keyed read");
        expect(text("title")).toBe("Item one / keyed read");
      });

      // refresh() re-runs the loader, as production's router.refresh() does:
      // its tree carries the data the server sends, not the entry's read.
      it.each([
        [
          "the render's data again: a read in flight across it lands",
          undefined,
          [
            "first | Item one / first | loading true",
            "second | Item one / second",
          ],
        ],
        [
          "new data: a read in flight across it is dropped",
          { name: "refreshed" },
          [
            "refreshed | Item one / first | loading false",
            "refreshed | Item one / first",
          ],
        ],
      ] as const)("refresh() that sends %s", async (_, refreshed, expected) => {
        const router = await renderItem("plain");
        await landRead(router, "first");
        const reply = deferred<Item>();
        respond(router, "second", reply.promise);
        await click("load");
        expect(text("loading")).toBe("true");

        await router.refresh(
          refreshed && { loaders: [[ItemLoader, refreshed]] },
        );
        const after = [...shown(), `loading ${text("loading")}`];
        await act(async () => reply.resolve({ name: "second" }));
        await tick();
        expect([after.join(" | "), shown().join(" | ")]).toEqual(expected);
      });

      // It rewrites the page's own history entry: an update of the page.
      it("a navigation to the URL on screen that keeps the loader: a read in flight across it lands", async () => {
        const router = await renderItem("plain");
        await landRead(router, "first");
        const reply = deferred<Item>();
        respond(router, "second", reply.promise);
        await click("load");

        await router.navigate("/items?id=1");
        const after = [...shown(), `loading ${text("loading")}`];
        await act(async () => reply.resolve({ name: "second" }));
        await tick();
        expect([after.join(" | "), shown().join(" | ")]).toEqual([
          "first | Item one / first | loading true",
          "second | Item one / second",
        ]);
      });

      it("a failed read keeps its error across the commit, until the next read", async () => {
        quietErrors = true;
        const router = await renderItem("plain");
        await landRead(router, "first");
        const failed = deferred<Item>();
        failed.reject(new Error("boom"));
        respond(router, "failed", failed.promise);
        await click("load");
        await tick();
        const seen = () => `${text("data")} | error ${text("error")}`;
        const before = seen();

        await router.action();
        const after = seen();
        await landRead(router, "second");
        expect([before, after, seen()]).toEqual([
          "first | error boom",
          "first | error boom",
          "second | error none",
        ]);
      });
    });

    // A result that is a string has no identity: the update's tree hands it
    // as new data, and the reader resets as before.
    describe("a loader whose result is a string", () => {
      function Note(): ReactNode {
        const { data, isLoading, load } = useLoader(NoteLoader);
        return (
          <>
            <p data-testid="data">{data}</p>
            <p data-testid="loading">{String(isLoading)}</p>
            <button data-testid="load" onClick={() => void load()} />
          </>
        );
      }

      it("an update that kept the loader still resets its reader: a read in flight is dropped", async () => {
        const { router } = await renderRoute(
          [{ path: "/n", Component: Note }],
          {
            request: "/n",
            loaders: [
              [
                NoteLoader,
                sentAs === "a stream" ? Promise.resolve("seed") : "seed",
              ],
            ],
          },
        );
        router.respondToLoads({ loaders: [[NoteLoader, "first"]] });
        await click("load");
        await tick();
        const reply = deferred<string>();
        router.respondToLoads({ loaders: [[NoteLoader, reply.promise]] });
        await click("load");
        const before = `${text("data")} | loading ${text("loading")}`;

        await router.action();
        const after = `${text("data")} | loading ${text("loading")}`;
        await act(async () => reply.resolve("second"));
        await tick();
        expect([
          before,
          after,
          `${text("data")} | loading ${text("loading")}`,
        ]).toEqual([
          "first | loading true",
          "first | loading false",
          "first | loading false",
        ]);
      });
    });

    describe("a page read against a navigation that keeps a layout's loader", () => {
      function Layout(): ReactNode {
        return (
          <>
            <p data-testid="title">{useHandle(Titles).join(" / ")}</p>
            <Reader shape="plain" />
            <Outlet />
          </>
        );
      }
      // The destination's own loader: its stream holds a transition() page.
      function Leaf(): ReactNode {
        return <p data-testid="count">{useLoader(CountLoader).data.count}</p>;
      }

      // A navigation commit resets the loader's readers even when it kept the
      // loader: the next page's entry takes the layout's data, so a read's
      // result it carries is no longer one page's (LoaderStore.heldBy). The
      // read lands on the next page's entry and its title shows; the reader
      // shows the data the navigation carried.
      it("a read that lands while React holds the navigation: the reader resets to the data the navigation carried, the entry and the title take the read", async () => {
        const { router } = await renderRoute(
          [
            { path: "/", Component: Layout, loaderIds: [ItemLoader.$$id] },
            { path: "/p", Component: Leaf, transition: {} },
          ],
          {
            request: "/p?page=a",
            loaders: [
              [ItemLoader, itemOne()],
              [CountLoader, { count: 0 }],
            ],
            handles: [[Titles, ["Item one"], 0]],
          },
        );
        await landRead(router, "first");

        // The next page keeps the layout's loader: its tree carries the first
        // read's data, and React holds it until the page's own data is in.
        const count = deferred<{ count: number }>();
        await router.navigate("/p?page=b", {
          loaders: [[CountLoader, count.promise]],
        });
        expect(text("count")).toBe("0");
        await landRead(router, "second");
        expect(text("data")).toBe("second");

        await act(async () => count.resolve({ count: 1 }));
        await tick();
        expect(text("count")).toBe("1");
        expect(shown()).toEqual(["first", "Item one / second"]);
        expect(entryData(router)).toEqual({ name: "second" });
      });
    });

    describe("an action that re-runs the loader still replaces a read", () => {
      it("a read that lands before its commit gives way to the action's data and title", async () => {
        const router = await renderItem("plain");
        await landRead(router, "first");

        const count = deferred<{ count: number }>();
        const acted = router.action({
          loaders: [
            [ItemLoader, { name: "acted" }],
            [CountLoader, count.promise],
          ],
          handles: [[Titles, ["Item acted"]]],
        });
        await tick();
        await landRead(router, "second");

        await act(async () => count.resolve({ count: 1 }));
        await acted;
        await tick();
        expect(shown()).toEqual(["acted", "Item acted"]);
        expect(entryData(router)).toEqual({ name: "acted" });
      });

      it("a read in flight across its commit lands nowhere", async () => {
        const router = await renderItem("plain");
        await landRead(router, "first");

        const reply = deferred<Item>();
        respond(router, "second", reply.promise);
        await click("load");
        await router.action({
          loaders: [[ItemLoader, { name: "acted" }]],
          handles: [[Titles, ["Item acted"]]],
        });
        expect(shown()).toEqual(["acted", "Item acted"]);
        expect(text("loading")).toBe("false");

        await act(async () => reply.resolve({ name: "second" }));
        await tick();
        expect(shown()).toEqual(["acted", "Item acted"]);
        expect(entryData(router)).toEqual({ name: "acted" });
      });
    });

    describe("a read that lands after its page was left", () => {
      // Distinct component types per page, as distinct routes have: the
      // first page's reader unmounts and never resets the loader's bucket,
      // so its read lands while the second page's reader is on screen.
      function First(): ReactNode {
        return <Reader shape="plain" />;
      }
      function Second(): ReactNode {
        return <Reader shape="plain" />;
      }
      function Pages(): ReactNode {
        const [search] = useSearchParams();
        return (
          <>
            <p data-testid="title">{useHandle(Titles).join(" / ")}</p>
            {search.get("id") === "1" ? <First /> : <Second />}
          </>
        );
      }

      it("stays its own page's: Back shows it, not the next page's refresh", async () => {
        const { router } = await renderRoute(
          [{ path: "/items", Component: Pages }],
          {
            request: "/items?id=1",
            loaders: [[ItemLoader, itemOne()]],
            handles: [[Titles, ["Item one"]]],
          },
        );
        const reply = deferred<Item>();
        respond(router, "one, late", reply.promise);
        await click("load");
        await router.navigate("/items?id=2", {
          loaders: [[ItemLoader, { name: "two" }]],
          handles: [[Titles, ["Item two"]]],
          state: [],
        });
        await act(async () => reply.resolve({ name: "one, late" }));
        await tick();
        expect(shown()).toEqual(["two", "Item two"]);

        await landRead(router, "two, refreshed");
        expect(shown()).toEqual([
          "two, refreshed",
          "Item two / two, refreshed",
        ]);

        await goBack();
        expect(shown()).toEqual(["one, late", "Item one / one, late"]);
      });
    });

    describe("a read sent while React holds a navigation that re-runs the loader", () => {
      // One route: its reader stays mounted from page to page, and the item
      // is the route's own loader, so each page has its own. The read is sent
      // by the page being left and lands on the next page's entry.
      function Page(): ReactNode {
        return (
          <>
            <p data-testid="title">{useHandle(Titles).join(" / ")}</p>
            <Reader shape="plain" />
            <p data-testid="count">{useLoader(CountLoader).data.count}</p>
          </>
        );
      }

      it("is the next page's: the page left never shows that page's reads", async () => {
        const { router } = await renderRoute(
          [{ path: "/p", Component: Page, transition: {} }],
          {
            request: "/p?page=a",
            loaders: [
              [ItemLoader, itemOne()],
              [CountLoader, { count: 0 }],
            ],
            handles: [[Titles, ["Item one"]]],
          },
        );
        const two = { name: "two" };
        const count = deferred<{ count: number }>();
        await router.navigate("/p?page=b", {
          loaders: [
            [ItemLoader, two],
            [CountLoader, count.promise],
          ],
          handles: [[Titles, ["Item two"]]],
          state: [],
        });
        expect(text("count")).toBe("0");
        await landRead(router, "sent while held");
        await act(async () => count.resolve({ count: 1 }));
        await tick();
        expect(text("count")).toBe("1");

        // An update that keeps the loader, then a read of the page's own.
        await router.action({
          loaders: [
            [ItemLoader, two],
            [CountLoader, { count: 2 }],
          ],
        });
        await landRead(router, "two, refreshed");
        expect(text("data")).toBe("two, refreshed");

        await goBack();
        expect(shown()).toEqual(["one", "Item one"]);
        expect(text("loading")).toBe("false");
      });
    });

    describe("a reader that mounts with the update", () => {
      function Page(): ReactNode {
        return (
          <>
            <p data-testid="title">{useHandle(Titles).join(" / ")}</p>
            <Reader shape="plain" />
            {lateReader && <Reader shape="plain" id="sibling-" />}
            <Held />
          </>
        );
      }

      it("shows the read that landed before the update committed", async () => {
        const { router } = await renderRoute(
          [{ path: "/items", Component: Page }],
          {
            request: "/items?id=1",
            loaders: [[ItemLoader, itemOne()]],
            handles: [[Titles, ["Item one"]]],
          },
        );
        await landRead(router, "first");

        const release = deferred<void>();
        hold = release.promise;
        // Handed to React, which holds it: the tree carries the first read.
        await router.action();
        await landRead(router, "second");

        lateReader = true;
        hold = undefined;
        await act(async () => release.resolve());
        await tick();
        expect(shown()).toEqual(["second", "Item one / second"]);
        expect(text("sibling-data")).toBe("second");
      });
    });

    describe("two pages that share a held layout's loader", () => {
      // The layout's loader is kept from page to page: the second page's
      // entry takes what the first page's held, and each entry the reads
      // that landed on it.
      function Layout(): ReactNode {
        const [search] = useSearchParams();
        return (
          <>
            <p data-testid="title">{useHandle(Titles).join(" / ")}</p>
            {leafReader ? null : remountReader ? (
              <Reader key={search.get("page")} shape="plain" />
            ) : (
              <Reader shape="plain" />
            )}
            {keyedSibling && !leafReader && (
              <Reader shape="keyed" id="sibling-" />
            )}
            <Outlet />
          </>
        );
      }
      function Leaf(): ReactNode {
        const { data } = useLoader(CountLoader);
        return (
          <>
            {leafReader && <PageReaders key={data.page ?? "a"} />}
            <p data-testid="count">{data.count}</p>
          </>
        );
      }
      /** The readers a page's own component renders, mounted with it. */
      function PageReaders(): ReactNode {
        return (
          <>
            <Caught>
              <Reader shape="plain" />
            </Caught>
            {keyedSibling && <Reader shape="keyed" id="sibling-" />}
          </>
        );
      }

      async function renderPair(): Promise<Router> {
        const { router } = await renderRoute(
          [
            { path: "/", Component: Layout, loaderIds: [ItemLoader.$$id] },
            { path: "/p", Component: Leaf },
          ],
          {
            request: "/p?page=a",
            loaders: [
              [ItemLoader, itemOne()],
              [CountLoader, { count: 0 }],
            ],
            handles: [[Titles, ["Item one"], 0]],
          },
        );
        return router;
      }

      /** Page a with a read of its own, then page b, kept the loader. */
      async function onB(): Promise<Router> {
        const router = await renderPair();
        await landRead(router, "on a");
        await router.navigate("/p?page=b", {
          loaders: [[CountLoader, { count: 1 }]],
          state: [],
        });
        return router;
      }

      const page = (): string =>
        `${text("data")} | ${text("title")} | count ${text("count")}`;

      it("shows the page's own read, not the one that landed on the page left", async () => {
        const router = await onB();
        await landRead(router, "on b");
        expect(entryData(router)).toEqual({ name: "on b" });
        // An update on the second page hands its reader that page's read.
        await router.action({ loaders: [[CountLoader, { count: 2 }]] });
        expect(text("data")).toBe("on b");

        await goBack();
        expect(text("count")).toBe("0");
        expect(text("data")).toBe("on a");
        expect(entryData(router)).toEqual({ name: "on a" });
      });

      it("Back after a read and an update on the second page commits the first page's read from its first frame", async () => {
        const router = await onB();
        await landRead(router, "b1");
        await router.action({ loaders: [[CountLoader, { count: 2 }]] });
        expect(text("data")).toBe("b1");

        frames = [];
        await goBack();
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.every((name) => name === "on a")).toBe(true);
        expect(page()).toBe("on a | Item one / on a | count 0");
      });

      it("Back after a read, an update and a second read commits the first page's read from its first frame", async () => {
        const router = await onB();
        await landRead(router, "b1");
        await router.action({ loaders: [[CountLoader, { count: 2 }]] });
        await landRead(router, "b2");
        expect(text("data")).toBe("b2");

        frames = [];
        await goBack();
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.every((name) => name === "on a")).toBe(true);
        expect(page()).toBe("on a | Item one / on a | count 0");
      });

      it("a reader that remounts per page shows the first page's read on Back, and Forward the second page's entry", async () => {
        remountReader = true;
        const router = await onB();
        await landRead(router, "b1");
        await router.action({ loaders: [[CountLoader, { count: 2 }]] });
        await landRead(router, "b2");
        expect(text("data")).toBe("b2");

        frames = [];
        await goBack();
        expect(frames.every((name) => name === "on a")).toBe(true);
        expect(frames.length).toBeGreaterThan(0);
        expect(page()).toBe("on a | Item one / on a | count 0");

        frames = [];
        await goForward();
        expect(frames.every((name) => name === "b2")).toBe(true);
        expect(frames.length).toBeGreaterThan(0);
        expect(page()).toBe("b2 | Item one / b2 | count 2");
        expect(entryData(router)).toEqual({ name: "b2" });
      });

      it("a local load({ params }) result beside a keyed reader's read: as before across an update and Back", async () => {
        keyedSibling = true;
        const router = await onB();
        answerParamsLoads();
        respond(router, "sib b1");
        await click("sibling-load");
        await tick();
        respond(router, "b1");
        await click("load-params");
        await tick();
        const both = (): string => `${text("data")} / ${text("sibling-data")}`;
        const seen = [both()];

        await router.action({ loaders: [[CountLoader, { count: 2 }]] });
        seen.push(both());
        await goBack();
        seen.push(`${both()} | ${text("title")}`);
        // The update hands the keyed read's result, which the entry holds:
        // new data for the local result, which resets as before.
        expect(seen).toEqual([
          "b1 / sib b1",
          "sib b1 / sib b1",
          "on a / on a | Item one / on a",
        ]);
      });

      it("a read sent from the first page and in flight when the navigation commits never shows on the second", async () => {
        remountReader = true;
        const router = await renderPair();
        await landRead(router, "on a");
        const reply = deferred<Item>();
        respond(router, "late a", reply.promise);
        await click("load");
        expect(text("loading")).toBe("true");

        await router.navigate("/p?page=b", {
          loaders: [[CountLoader, { count: 1 }]],
          state: [],
        });
        expect(text("data")).toBe("on a");
        expect(text("loading")).toBe("false");

        frames = [];
        await act(async () => reply.resolve({ name: "late a" }));
        await tick();
        expect(frames.includes("late a")).toBe(false);
        expect(text("data")).toBe("on a");
        expect(text("loading")).toBe("false");
      });

      it("on the second page a read that lands while an update that kept the loader is on its way stays", async () => {
        const router = await onB();
        await landRead(router, "b1");

        const count = deferred<{ count: number }>();
        const acted = router.action({
          loaders: [[CountLoader, count.promise]],
        });
        await tick();
        await landRead(router, "b2");
        expect(text("data")).toBe("b2");

        frames = [];
        await act(async () => count.resolve({ count: 2 }));
        await acted;
        await tick();
        expect(frames.every((name) => name === "b2")).toBe(true);
        expect(page()).toBe("b2 | Item one / b2 | count 2");
        expect(entryData(router)).toEqual({ name: "b2" });
      });

      // The bucket's value and its latest request are judged apart: one
      // page's value never rides along with another page's request.
      /**
       * Page a's read sits in the plain bucket; on page b a keyed sibling's
       * read lands and a plain read is sent, its reply held.
       */
      async function bReadInFlight(): Promise<{
        router: Router;
        reply: ReturnType<typeof deferred<Item>>;
      }> {
        // The page's own reader mounts with it: nothing resets the bucket.
        leafReader = true;
        keyedSibling = true;
        const router = await renderPair();
        await landRead(router, "a read");
        await router.navigate("/p?page=b", {
          loaders: [[CountLoader, { count: 1, page: "b" }]],
          state: [],
        });
        expect(text("data")).toBe("a read");
        respond(router, "keyed b");
        await click("sibling-load");
        await tick();
        const reply = deferred<Item>();
        respond(router, "plain b", reply.promise);
        await click("load");
        return { router, reply };
      }

      const reader = (): string =>
        document.querySelector('[data-testid="caught"]')
          ? `caught ${text("caught")}`
          : `${text("data")} | loading ${text("loading")} | error ${text("error")}`;

      it.each([
        ["lands", "as `error`"],
        ["fails", "as `error`"],
        ["lands", "by throwing"],
        ["fails", "by throwing"],
      ] as const)(
        "the first page's read in the bucket never shows on the second page beside that page's read in flight, which %s (a failure reported %s)",
        async (outcome, reported) => {
          quietErrors = reported === "as `error`";
          const { router, reply } = await bReadInFlight();

          frames = [];
          await router.action({
            loaders: [[CountLoader, { count: 2, page: "b" }]],
          });
          const after = reader();
          await act(async () =>
            outcome === "lands"
              ? reply.resolve({ name: "plain b" })
              : reply.reject(new Error("boom")),
          );
          await tick();
          expect([after, reader()]).toEqual([
            "keyed b | loading true | error none",
            outcome === "lands"
              ? "plain b | loading false | error none"
              : quietErrors
                ? "keyed b | loading false | error boom"
                : "caught boom",
          ]);
          expect(frames.length).toBeGreaterThan(0);
          expect(frames.includes("a read")).toBe(false);
        },
      );

      it("without the update, that page's failed read reaches the error boundary", async () => {
        const { reply } = await bReadInFlight();
        await act(async () => reply.reject(new Error("boom")));
        await tick();
        expect(reader()).toBe("caught boom");
      });

      it("a read sent from the first page and in flight never shows on the second beside that page's own read", async () => {
        remountReader = true;
        keyedSibling = true;
        const router = await renderPair();
        await landRead(router, "a read");
        await router.navigate("/p?page=b", {
          loaders: [[CountLoader, { count: 1 }]],
          state: [],
        });
        await landRead(router, "b read");
        await goBack();
        const reply = deferred<Item>();
        respond(router, "a late", reply.promise);
        await click("load");
        await goForward();
        respond(router, "keyed b");
        await click("sibling-load");
        await tick();

        frames = [];
        await router.action({ loaders: [[CountLoader, { count: 2 }]] });
        await act(async () => reply.resolve({ name: "a late" }));
        await tick();
        expect(frames.includes("a late")).toBe(false);
        expect(`${text("data")} | loading ${text("loading")}`).toBe(
          "b read | loading false",
        );
      });

      it("a read sent from the first page, in flight across the navigation, does not land after an update on the second", async () => {
        keyedSibling = true;
        const router = await renderPair();
        const reply = deferred<Item>();
        respond(router, "late a", reply.promise);
        await click("load");
        await router.navigate("/p?page=b", {
          loaders: [[CountLoader, { count: 1 }]],
          state: [],
        });
        respond(router, "keyed b");
        await click("sibling-load");
        await tick();
        await router.action({ loaders: [[CountLoader, { count: 2 }]] });
        await act(async () => reply.resolve({ name: "late a" }));
        await tick();

        await goBack();
        expect(
          `${text("data")} | ${text("title")} | count ${text("count")}`,
        ).toBe("one | Item one | count 0");
      });
    });
  },
);
