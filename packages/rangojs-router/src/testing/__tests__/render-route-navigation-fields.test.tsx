// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memo, Profiler, Suspense, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  Link,
  Outlet,
  useLinkStatus,
  useNavigation,
  usePathname,
} from "../../client.js";
import { createHandle } from "../../handle.js";
import { useHandle } from "../../browser/react/use-handle.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition, TransitionConfig } from "../../types.js";
import type {
  HistoryState,
  PublicNavigationState,
} from "../../browser/types.js";
import { renderRoute } from "../render-route.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

// Consumer contract (rango-t219): every reader shape of useNavigation() reads
// a field the same way, on every screen. While React holds a transition()
// page, work that starts shows at once and what settles (idle, isStreaming
// false, pendingUrl null) commits with the page; a page that ends the hold
// urgently (a Back, a gated-off commit) shows with the values it set. A
// progress bar that reads `isStreaming` through a selector, a status line
// that reads the full state, a breadcrumb that reads the location, a link's
// spinner beside them: none moves ahead of the others or stays behind.
// Browser proof: e2e hook-fields.test.ts (tests/shared-e2e/src/
// hook-fields-scenario.ts), both apps, dev and production.
//
// A `<Link>` click over a held page runs inside `await act(async () => ...)`:
// fireEvent's synchronous act() would drop React's retry of the held page
// (skills/testing).

const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;

/** The fields of useNavigation(), as one reader shape shows them. */
interface Fields {
  state: string;
  streaming: string;
  pending: string;
  navigating: string;
  location: string;
}

/** One committed screen. */
interface Screen {
  page: string;
  /** Each field through its own selector. */
  selectors: Fields;
  /** The full state. */
  status: Fields;
  /** A link's useLinkStatus(), a selector for isStreaming, usePathname(). */
  link: { pending: string; streaming: string; pathname: string };
}

let screens: Screen[];
/** Every commit, nested updates included. */
let commits: Screen[];
let stub: ReturnType<typeof installViewTransitionStub> | undefined;

const data = (id: string): DOMStringMap =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.dataset ?? {};

const pathOf = (url: string | null): string =>
  url ? new URL(url).pathname : "-";

function Selector({
  id,
  read,
}: {
  id: string;
  read: (n: PublicNavigationState) => string;
}): ReactNode {
  const value = useNavigation(read);
  return <i data-testid={id} data-value={value} />;
}

/** The selector readers: a bar, a pending label, a spinner, a breadcrumb. */
function Selectors(): ReactNode {
  return (
    <>
      <Selector id="state" read={(n) => n.state} />
      <Selector id="bar" read={(n) => String(n.isStreaming)} />
      <Selector id="pending" read={(n) => pathOf(n.pendingUrl)} />
      <Selector id="navigating" read={(n) => String(n.isNavigating)} />
      <Selector id="location" read={(n) => n.location.pathname} />
    </>
  );
}

/** A status line: the full state. */
function Status(): ReactNode {
  const nav = useNavigation();
  return (
    <i
      data-testid="status"
      data-state={nav.state}
      data-streaming={String(nav.isStreaming)}
      data-pending={pathOf(nav.pendingUrl)}
      data-navigating={String(nav.isNavigating)}
      data-location={nav.location.pathname}
    />
  );
}

/** A link's spinner that also reads the stream and the pathname. */
function LinkChrome(): ReactNode {
  const { pending } = useLinkStatus();
  const streaming = useNavigation((n) => n.isStreaming);
  const pathname = usePathname();
  return (
    <i
      data-testid="link"
      data-pending={String(pending)}
      data-streaming={String(streaming)}
      data-pathname={pathname}
    />
  );
}

/**
 * Records a commit as a screen. A nested update (a set in a commit's layout
 * effects, as a page's release is) commits in the same task, before the
 * browser paints: it replaces the screen it follows. `commits` keeps both.
 */
function record(_id: string, phase: string): void {
  const status = data("status");
  const link = data("link");
  if (phase === "nested-update") screens.pop();
  const screen: Screen = {
    page: document.querySelector('[data-testid="item"]')?.textContent ?? "-",
    selectors: {
      state: data("state").value!,
      streaming: data("bar").value!,
      pending: data("pending").value!,
      navigating: data("navigating").value!,
      location: data("location").value!,
    },
    status: {
      state: status.state!,
      streaming: status.streaming!,
      pending: status.pending!,
      navigating: status.navigating!,
      location: status.location!,
    },
    link: {
      pending: link.pending!,
      streaming: link.streaming!,
      pathname: link.pathname!,
    },
  };
  screens.push(screen);
  commits.push(screen);
}

function ItemsShell(): ReactNode {
  return (
    <Profiler id="chrome" onRender={record}>
      <Selectors />
      <Status />
      <Link to="/items/2">
        2
        <LinkChrome />
      </Link>
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <Outlet />
      </Suspense>
    </Profiler>
  );
}

function Item(): ReactNode {
  const { data } = useLoader(ItemLoader);
  return <p data-testid="item">{data}</p>;
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
 * Each disagreement on a screen from the `from`th on, as "page N: <reader>
 * <value> | full state <value>": a selector against the full state, the
 * link's isStreaming selector against it, usePathname() against its
 * location.
 */
function torn(from = 0): string[] {
  return distinct(from).flatMap((s) => {
    const fields = Object.keys(s.status) as (keyof Fields)[];
    const pairs: [string, string, string][] = [
      ...fields.map((f): [string, string, string] => [
        `selector ${f}`,
        s.selectors[f],
        s.status[f],
      ]),
      ["link isStreaming", s.link.streaming, s.status.streaming],
      ["usePathname()", s.link.pathname, s.status.location],
    ];
    return pairs
      .filter(([, value, full]) => value !== full)
      .map(
        ([reader, value, full]) =>
          `page ${s.page}: ${reader} ${value} | full state ${full}`,
      );
  });
}

/** torn() of the useNavigation() readers: usePathname() left out. */
function tornNavigation(from = 0): string[] {
  return torn(from).filter((t) => !t.includes(": usePathname() "));
}

/** The last screen: its full state (torn() holds the others to it). */
function last(): Fields & { page: string; linkPending: string } {
  const s = screens.at(-1)!;
  return { page: s.page, ...s.status, linkPending: s.link.pending };
}

const idle = (location: string, streaming = "false"): Fields => ({
  state: "idle",
  streaming,
  pending: "-",
  navigating: "false",
  location,
});

beforeEach(() => {
  screens = [];
  commits = [];
  stub = undefined;
});

afterEach(() => {
  cleanup();
  stub?.uninstall();
});

/**
 * Mounts page 1, then clicks to page 2, a transition() page React holds:
 * its loader and its response's tail stay open until the test settles them.
 * `history` writes an entry, as a link click does. `held` is the held
 * screen, the message of each torn() check.
 */
async function holdPage2(
  vt: boolean,
  transition: TransitionConfig = {},
  history?: { state: HistoryState },
) {
  if (vt) stub = installViewTransitionStub();
  const mounted = await renderRoute(
    [
      { path: "/items/:id", Component: ItemsShell },
      { path: "/items/:id", Component: Item, transition },
    ],
    { request: "/items/1", loaders: [[ItemLoader, "1"]] },
  );
  const page = deferred();
  const tail = deferred<void>();
  await mounted.router.navigate("/items/2", {
    loaders: [[ItemLoader, page.promise]],
    streamUntil: tail.promise,
    ...history,
  });
  await task();
  expect(mounted.getByTestId("item").textContent, "React holds page 2").toBe(
    "1",
  );
  return { ...mounted, page, tail, held: `held: ${JSON.stringify(last())}` };
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
  "renderRoute: useNavigation() reader shapes while a transition() page is held ($variant)",
  ({ vt }) => {
    it("the response stream ends while the page is held: every reader agrees, and the page commits with idle", async () => {
      const mounted = await holdPage2(vt);
      expect(last()).toEqual({
        page: "1",
        state: "loading",
        streaming: "true",
        pending: "-",
        navigating: "true",
        location: "/items/1",
        linkPending: "true",
      });

      await act(async () => mounted.tail.resolve());
      await task();
      expect(last().page).toBe("1");

      await showPage2(mounted, mounted.page);
      expect(torn(), mounted.held).toEqual([]);
      expect(last()).toEqual({
        page: "2",
        ...idle("/items/2"),
        linkPending: "false",
      });
    });

    it("a newer click while the page is held: pendingUrl reads the same in every reader, and the newer page commits with idle", async () => {
      const mounted = await holdPage2(vt);
      await act(async () => mounted.tail.resolve());
      await task();

      const newer = deferred();
      const newerTail = deferred<void>();
      await act(async () => {
        await mounted.router.navigate("/items/3", {
          loaders: [[ItemLoader, newer.promise]],
          streamUntil: newerTail.promise,
        });
      });
      await task();
      expect(last()).toEqual({
        page: "1",
        state: "loading",
        streaming: "true",
        pending: "/items/3",
        navigating: "true",
        location: "/items/1",
        linkPending: "false",
      });

      await act(async () => {
        mounted.page.resolve("2");
        newer.resolve("3");
        newerTail.resolve();
      });
      await waitFor(() =>
        expect(mounted.getByTestId("item").textContent).toBe("3"),
      );
      await task();

      expect(torn(), mounted.held).toEqual([]);
      expect(distinct().map((s) => s.page)).not.toContain("2");
      expect(last()).toEqual({
        page: "3",
        ...idle("/items/3"),
        linkPending: "false",
      });
      // The commit that shows page 3 already reads idle: page 3's anchor, a
      // second one while page 2 is held, sets its values in its transition.
      // Without that set, page 3 commits beside the held "loading", and its
      // layout effects run before the release brings idle.
      const shown = commits.find((s) => s.page === "3")!;
      expect(shown.status).toMatchObject({
        state: "idle",
        navigating: "false",
        pending: "-",
        location: "/items/3",
      });
      expect(shown.selectors).toEqual(shown.status);
    });

    // The newer click's pendingUrl stays on the held screen after its request
    // is aborted (what settles waits for the page), and clears with the page.
    it("a newer click aborted before its response while the page is held: pendingUrl clears with the page", async () => {
      const mounted = await holdPage2(vt);
      await act(async () => {
        const newer = mounted.router.navigate("/items/3", {
          loaders: [[ItemLoader, "3"]],
        });
        // As navigation-bridge.ts does for a page restored from the
        // back/forward cache: the pending request only.
        mounted.router.eventController.abortNavigation(true);
        await newer;
      });
      await task();
      expect(last()).toEqual({
        page: "1",
        state: "loading",
        streaming: "true",
        pending: "/items/3",
        navigating: "true",
        location: "/items/1",
        linkPending: "false",
      });

      // The newer click aborted page 2's navigation, whose stream stopped
      // counting at the abort (partial-update.ts endStream).
      await showPage2(mounted, mounted.page);
      expect(torn(), mounted.held).toEqual([]);
      expect(last()).toEqual({
        page: "2",
        ...idle("/items/2"),
        linkPending: "false",
      });
    });

    // An urgent page ends the hold: its release brings the live values,
    // though the held page's anchor already set the same ones (React still
    // holds that set).
    it("a gated-off commit ends the hold: the page shows with its own values in every reader", async () => {
      const mounted = await holdPage2(vt);

      // The same link again, with transition() gated off for it.
      await act(async () => {
        await mounted.router.navigate("/items/2", {
          loaders: [[ItemLoader, "2"]],
          transition: false,
        });
      });
      await task();
      expect(mounted.getByTestId("item").textContent).toBe("2");
      // usePathname() is pinned on its own below (rango-t221).
      expect(tornNavigation(), mounted.held).toEqual([]);
      // The gated-off navigation aborted the held one, whose stream stopped
      // counting at the abort.
      expect(last()).toEqual({
        page: "2",
        ...idle("/items/2"),
        linkPending: "false",
      });

      const urgent = screens.length;
      await act(async () => {
        mounted.page.resolve("late");
        mounted.tail.resolve();
      });
      await task();
      expect(torn(urgent)).toEqual([]);
      expect(last()).toEqual({
        page: "2",
        ...idle("/items/2"),
        linkPending: "false",
      });
    });

    // usePathname() dedupes against its own last set, the held page's, which
    // React has not committed when an urgent page ends the hold: it reads the
    // page being left until that set commits. Today's behaviour, the same on
    // 6dce6b112: a fix for rango-t221 updates this pin.
    it("usePathname lags one screen when an urgent page ends a hold (rango-t221)", async () => {
      const mounted = await holdPage2(vt);
      await act(async () => {
        await mounted.router.navigate("/items/2", {
          loaders: [[ItemLoader, "2"]],
          transition: false,
        });
      });
      await task();
      expect(mounted.getByTestId("item").textContent).toBe("2");
      expect(torn(), mounted.held).toEqual([
        "page 2: usePathname() /items/1 | full state /items/2",
      ]);

      const urgent = screens.length;
      await act(async () => {
        mounted.page.resolve("late");
        mounted.tail.resolve();
      });
      await task();
      expect(torn(urgent)).toEqual([]);
    });

    // A list page without transition(): Back to it restores its entry
    // urgently while React still holds page 2 (navigation-bridge.ts
    // handlePopstate, a history-cache restore).
    it("a Back without transition() ends the hold: the restored page shows with its own values in every reader", async () => {
      const mounted = await holdPage2(
        vt,
        { when: ({ to }) => to.params.id !== "1" },
        { state: { from: "list" } },
      );
      // The response's stream ended: the held page's anchor set idle.
      await act(async () => mounted.tail.resolve());
      await task();
      expect(last().page).toBe("1");
      expect(last().state).toBe("loading");

      await act(async () => {
        window.history.back();
      });
      await task();
      expect(mounted.getByTestId("item").textContent).toBe("1");
      expect(torn(), mounted.held).toEqual([]);
      expect(last()).toEqual({
        page: "1",
        ...idle("/items/1"),
        linkPending: "false",
      });

      await act(async () => mounted.page.resolve("2"));
      await task();
      expect(torn()).toEqual([]);
      expect(last()).toEqual({
        page: "1",
        ...idle("/items/1"),
        linkPending: "false",
      });
    });
  },
);

// The held flag is each reader's own: the page's anchor sets it, its release
// clears it. A reader that first mounts during the hold never saw the anchor
// and reads the router's live values, the destination's (rango-t96, W1,
// navigation.md).
describe("renderRoute: a reader that mounts while a transition() page is held", () => {
  function useRoute(): string {
    const nav = useNavigation();
    return `${nav.state} ${nav.location.pathname} streaming=${nav.isStreaming}`;
  }

  function Header(): ReactNode {
    return <p data-testid="header">{useRoute()}</p>;
  }

  function Menu(): ReactNode {
    return <p data-testid="menu">{useRoute()}</p>;
  }

  let menuScreens: string[];

  function MenuShell(): ReactNode {
    const [open, setOpen] = useState(false);
    const text = (id: string) =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "-";
    return (
      <Profiler
        id="menu-shell"
        onRender={(_id, phase) => {
          if (phase === "nested-update") menuScreens.pop();
          menuScreens.push(
            `${text("item")} | ${text("header")} | ${text("menu")}`,
          );
        }}
      >
        <Header />
        <button data-testid="open" onClick={() => setOpen(true)} />
        {open && <Menu />}
        <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
          <Outlet />
        </Suspense>
      </Profiler>
    );
  }

  it("the menu reads the destination's values at once, the header waits for the page", async () => {
    menuScreens = [];
    const mounted = await renderRoute(
      [
        { path: "/items/:id", Component: MenuShell },
        { path: "/items/:id", Component: Item, transition: {} },
      ],
      { request: "/items/1", loaders: [[ItemLoader, "1"]] },
    );
    const page = deferred();
    const tail = deferred<void>();
    await mounted.router.navigate("/items/2", {
      loaders: [[ItemLoader, page.promise]],
      streamUntil: tail.promise,
    });
    await task();
    await act(async () => {
      fireEvent.click(mounted.getByTestId("open"));
    });
    await task();
    await act(async () => tail.resolve());
    await task();
    await showPage2(mounted, page);

    expect(
      menuScreens.filter((v, i) => i === 0 || menuScreens[i - 1] !== v),
    ).toEqual([
      "1 | idle /items/1 streaming=false | -",
      "1 | loading /items/1 streaming=true | -",
      "1 | loading /items/1 streaming=true | idle /items/2 streaming=true",
      "1 | loading /items/1 streaming=true | idle /items/2 streaming=false",
      "2 | idle /items/2 streaming=false | idle /items/2 streaming=false",
    ]);
  });
});

// One component reads a handle and useNavigation() together, as a page
// header with a title and a progress bar does. The destination's handle
// values arrive on its response while React holds the page: they wait for
// the page, as the location does, so no screen pairs one page's title with
// another page's location or settled state.
describe.each([
  { variant: "view transitions supported", vt: true },
  { variant: "view transitions unsupported", vt: false },
])(
  "renderRoute: a reader of a handle and useNavigation() while a transition() page is held ($variant)",
  ({ vt }) => {
    const Titles = createHandle<string, string[]>(
      (segments) => segments.flat(),
      "__test_navigation_fields_titles__",
    );
    let headers: string[];

    function Header(): ReactNode {
      const title = useHandle(Titles).at(-1) ?? "-";
      const nav = useNavigation();
      return (
        <p data-testid="header">
          {`${title} ${nav.state} ${nav.location.pathname} streaming=${nav.isStreaming}`}
        </p>
      );
    }

    function Shell(): ReactNode {
      const text = (id: string) =>
        document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "-";
      return (
        <Profiler
          id="header"
          onRender={(_id, phase) => {
            if (phase === "nested-update") headers.pop();
            headers.push(`${text("item")} | ${text("header")}`);
          }}
        >
          <Header />
          <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
            <Outlet />
          </Suspense>
        </Profiler>
      );
    }

    /** Page 1 on screen, then a click to page 2 whose title is `title`. */
    async function navigateWithTitle(title: unknown) {
      headers = [];
      if (vt) stub = installViewTransitionStub();
      const mounted = await renderRoute(
        [
          { path: "/items/:id", Component: Shell },
          { path: "/items/:id", Component: Item, transition: {} },
        ],
        {
          request: "/items/1",
          loaders: [[ItemLoader, "1"]],
          handles: [[Titles, ["Item one"]]],
        },
      );
      const page = deferred();
      const tail = deferred<void>();
      await mounted.router.navigate("/items/2", {
        loaders: [[ItemLoader, page.promise]],
        handles: [[Titles, [title]]],
        streamUntil: tail.promise,
      });
      await task();
      await act(async () => tail.resolve());
      await task();
      return { ...mounted, page };
    }

    const distinctHeaders = () =>
      headers.filter((v, i) => i === 0 || headers[i - 1] !== v);

    it("the title, the location and idle commit together with the page", async () => {
      const mounted = await navigateWithTitle("Item two");
      await showPage2(mounted, mounted.page);

      expect(distinctHeaders()).toEqual([
        "1 | Item one idle /items/1 streaming=false",
        "1 | Item one loading /items/1 streaming=true",
        "2 | Item two idle /items/2 streaming=false",
      ]);
    });

    it("a pending title that resolves while the page is held commits with the page", async () => {
      const title = deferred();
      const mounted = await navigateWithTitle(title.promise);
      await act(async () => {
        title.resolve("Item two");
        await title.promise;
      });
      await task();
      await showPage2(mounted, mounted.page);

      expect(distinctHeaders()).toEqual([
        "1 | Item one idle /items/1 streaming=false",
        "1 | Item one loading /items/1 streaming=true",
        "2 | Item two idle /items/2 streaming=false",
      ]);
    });

    it("a title that resolves after the page commits: idle and the location commit with the page, the title follows", async () => {
      const title = deferred();
      const mounted = await navigateWithTitle(title.promise);
      await showPage2(mounted, mounted.page);
      await act(async () => {
        title.resolve("Item two");
        await title.promise;
      });
      await task();

      // The previous title is held until the promise resolves (#1174).
      expect(distinctHeaders()).toEqual([
        "1 | Item one idle /items/1 streaming=false",
        "1 | Item one loading /items/1 streaming=true",
        "2 | Item one idle /items/2 streaming=false",
        "2 | Item two idle /items/2 streaming=false",
      ]);
    });
  },
);

// A reader renders for each value it shows, and not again for a value it
// already shows: a page's release that finds its value committed sets
// nothing. Render-phase calls of each memoized reader from the click on,
// discarded transition renders included; the same counts on 6dce6b112.
describe("renderRoute: a useNavigation() reader renders once per value it shows", () => {
  const counts = { selector: 0, full: 0 };
  const StateReader = memo(function StateReader(): ReactNode {
    counts.selector++;
    return <i data-state={useNavigation((n) => n.state)} />;
  });
  const FullReader = memo(function FullReader(): ReactNode {
    counts.full++;
    return <i data-state={useNavigation().state} />;
  });
  function CountShell(): ReactNode {
    return (
      <>
        <StateReader />
        <FullReader />
        <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
          <Outlet />
        </Suspense>
      </>
    );
  }

  async function mountCounted() {
    const mounted = await renderRoute(
      [
        { path: "/items/:id", Component: CountShell },
        { path: "/items/:id", Component: Item, transition: {} },
      ],
      { request: "/items/1", loaders: [[ItemLoader, "1"]] },
    );
    await task();
    counts.selector = 0;
    counts.full = 0;
    return mounted;
  }

  async function holdPage(mounted: Awaited<ReturnType<typeof mountCounted>>) {
    const page = deferred();
    await mounted.router.navigate("/items/2", {
      loaders: [[ItemLoader, page.promise]],
    });
    await task();
    expect(mounted.getByTestId("item").textContent).toBe("1");
    return page;
  }

  it("on a transition() page, one React holds, and a gated-off page that ends a hold", async () => {
    const transition = await mountCounted();
    await act(async () => {
      await transition.router.navigate("/items/2", {
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
    await holdPage(gatedOff);
    await act(async () => {
      await gatedOff.router.navigate("/items/2", {
        loaders: [[ItemLoader, "2"]],
        transition: false,
      });
    });
    await task();
    expect(gatedOff.getByTestId("item").textContent).toBe("2");
    const onGatedOff = { ...counts };

    expect({
      transition: onTransition,
      held: onHeld,
      gatedOff: onGatedOff,
    }).toEqual({
      transition: { selector: 2, full: 2 },
      held: { selector: 3, full: 3 },
      gatedOff: { selector: 4, full: 4 },
    });
  });
});
