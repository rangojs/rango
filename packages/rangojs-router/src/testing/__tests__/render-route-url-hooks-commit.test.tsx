// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memo, Profiler, Suspense, useEffect, type ReactNode } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import {
  Outlet,
  useHandle,
  useNavigation,
  useParams,
  usePathname,
  useSearchParams,
  useSegments,
} from "../../client.js";
import { createHandle } from "../../handle.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition, TransitionConfig } from "../../types.js";
import type { HistoryState } from "../../browser/types.js";
import { renderRoute } from "../render-route.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

// Consumer contract: the URL hooks show the page on screen, in
// every reader shape, on every screen. A nav menu's active link
// (usePathname), a tab bar (useSearchParams), a detail header (useParams, a
// selector or the whole map), a breadcrumb (useSegments) and a component that
// reads several of them read the URL useNavigation().location reads, also
// when an urgent page ends a hold React keeps on a transition() page.
// Browser proof: e2e hook-fields.test.ts (tests/shared-e2e/src/
// hook-fields-scenario.ts), both apps, dev and production.

const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;
const Titles = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_url_hooks_titles__",
);

/** One committed screen: the page, the full state's URL, each reader. */
interface Screen {
  page: string;
  url: string;
  readers: Record<string, string>;
}

let screens: Screen[];
let identities: string[];
let stub: ReturnType<typeof installViewTransitionStub> | undefined;

const value = (id: string): string =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.dataset.value ??
  "-";

const Reader = ({ id, value }: { id: string; value: string }): ReactNode => (
  <i data-testid={id} data-value={value} />
);

/** A nav menu's active link. */
function PathnameReader(): ReactNode {
  return <Reader id="pathname" value={usePathname()} />;
}

/** A detail header: the whole params map. */
function ParamsReader(): ReactNode {
  const params = useParams();
  return <Reader id="params" value={params.id ?? "-"} />;
}

/** A detail header: one param through a selector. */
function ParamReader(): ReactNode {
  return <Reader id="param" value={useParams((p) => p.id ?? "-")} />;
}

/** A tab bar. */
function SearchReader(): ReactNode {
  const [search] = useSearchParams();
  return <Reader id="search" value={search.get("tab") ?? "-"} />;
}

/** A breadcrumb: the path through a selector. */
function SegmentsReader(): ReactNode {
  return <Reader id="segments" value={useSegments((s) => s.path.join("/"))} />;
}

/** The whole segments state. */
function SegmentsLocationReader(): ReactNode {
  const { location } = useSegments();
  return (
    <Reader
      id="segments-location"
      value={location.pathname + location.search}
    />
  );
}

/** Several hooks in one component. */
function Crumb(): ReactNode {
  const pathname = usePathname();
  const id = useParams((p) => p.id);
  const [search] = useSearchParams();
  return (
    <Reader
      id="crumb"
      value={`${pathname} ${id} ${search.get("tab") ?? "-"}`}
    />
  );
}

const idOf = (url: URL): string => url.pathname.split("/")[2] ?? "-";
const tabOf = (url: URL): string => url.searchParams.get("tab") ?? "-";

/**
 * Each URL reader: its test id, what it shows for the URL the full state
 * reads, and the component, in the order the chrome renders them.
 */
const URL_READERS: ReadonlyArray<{
  id: string;
  part: (url: URL) => string;
  Component: () => ReactNode;
}> = [
  { id: "pathname", part: (url) => url.pathname, Component: PathnameReader },
  { id: "params", part: idOf, Component: ParamsReader },
  { id: "param", part: idOf, Component: ParamReader },
  { id: "search", part: tabOf, Component: SearchReader },
  {
    id: "segments",
    part: (url) => url.pathname.slice(1),
    Component: SegmentsReader,
  },
  {
    id: "segments-location",
    part: (url) => url.pathname + url.search,
    Component: SegmentsLocationReader,
  },
  {
    id: "crumb",
    part: (url) =>
      `${url.pathname} ${url.pathname.split("/")[2]} ${tabOf(url)}`,
    Component: Crumb,
  },
];

/** The full state: the URL every reader is held to. */
function Status(): ReactNode {
  const { location } = useNavigation();
  return (
    <i data-testid="status" data-value={location.pathname + location.search} />
  );
}

function Title(): ReactNode {
  return <Reader id="title" value={useHandle(Titles).at(-1) ?? "-"} />;
}

/**
 * An effect keyed on a reader's value, as `useEffect(fn, [searchParams])`
 * is: it logs the value it runs for and the number of screens committed
 * when it runs.
 */
function useIdentity(key: string, value: unknown, shown: string): void {
  useEffect(() => {
    identities.push(`${key} ${shown} on screen ${screens.length}`);
  }, [value]);
}

/** Readers whose value is an object. */
function Identities(): ReactNode {
  const params = useParams();
  const [search] = useSearchParams();
  const param = useParams((p) => ({ id: p.id }));
  const segments = useSegments((s) => ({ path: s.path.join("/") }));
  useIdentity("params", params, params.id ?? "-");
  useIdentity("search", search, search.get("tab") ?? "-");
  useIdentity("param", param, param.id ?? "-");
  useIdentity("segments", segments, segments.path);
  return null;
}

/**
 * Records a commit as a screen. A nested update (a set in a commit's layout
 * effects, as a page's release is) commits in the same task, before the
 * browser paints: it replaces the screen it follows.
 */
function record(_id: string, phase: string): void {
  if (phase === "nested-update") screens.pop();
  screens.push({
    page: document.querySelector('[data-testid="item"]')?.textContent ?? "-",
    url: value("status"),
    readers: Object.fromEntries(
      [...URL_READERS.map((r) => r.id), "title"].map((id) => [id, value(id)]),
    ),
  });
}

function Shell(): ReactNode {
  return (
    <Profiler id="chrome" onRender={record}>
      <Status />
      {URL_READERS.map(({ id, Component }) => (
        <Component key={id} />
      ))}
      <Title />
      <Identities />
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <Outlet />
      </Suspense>
    </Profiler>
  );
}

function Item(): ReactNode {
  return <p data-testid="item">{useLoader(ItemLoader).data}</p>;
}

function deferred<T = string>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const task = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

/** The distinct screens from the `from`th on, in order. */
function distinct(from = 0): Screen[] {
  return screens
    .slice(from)
    .filter(
      (s, i, all) =>
        i === 0 || JSON.stringify(all[i - 1]) !== JSON.stringify(s),
    );
}

/**
 * Each URL reader that disagrees with the full state's URL on a screen from
 * the `from`th on, as "page N: <reader> <value> | full state <part>".
 */
function torn(from = 0): string[] {
  return distinct(from).flatMap((s) => {
    const url = new URL(s.url, "http://localhost");
    return URL_READERS.flatMap(({ id, part }) =>
      s.readers[id] === part(url)
        ? []
        : `page ${s.page}: ${id} ${s.readers[id]} | full state ${part(url)}`,
    );
  });
}

/** Each distinct screen as "page | URL | title". */
const pages = (from = 0): string[] =>
  distinct(from).map((s) => `${s.page} | ${s.url} | ${s.readers.title}`);

beforeEach(() => {
  screens = [];
  identities = [];
  stub = undefined;
});

afterEach(() => {
  cleanup();
  stub?.uninstall();
});

/**
 * Mounts page 1, then navigates to page 2, a transition() page React holds:
 * its loader and its response's tail stay open until the test settles them.
 */
async function holdPage2(
  vt: boolean,
  transition: TransitionConfig = {},
  history?: { state: HistoryState },
) {
  if (vt) stub = installViewTransitionStub();
  const mounted = await renderRoute(
    [
      { path: "/items/:id", Component: Shell },
      { path: "/items/:id", Component: Item, transition },
    ],
    {
      request: "/items/1?tab=1",
      loaders: [[ItemLoader, "1"]],
      handles: [[Titles, ["Item 1"]]],
    },
  );
  const page = deferred();
  const tail = deferred<void>();
  await mounted.router.navigate("/items/2?tab=2", {
    loaders: [[ItemLoader, page.promise]],
    handles: [[Titles, ["Item 2"]]],
    streamUntil: tail.promise,
    ...history,
  });
  await task();
  expect(mounted.getByTestId("item").textContent, "React holds page 2").toBe(
    "1",
  );
  return { ...mounted, page, tail };
}

/** Page 2's loader answers and React commits page 2. */
async function showPage2(
  { getByTestId }: { getByTestId: (id: string) => HTMLElement },
  page: { promise: Promise<string>; resolve: (v: string) => void },
) {
  await act(async () => {
    page.resolve("2");
    await page.promise;
  });
  await waitFor(() => expect(getByTestId("item").textContent).toBe("2"));
  await task();
}

describe.each([
  { variant: "view transitions supported", vt: true },
  { variant: "view transitions unsupported", vt: false },
])(
  "renderRoute: URL hook readers while a transition() page is held ($variant)",
  ({ vt }) => {
    it("a held page: every reader shows the page being left until the page commits, then the page", async () => {
      const mounted = await holdPage2(vt);
      expect(screens.at(-1)!.url).toBe("/items/1?tab=1");
      await act(async () => mounted.tail.resolve());
      await task();

      await showPage2(mounted, mounted.page);
      expect(torn()).toEqual([]);
      expect(pages()).toEqual([
        "1 | /items/1?tab=1 | Item 1",
        "2 | /items/2?tab=2 | Item 2",
      ]);
    });

    // The defect: the held page's set of /items/2 is not on
    // screen, and the urgent page brings the same values.
    it("a gated-off commit to the held URL ends the hold: the page shows with its URL in every reader", async () => {
      const mounted = await holdPage2(vt);
      await act(async () => mounted.tail.resolve());
      await task();
      identities = [];

      await act(async () => {
        await mounted.router.navigate("/items/2?tab=2", {
          loaders: [[ItemLoader, "2"]],
          handles: [[Titles, ["Item 2"]]],
          transition: false,
        });
      });
      await task();
      expect(mounted.getByTestId("item").textContent).toBe("2");
      expect(torn()).toEqual([]);
      // The title that arrived while the page was held waits for the
      // release, which the urgent page brings with it.
      expect(pages()).toEqual([
        "1 | /items/1?tab=1 | Item 1",
        "2 | /items/2?tab=2 | Item 2",
      ]);

      // The held page's late answer changes nothing on screen.
      const urgent = screens.length;
      await act(async () => mounted.page.resolve("late"));
      await task();
      expect(mounted.getByTestId("item").textContent).toBe("2");
      expect(torn(urgent)).toEqual([]);
      expect(
        pages(urgent).filter((p) => p !== "2 | /items/2?tab=2 | Item 2"),
      ).toEqual([]);

      // An effect keyed on an object reader's value runs once for the page,
      // on its first screen.
      const first = screens.findIndex((s) => s.page === "2") + 1;
      expect(identities).toEqual([
        `params 2 on screen ${first}`,
        `search 2 on screen ${first}`,
        `param 2 on screen ${first}`,
        `segments items/2 on screen ${first}`,
      ]);
    });

    it("a gated-off commit to another URL ends the hold: the page shows with its URL in every reader", async () => {
      const mounted = await holdPage2(vt);
      await act(async () => {
        await mounted.router.navigate("/items/3?tab=3", {
          loaders: [[ItemLoader, "3"]],
          handles: [[Titles, ["Item 3"]]],
          transition: false,
        });
      });
      await task();
      expect(mounted.getByTestId("item").textContent).toBe("3");

      await act(async () => {
        mounted.page.resolve("late");
        mounted.tail.resolve();
      });
      await task();
      expect(torn()).toEqual([]);
      expect(pages().map((p) => p.split(" | ")[1])).not.toContain(
        "/items/2?tab=2",
      );
      expect(screens.at(-1)!.url).toBe("/items/3?tab=3");
    });

    // A list page without transition(): Back to it restores its entry
    // urgently while React still holds page 2 (navigation-bridge.ts
    // handlePopstate, a history-cache restore).
    it("a Back without transition() ends the hold: the restored page shows with its URL in every reader", async () => {
      const mounted = await holdPage2(
        vt,
        { when: ({ to }) => to.params.id !== "1" },
        { state: { from: "list" } },
      );
      await act(async () => mounted.tail.resolve());
      await task();

      await act(async () => {
        window.history.back();
      });
      await task();
      expect(mounted.getByTestId("item").textContent).toBe("1");

      await act(async () => mounted.page.resolve("2"));
      await task();
      expect(torn()).toEqual([]);
      expect(screens.at(-1)!.url).toBe("/items/1?tab=1");
      expect(pages().map((p) => p.split(" | ")[1])).not.toContain(
        "/items/2?tab=2",
      );
    });

    it("a newer click while the page is held: the newer page shows with its URL in every reader, the held one never", async () => {
      const mounted = await holdPage2(vt);
      const newer = deferred();
      await act(async () => {
        await mounted.router.navigate("/items/3?tab=3", {
          loaders: [[ItemLoader, newer.promise]],
          handles: [[Titles, ["Item 3"]]],
        });
      });
      await task();
      expect(screens.at(-1)!.url).toBe("/items/1?tab=1");

      await act(async () => {
        mounted.page.resolve("2");
        newer.resolve("3");
        mounted.tail.resolve();
      });
      await waitFor(() =>
        expect(mounted.getByTestId("item").textContent).toBe("3"),
      );
      await task();
      expect(torn()).toEqual([]);
      expect(pages()).toEqual([
        "1 | /items/1?tab=1 | Item 1",
        "3 | /items/3?tab=3 | Item 3",
      ]);
    });

    it("a newer click aborted before its response while the page is held: the held page shows with its URL in every reader", async () => {
      const mounted = await holdPage2(vt);
      await act(async () => {
        const newer = mounted.router.navigate("/items/3?tab=3", {
          loaders: [[ItemLoader, "3"]],
        });
        // As navigation-bridge.ts does for a page restored from the
        // back/forward cache: the pending request only.
        mounted.router.eventController.abortNavigation(true);
        await newer;
      });
      await task();
      expect(screens.at(-1)!.url).toBe("/items/1?tab=1");

      await showPage2(mounted, mounted.page);
      expect(torn()).toEqual([]);
      expect(screens.at(-1)!.url).toBe("/items/2?tab=2");
    });

    it("a pending title that resolves while the page is held: the title and the URL commit with the page", async () => {
      if (vt) stub = installViewTransitionStub();
      const mounted = await renderRoute(
        [
          { path: "/items/:id", Component: Shell },
          { path: "/items/:id", Component: Item, transition: {} },
        ],
        {
          request: "/items/1?tab=1",
          loaders: [[ItemLoader, "1"]],
          handles: [[Titles, ["Item 1"]]],
        },
      );
      const page = deferred();
      const title = deferred();
      await mounted.router.navigate("/items/2?tab=2", {
        loaders: [[ItemLoader, page.promise]],
        handles: [[Titles, [title.promise]]],
      });
      await task();
      await act(async () => {
        title.resolve("Item 2");
        await title.promise;
      });
      await task();
      await showPage2(mounted, page);

      expect(torn()).toEqual([]);
      expect(pages()).toEqual([
        "1 | /items/1?tab=1 | Item 1",
        "2 | /items/2?tab=2 | Item 2",
      ]);
    });
  },
);

describe("renderRoute: URL hook readers on a page React does not hold", () => {
  it("transition: false, and a route without transition(): every reader shows the page with its URL", async () => {
    const mounted = await renderRoute(
      [
        { path: "/items/:id", Component: Shell },
        { path: "/items/:id", Component: Item },
      ],
      { request: "/items/1?tab=1", loaders: [[ItemLoader, "1"]] },
    );
    await act(async () => {
      await mounted.router.navigate("/items/2?tab=2", {
        loaders: [[ItemLoader, "2"]],
        transition: false,
      });
    });
    await task();
    await act(async () => {
      await mounted.router.navigate("/items/3?tab=3", {
        loaders: [[ItemLoader, "3"]],
      });
    });
    await task();
    expect(torn()).toEqual([]);
    expect(distinct().map((s) => `${s.page} | ${s.url}`)).toEqual([
      "1 | /items/1?tab=1",
      "2 | /items/2?tab=2",
      "3 | /items/3?tab=3",
    ]);
  });
});

// Render-phase calls of each memoized reader from the navigation on,
// discarded transition renders included: one for a transition() page, two for
// one React holds (the render it discards, then the page), three for a
// gated-off page that ends a hold (the discarded render, the urgent page, then
// React's render of the held lane, which bails out). A Back or Forward
// restored from the history cache renders each reader once; a revalidation
// that moves no URL value renders none. Every reader shape renders alike,
// useNavigation included.
describe("renderRoute: a URL hook reader renders once per value it shows", () => {
  const counts: Record<string, number> = {};
  const counted = (key: string, useValue: () => unknown) => {
    counts[key] = 0;
    return memo(function Counted(): ReactNode {
      counts[key] = (counts[key] ?? 0) + 1;
      return <i data-value={String(useValue())} />;
    });
  };
  const COUNTED = [
    counted("pathname", () => usePathname()),
    counted("params", () => useParams().id),
    counted("search", () => useSearchParams()[0].toString()),
    counted("nav", () => useNavigation((n) => n.location.pathname)),
    counted("segments", () => useSegments((s) => s.path.join("/"))),
  ];
  /** The same count for every reader. */
  const each = (n: number): Record<string, number> =>
    Object.fromEntries(Object.keys(counts).map((key) => [key, n]));

  function CountShell(): ReactNode {
    return (
      <>
        {COUNTED.map((Counted, i) => (
          <Counted key={i} />
        ))}
        <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
          <Outlet />
        </Suspense>
      </>
    );
  }

  function resetCounts(): void {
    for (const key of Object.keys(counts)) counts[key] = 0;
  }

  async function mountCounted() {
    const mounted = await renderRoute(
      [
        { path: "/items/:id", Component: CountShell },
        { path: "/items/:id", Component: Item, transition: {} },
      ],
      { request: "/items/1?tab=1", loaders: [[ItemLoader, "1"]] },
    );
    await task();
    resetCounts();
    return mounted;
  }

  async function holdPage(mounted: Awaited<ReturnType<typeof mountCounted>>) {
    const page = deferred();
    await mounted.router.navigate("/items/2?tab=2", {
      loaders: [[ItemLoader, page.promise]],
    });
    await task();
    expect(mounted.getByTestId("item").textContent).toBe("1");
    return page;
  }

  it("on a transition() page, one React holds, and a gated-off page that ends a hold", async () => {
    const transition = await mountCounted();
    await act(async () => {
      await transition.router.navigate("/items/2?tab=2", {
        loaders: [[ItemLoader, "2"]],
      });
    });
    await task();
    expect(transition.getByTestId("item").textContent).toBe("2");
    const onTransition = { ...counts };
    cleanup();

    const held = await mountCounted();
    await showPage2(held, await holdPage(held));
    const onHeld = { ...counts };
    cleanup();

    const gatedOff = await mountCounted();
    const page = await holdPage(gatedOff);
    await act(async () => {
      await gatedOff.router.navigate("/items/2?tab=2", {
        loaders: [[ItemLoader, "2"]],
        transition: false,
      });
    });
    await task();
    expect(gatedOff.getByTestId("item").textContent).toBe("2");
    await act(async () => page.resolve("late"));
    await task();
    const onGatedOff = { ...counts };

    expect({
      transition: onTransition,
      held: onHeld,
      gatedOff: onGatedOff,
    }).toEqual({
      transition: each(1),
      held: each(2),
      gatedOff: each(3),
    });
  });

  it("on a Back and a Forward restored from the history cache, and a revalidation", async () => {
    const mounted = await mountCounted();
    await act(async () => {
      await mounted.router.navigate("/items/2?tab=2", {
        // Pushes an entry, so Back restores page 1 from its own.
        state: { from: "list" },
        loaders: [[ItemLoader, "2"]],
      });
    });
    await task();
    expect(mounted.getByTestId("item").textContent).toBe("2");

    resetCounts();
    await act(async () => {
      window.history.back();
    });
    await task();
    expect(mounted.getByTestId("item").textContent).toBe("1");
    const onBack = { ...counts };

    resetCounts();
    await act(async () => {
      window.history.forward();
    });
    await task();
    expect(mounted.getByTestId("item").textContent).toBe("2");
    const onForward = { ...counts };

    resetCounts();
    await act(async () => mounted.router.refresh());
    await task();
    // refresh() renders the render-time loader seed: the page revalidated.
    expect(mounted.getByTestId("item").textContent).toBe("1");
    const onRevalidation = { ...counts };

    expect({
      back: onBack,
      forward: onForward,
      revalidation: onRevalidation,
    }).toEqual({ back: each(1), forward: each(1), revalidation: each(0) });
  });
});
