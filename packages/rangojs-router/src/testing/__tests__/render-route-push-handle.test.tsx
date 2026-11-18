// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Component,
  Profiler,
  Suspense,
  use,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  act,
  cleanup,
  configure,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";
import { Outlet, ParallelOutlet } from "../../client.js";
import { OutletProvider } from "../../outlet-provider.js";
import { collectHandleData, createHandle, type Handle } from "../../handle.js";
import { Breadcrumbs, type BreadcrumbItem } from "../../handles/breadcrumbs.js";
import { Meta } from "../../handles/meta.js";
import { useHandle } from "../../browser/react/use-handle.js";
import { usePushHandle } from "../../browser/react/use-push-handle.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import {
  renderRoute,
  type RenderRouteHydrateResult,
  type RenderRouteSpec,
} from "../render-route.js";

/**
 * Userland: a client component pushes a handle's values for its own segment
 * (usePushHandle), and what useHandle shows is a function of the server's
 * values and the committed client pushes, per segment, never of which arrived
 * first: in each segment the client's values follow the server's.
 *
 * Commits are measured, not reasoned: a Profiler over the page records the
 * DOM at every React commit, with a tick that moves at the next microtask;
 * `painted()` keeps the last commit of each tick. Under act() that is the
 * closest a DOM test gets to a frame: act() flushes passive effects too, so
 * a value a passive effect sets looks on time here. The browser's frames are
 * pinned by the push-handle e2e, which samples every animation frame.
 */

const Titles = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_push_handle_titles__",
);
const Title = createHandle<string, string>(
  (segments) => segments.flat().at(-1) ?? "",
  "__test_push_handle_title__",
);
const ItemLoader = {
  __brand: "loader",
  $$id: "push-handle#ItemLoader",
} as unknown as LoaderDefinition<string>;

interface Frame {
  title: string;
  data: string;
  /** The title a reader inside the page shows (empty when none is mounted). */
  own: string;
  tick: number;
}
let log: Frame[];
let tick: number;
let tickQueued: boolean;

// The visible element: a revealed <Suspense> that suspends again keeps its
// content in the DOM, hidden, beside its fallback.
const text = (id: string): string =>
  Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
  ).find((el) => !el.closest('[style*="display: none"]'))?.textContent ?? "";

function record(): void {
  log.push({
    title: text("title"),
    data: text("data"),
    own: text("own-title"),
    tick,
  });
  if (tickQueued) return;
  tickQueued = true;
  queueMicrotask(() => {
    tick++;
    tickQueued = false;
  });
}

/** The last commit of each tick: what the browser could paint. */
const painted = (frames: Frame[]): Frame[] =>
  frames.filter((f, i) => frames[i + 1]?.tick !== f.tick);

/** A frame whose pusher shows data its title does not carry. */
const mixes = (f: Frame): boolean =>
  f.data !== "" && !f.title.includes(`Client ${f.data}`);

function TitleReader(): ReactNode {
  return <p data-testid="title">{useHandle(Titles).join(" / ")}</p>;
}

function Layout(): ReactNode {
  return (
    <Profiler id="page" onRender={record}>
      <TitleReader />
      <Suspense fallback={<p data-testid="fallback">loading</p>}>
        <Outlet />
      </Suspense>
    </Profiler>
  );
}

function Pusher({ data }: { data: string }): ReactNode {
  usePushHandle(Titles)(`Client ${data}`);
  return <p data-testid="data">{data}</p>;
}

/** A reader inside the page, mounted with the pusher. */
function OwnTitle(): ReactNode {
  return <p data-testid="own-title">{useHandle(Titles).join(" / ")}</p>;
}

/** The route: its loader's value decides whether the pusher is on the page. */
function Page(): ReactNode {
  const { data, load } = useLoader(ItemLoader);
  const [shown, setShown] = useState(true);
  return (
    <>
      {data === "with reader" && <OwnTitle />}
      {shown && !data.startsWith("plain") ? (
        <Pusher data={data} />
      ) : (
        <p data-testid="plain">{data}</p>
      )}
      <button data-testid="toggle" onClick={() => setShown((s) => !s)} />
      <button data-testid="load" onClick={() => void load().catch(() => {})} />
    </>
  );
}

const routes = (transition: boolean): RenderRouteSpec[] => [
  { path: "/items", Component: Layout },
  { path: "/items", Component: Page, ...(transition && { transition: {} }) },
];

/** The title for the layout's "Layout", segment 1's server values, then the client's. */
const titleOf = (server: string[], client?: string): string =>
  ["Layout", ...server, ...(client === undefined ? [] : [client])].join(" / ");

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function mount(
  options: { transition?: boolean; data?: string; hydrate?: boolean } = {},
) {
  return renderRoute(routes(options.transition ?? false), {
    request: "/items?id=1",
    loaders: [[ItemLoader, options.data ?? "one"]],
    handles: [
      [Titles, ["Layout"], 0],
      [Titles, ["Server one"], 1],
    ],
    ...(options.hydrate && { hydrate: true }),
  });
}

/** Click a load() button and wait for its answer to commit. */
async function loadAndSettle(button: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(button);
    await new Promise((r) => setTimeout(r, 20));
  });
}

let errors: ReturnType<typeof vi.spyOn>;
let warnings: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = [];
  tick = 0;
  tickQueued = false;
  errors = vi.spyOn(console, "error");
  warnings = vi.spyOn(console, "warn");
});
afterEach(() => {
  cleanup();
  errors.mockRestore();
  warnings.mockRestore();
  configure({ reactStrictMode: false });
});

const messages = (spy: ReturnType<typeof vi.spyOn>, part: string): string[] =>
  spy.mock.calls
    .map((call: unknown[]) => call.map(String).join(" "))
    .filter((m: string) => m.includes(part));

describe("usePushHandle", () => {
  it("a late server push into the owned segment, in either arrival order; unmount shows the server's", async () => {
    // Order A: the pusher is mounted, then the late push lands.
    const a = await mount();
    expect(text("title")).toBe(titleOf(["Server one"], "Client one"));
    await a.router.pushLateHandles([[Titles, ["Late one"], 1]]);
    const screenA = text("title");
    expect(screenA).toBe(titleOf(["Late one"], "Client one"));
    await act(async () => fireEvent.click(a.getByTestId("toggle")));
    expect(text("title")).toBe(titleOf(["Late one"]));
    cleanup();

    // Order B: the late push lands, then the pusher mounts.
    const b = await mount();
    await act(async () => fireEvent.click(b.getByTestId("toggle")));
    await b.router.pushLateHandles([[Titles, ["Late one"], 1]]);
    await act(async () => fireEvent.click(b.getByTestId("toggle")));
    expect(text("title")).toBe(screenA);
  });

  it("a late push into another segment shows", async () => {
    const { router } = await mount();
    await router.pushLateHandles([[Titles, ["Late layout"], 0]]);
    expect(text("title")).toBe(
      titleOf(["Server one"], "Client one").replace("Layout", "Late layout"),
    );
  });

  it("a plain load() refresh paints no frame with the new data and the old title", async () => {
    const { router, getByTestId } = await mount();
    router.respondToLoads({ loaders: [[ItemLoader, "loaded"]] });
    log = [];
    await loadAndSettle(getByTestId("load"));
    expect(text("data")).toBe("loaded");
    expect(text("title")).toBe(titleOf(["Server one"], "Client loaded"));
    expect(painted(log).filter(mixes)).toEqual([]);
  });

  it("a load() refresh, by commit: the new data commits before the title, corrected before paint", async () => {
    const { router, getByTestId } = await mount();
    router.respondToLoads({ loaders: [[ItemLoader, "loaded"]] });
    log = [];
    await loadAndSettle(getByTestId("load"));
    // Measured: one commit shows "loaded" with the old title; the reader's
    // update from the pusher's layout effect commits in the same task.
    const mixed = log.filter(mixes);
    expect(mixed).toHaveLength(1);
    expect(log.filter((f) => f.tick === mixed[0].tick).at(-1)).toEqual({
      ...mixed[0],
      title: titleOf(["Server one"], "Client loaded"),
    });
  });

  it("a load() racing a navigation's revalidation of the same loader: the title follows what the component renders", async () => {
    const { router, getByTestId } = await mount({ transition: true });
    router.respondToLoads({ loaders: [[ItemLoader, "loaded"]] });
    const nav = deferred<string>();
    log = [];
    await router.navigate("/items?id=2", {
      loaders: [[ItemLoader, nav.promise]],
      handles: [
        [Titles, ["Layout"], 0],
        [Titles, ["Server two"], 1],
      ],
    });
    await loadAndSettle(getByTestId("load"));
    // Held: the page on screen shows its own server values with the new
    // client value, not the held page's server values.
    expect(text("data")).toBe("loaded");
    expect(text("title")).toBe(titleOf(["Server one"], "Client loaded"));
    await act(async () => {
      nav.resolve("two");
      await nav.promise;
    });
    // The load() answer showed on the held page before the navigation won.
    expect(painted(log).some((f) => f.data === "loaded")).toBe(true);
    const shown = text("data");
    expect(text("title")).toContain(`Client ${shown}`);
    expect(painted(log).filter(mixes)).toEqual([]);
  });

  it.each([
    { variant: "held in a transition", transition: true },
    { variant: "committed at once", transition: false },
  ])(
    "navigating away ($variant): no frame shows the old client value over the new page",
    async ({ transition }) => {
      const { router } = await mount({ transition });
      log = [];
      const nav = deferred<string>();
      await router.navigate("/items?id=2", {
        loaders: [[ItemLoader, nav.promise]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server two"], 1],
        ],
      });
      await act(async () => {
        nav.resolve("plain two");
        await nav.promise;
      });
      expect(text("plain")).toBe("plain two");
      expect(text("title")).toBe(titleOf(["Server two"]));
      expect(
        painted(log).filter(
          (f) => f.title.includes("Client one") && f.data !== "one",
        ),
      ).toEqual([]);
    },
  );

  it.each([
    { variant: "held in a transition", transition: true },
    { variant: "committed at once", transition: false },
  ])(
    "a reader that mounts with the pusher ($variant) paints no frame without its value",
    async ({ transition }) => {
      const { router } = await mount({ transition });
      log = [];
      await router.navigate("/items?id=2", {
        loaders: [[ItemLoader, "with reader"]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server two"], 1],
        ],
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(text("own-title")).toBe(
        titleOf(["Server two"], "Client with reader"),
      );
      const own = painted(log).filter(
        (f) => f.data === "with reader" && f.own !== "",
      );
      expect(own.length).toBeGreaterThan(0);
      expect(own.filter((f) => !f.own.includes("Client with reader"))).toEqual(
        [],
      );
    },
  );

  it("a newer navigation over a held one: the page that commits brings its values; the abandoned one's never show", async () => {
    const { router } = await mount({ transition: true });
    log = [];
    const abandoned = deferred<string>();
    await router.navigate("/items?id=2", {
      loaders: [[ItemLoader, abandoned.promise]],
      handles: [
        [Titles, ["Layout"], 0],
        [Titles, ["Server two"], 1],
      ],
    });
    expect(text("title")).toBe(titleOf(["Server one"], "Client one"));
    await act(async () => {
      await router.navigate("/items?id=3", {
        loaders: [[ItemLoader, "three"]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server three"], 1],
        ],
      });
    });
    await act(async () => {
      abandoned.resolve("two");
      await abandoned.promise;
    });
    expect(text("data")).toBe("three");
    expect(text("title")).toBe(titleOf(["Server three"], "Client three"));
    expect(painted(log).filter(mixes)).toEqual([]);
    expect(painted(log).some((f) => f.title.includes("two"))).toBe(false);
  });

  it("a held navigation replaced by an urgent one: the hold ends, and later server and client pushes land on the page that committed", async () => {
    const { router, getByTestId } = await mount({ transition: true });
    const abandoned = deferred<string>();
    await router.navigate("/items?id=2", {
      loaders: [[ItemLoader, abandoned.promise]],
      handles: [
        [Titles, ["Layout"], 0],
        [Titles, ["Server two"], 1],
      ],
    });
    expect(router.eventController.getHeldHandleState()).toBeDefined();
    await act(async () => {
      await router.navigate("/items?id=3", {
        loaders: [[ItemLoader, "three"]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server three"], 1],
        ],
        transition: false,
      });
    });
    expect(router.eventController.getHeldHandleState()).toBeUndefined();
    expect(text("title")).toBe(titleOf(["Server three"], "Client three"));
    log = [];
    await router.pushLateHandles([[Titles, ["Late server"], 1]]);
    expect(text("title")).toBe(titleOf(["Late server"], "Client three"));
    router.respondToLoads({ loaders: [[ItemLoader, "three 1"]] });
    await loadAndSettle(getByTestId("load"));
    expect(text("title")).toBe(titleOf(["Late server"], "Client three 1"));
    await act(async () => {
      abandoned.resolve("two");
      await abandoned.promise;
    });
    expect(text("data")).toBe("three 1");
    expect(text("title")).toBe(titleOf(["Late server"], "Client three 1"));
    expect(painted(log).filter(mixes)).toEqual([]);
  });

  it("a held navigation that fails: the page being left keeps its values and its client push until the failure commits; then the destination's", async () => {
    class PageBoundary extends Component<
      { children: ReactNode },
      { failed: boolean }
    > {
      state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      render(): ReactNode {
        return this.state.failed ? (
          <p data-testid="failed">failed</p>
        ) : (
          this.props.children
        );
      }
    }
    function BoundaryLayout(): ReactNode {
      return (
        <Profiler id="page" onRender={record}>
          <TitleReader />
          <PageBoundary>
            <Outlet />
          </PageBoundary>
        </Profiler>
      );
    }
    const { router, getByTestId } = await renderRoute(
      [
        { path: "/items", Component: BoundaryLayout },
        { path: "/items", Component: Page, transition: {} },
      ],
      {
        request: "/items?id=1",
        loaders: [[ItemLoader, "one"]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server one"], 1],
        ],
      },
    );
    let fail!: (error: Error) => void;
    const failing = new Promise<string>((_, reject) => (fail = reject));
    failing.catch(() => {});
    errors.mockImplementation(() => {});
    log = [];
    await router.navigate("/items?id=2", {
      loaders: [[ItemLoader, failing]],
      handles: [
        [Titles, ["Layout"], 0],
        [Titles, ["Server two"], 1],
      ],
    });
    router.respondToLoads({ loaders: [[ItemLoader, "loaded"]] });
    await loadAndSettle(getByTestId("load"));
    // Held: the page on screen shows its new client value over its own
    // server values, never the failing page's.
    expect(text("data")).toBe("loaded");
    expect(text("title")).toBe(titleOf(["Server one"], "Client loaded"));
    await act(async () => {
      fail(new Error("load failed"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(router.eventController.getHeldHandleState()).toBeUndefined();
    // The failed page committed (its error in place of the pusher): its
    // server values, and no client value from the page it replaced.
    expect(text("failed")).toBe("failed");
    expect(text("data")).toBe("");
    expect(text("title")).toBe(titleOf(["Server two"]));
    await router.pushLateHandles([[Titles, ["Late server"], 1]]);
    expect(text("title")).toBe(titleOf(["Late server"]));
    expect(
      painted(log).filter(
        (f) => f.title.includes("Server two") && f.title.includes("Client"),
      ),
    ).toEqual([]);
  });

  // With view transitions every commit here runs through the browser's
  // transition (the stub), and readers take a commit's handle values when
  // its `ready` resolves, as for server values (the "When handle values
  // change" contract): the new data can lead its title by a tick. What never
  // shows is one page's server values with the other page's client value.
  it("a navigation held by a view transition: a client push on the page being left shows with that page's server values; the destination's come with its commit", async () => {
    const stub = installViewTransitionStub();
    try {
      const { router, getByTestId } = await mount({ transition: true });
      log = [];
      const nav = deferred<string>();
      await router.navigate("/items?id=2", {
        loaders: [[ItemLoader, nav.promise]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server two"], 1],
        ],
      });
      router.respondToLoads({ loaders: [[ItemLoader, "loaded"]] });
      await loadAndSettle(getByTestId("load"));
      await waitFor(() =>
        expect(text("title")).toBe(titleOf(["Server one"], "Client loaded")),
      );
      expect(text("data")).toBe("loaded");
      await act(async () => {
        nav.resolve("two");
        await nav.promise;
      });
      await waitFor(() =>
        expect(text("title")).toBe(titleOf(["Server two"], "Client two")),
      );
      expect(text("data")).toBe("two");
      expect(stub.started()).toBeGreaterThan(0);
      const frames = painted(log);
      expect(
        frames.filter(
          (f) =>
            (f.title.includes("Server two") &&
              !f.title.endsWith("Client two")) ||
            (f.title.includes("Server one") && f.title.endsWith("Client two")),
        ),
      ).toEqual([]);
      expect(
        frames.filter(
          (f) => f.data === "two" && f.title.includes("Client one"),
        ),
      ).toEqual([]);
    } finally {
      stub.uninstall();
    }
  });

  it("a same-route navigation held in a transition: the push follows the committed render", async () => {
    const { router } = await mount({ transition: true });
    log = [];
    const nav = deferred<string>();
    await router.navigate("/items?id=2", {
      loaders: [[ItemLoader, nav.promise]],
      handles: [
        [Titles, ["Layout"], 0],
        [Titles, ["Server two"], 1],
      ],
    });
    // Held: the page being left keeps its data and its client value.
    expect(text("data")).toBe("one");
    expect(text("title")).toBe(titleOf(["Server one"], "Client one"));
    await act(async () => {
      nav.resolve("two");
      await nav.promise;
    });
    expect(text("title")).toBe(titleOf(["Server two"], "Client two"));
    expect(painted(log).filter(mixes)).toEqual([]);
  });

  it("SSR values until the hydration lock releases, then the client layer; no warning where the server pushed into the client's segment", async () => {
    const result = (await mount({
      hydrate: true,
    })) as RenderRouteHydrateResult;
    expect(result.serverHtml).toContain(
      `<p data-testid="title">${titleOf(["Server one"])}</p>`,
    );
    expect(result.recoverableErrors).toEqual([]);
    expect(text("title")).toBe(titleOf(["Server one"], "Client one"));
    expect(messages(warnings, "usePushHandle")).toEqual([]);
  });

  it("a live count over the server's title (a chat's unread count): no warning", async () => {
    function ChatPage(): ReactNode {
      const [unread] = useState(3);
      const push = usePushHandle(Meta);
      if (unread > 0) push({ title: `Chat (${unread})` });
      const meta = useHandle(Meta) as Record<string, unknown>[];
      return (
        <p data-testid="t">
          {String([...meta].reverse().find((d) => "title" in d)?.title)}
        </p>
      );
    }
    const result = await renderRoute([{ path: "/chat", Component: ChatPage }], {
      request: "/chat",
      handles: [[Meta, [{ title: "Chat" }]]],
      hydrate: true,
    });
    expect(result.serverHtml).toContain(`<p data-testid="t">Chat</p>`);
    expect(text("t")).toBe("Chat (3)");
    expect(messages(warnings, "usePushHandle")).toEqual([]);
  });

  it("dev warns when the client pushes into a segment the server pushed nothing into, and its value changes what readers show", async () => {
    const result = await renderRoute(routes(false), {
      request: "/items?id=1",
      loaders: [[ItemLoader, "one"]],
      handles: [[Titles, ["Layout"], 0]],
      hydrate: true,
    });
    expect(result.serverHtml).toContain(`<p data-testid="title">Layout</p>`);
    expect(text("title")).toBe("Layout / Client one");
    const warned = messages(warnings, "usePushHandle");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("shows a value only after hydration");
    expect(warned[0]).not.toContain("on the server too");
  });

  it("no drift warning when the client value matches the SSR value", async () => {
    function TitlePage(): ReactNode {
      usePushHandle(Title)("Same");
      return <p data-testid="t">{useHandle(Title)}</p>;
    }
    const result = await renderRoute([{ path: "/t", Component: TitlePage }], {
      request: "/t",
      handles: [[Title, ["Same"]]],
      hydrate: true,
    });
    expect(result.recoverableErrors).toEqual([]);
    expect(text("t")).toBe("Same");
    expect(messages(warnings, "usePushHandle")).toEqual([]);
  });

  it("a ppr live-lane push after hydration into the owned segment", async () => {
    const result = await renderRoute(routes(false), {
      request: "/items?id=1",
      loaders: [[ItemLoader, "one"]],
      handles: [
        [Titles, ["Layout"], 0],
        [Titles, ["Server one"], 1],
      ],
      lateHandles: [[Titles, ["Live lane"], 1]],
      hydrate: true,
    });
    expect(result.recoverableErrors).toEqual([]);
    expect(text("title")).toBe(titleOf(["Live lane"], "Client one"));
  });

  it("Back/Forward: no client value in the history snapshot; the restored page pushes again in its commit", async () => {
    const { router } = await mount();
    const seg = router.segmentId(1);
    // What production writes into the history entry (liveHandleDataForCache).
    expect(router.eventController.getHandleState().data[Titles.$$id]).toEqual({
      [router.segmentId(0)]: ["Layout"],
      [seg]: ["Server one"],
    });
    await router.navigate("/items?id=2", {
      loaders: [[ItemLoader, "two"]],
      handles: [
        [Titles, ["Layout"], 0],
        [Titles, ["Server two"], 1],
      ],
      state: [],
    });
    expect(text("title")).toBe(titleOf(["Server two"], "Client two"));
    log = [];
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(text("data")).toBe("one");
    expect(text("title")).toBe(titleOf(["Server one"], "Client one"));
    expect(painted(log).filter(mixes)).toEqual([]);
  });

  it("two pushers of one handle in one segment show in tree order, with no dev error", async () => {
    function Second(): ReactNode {
      usePushHandle(Titles)("Second");
      return null;
    }
    function TwoPushers(): ReactNode {
      return (
        <>
          <Pusher data="one" />
          <Second />
        </>
      );
    }
    await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: TwoPushers },
      ],
      {
        request: "/items",
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server one"], 1],
        ],
      },
    );
    expect(messages(errors, "usePushHandle")).toEqual([]);
    expect(text("title")).toBe(titleOf(["Server one", "Client one"], "Second"));
  });

  it("the first pusher in the tree comes first even when it suspends and commits after its sibling", async () => {
    const gate = deferred<string>();
    function First(): ReactNode {
      const value = use(gate.promise);
      usePushHandle(Title)(`First ${value}`);
      usePushHandle(Titles)(`First ${value}`);
      return null;
    }
    function Second(): ReactNode {
      usePushHandle(Title)("Second");
      usePushHandle(Titles)("Second");
      return null;
    }
    function SiblingPage(): ReactNode {
      return (
        <>
          <p data-testid="last">{useHandle(Title)}</p>
          <Suspense fallback={null}>
            <First />
          </Suspense>
          <Suspense fallback={null}>
            <Second />
          </Suspense>
        </>
      );
    }
    await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: SiblingPage },
      ],
      { request: "/items", handles: [[Titles, ["Layout"], 0]] },
    );
    expect(text("title")).toBe("Layout / Second");
    expect(text("last")).toBe("Second");
    await act(async () => {
      gate.resolve("late");
      await gate.promise;
    });
    expect(text("title")).toBe("Layout / First late / Second");
    expect(text("last")).toBe("Second");
    expect(messages(errors, "usePushHandle")).toEqual([]);
  });

  it("a pusher that joins between two others takes its place in the tree", async () => {
    function Named({ name }: { name: string }): ReactNode {
      usePushHandle(Titles)(name);
      return null;
    }
    function Joining(): ReactNode {
      const [shown, setShown] = useState(false);
      return (
        <>
          <Named name="A" />
          {shown && <Named name="B" />}
          <Named name="C" />
          <button data-testid="join" onClick={() => setShown(true)} />
        </>
      );
    }
    const { getByTestId } = await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: Joining },
      ],
      { request: "/items", handles: [[Titles, ["Layout"], 0]] },
    );
    expect(text("title")).toBe("Layout / A / C");
    await act(async () => fireEvent.click(getByTestId("join")));
    expect(text("title")).toBe("Layout / A / B / C");
  });

  it("two pushers of Meta, a title and a description: both show, no dev error", async () => {
    function TitlePusher(): ReactNode {
      usePushHandle(Meta)({ title: "T" });
      return null;
    }
    function DescriptionPusher(): ReactNode {
      usePushHandle(Meta)({ name: "description", content: "D" });
      return null;
    }
    function MetaPage(): ReactNode {
      return (
        <>
          <p data-testid="meta">{JSON.stringify(useHandle(Meta))}</p>
          <TitlePusher />
          <DescriptionPusher />
        </>
      );
    }
    await renderRoute([{ path: "/m", Component: MetaPage }], {
      request: "/m",
    });
    const meta = JSON.parse(text("meta")) as Record<string, unknown>[];
    expect(meta).toContainEqual({ title: "T" });
    expect(meta).toContainEqual({ name: "description", content: "D" });
    expect(messages(errors, "usePushHandle")).toEqual([]);
  });

  it("a pusher nested inside another pusher of the handle shows before it, so the outer one wins a last-wins collect", async () => {
    function Inner(): ReactNode {
      usePushHandle(Title)("Inner");
      usePushHandle(Titles)("Inner");
      return null;
    }
    function Outer(): ReactNode {
      usePushHandle(Title)("Outer");
      usePushHandle(Titles)("Outer");
      return <Inner />;
    }
    function NestedPage(): ReactNode {
      return (
        <>
          <p data-testid="last">{useHandle(Title)}</p>
          <Outer />
        </>
      );
    }
    await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: NestedPage },
      ],
      { request: "/items", handles: [[Titles, ["Layout"], 0]] },
    );
    expect(text("title")).toBe("Layout / Inner / Outer");
    expect(text("last")).toBe("Outer");
  });

  it("a pusher in a layout's slot, an intercept, and a route's own slot files its values in that segment", async () => {
    const slotPusher = (value: string) =>
      function SlotPusher(): ReactNode {
        usePushHandle(Titles)(value);
        return null;
      };
    function SlotLayout(): ReactNode {
      return (
        <>
          <TitleReader />
          <ParallelOutlet name="@side" />
          <ParallelOutlet name="@modal" />
          <Outlet />
        </>
      );
    }
    function SlotRoute(): ReactNode {
      return <ParallelOutlet name="@aside" />;
    }
    const { router } = await renderRoute(
      [
        {
          path: "/items",
          Component: SlotLayout,
          slots: {
            "@side": slotPusher("Side"),
            "@modal": { Component: slotPusher("Modal"), intercept: true },
          },
        },
        {
          path: "/items",
          Component: SlotRoute,
          slots: { "@aside": slotPusher("Aside") },
        },
      ],
      {
        request: "/items",
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server side"], [0, "@side"]],
        ],
      },
    );
    expect(router.handleData(Titles)).toEqual({
      [router.segmentId(0)]: ["Layout"],
      [router.segmentId([0, "@side"])]: ["Server side", "Side"],
      [router.segmentId([0, "@modal"])]: ["Modal"],
      [router.segmentId([1, "@aside"])]: ["Aside"],
    });
    // The slots collect after their parent, in segment order.
    expect(text("title")).toBe(
      ["Layout", "Server side", "Side", "Modal", "Aside"].join(" / "),
    );
  });

  it("an error boundary replacing the pusher brings back the server values", async () => {
    class Boundary extends Component<
      { children: ReactNode },
      { failed: boolean }
    > {
      state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      render(): ReactNode {
        return this.state.failed ? (
          <p data-testid="failed">failed</p>
        ) : (
          this.props.children
        );
      }
    }
    function Throws({ fail }: { fail: boolean }): ReactNode {
      usePushHandle(Titles)("Client one");
      if (fail) throw new Error("render failed");
      return <p data-testid="data">one</p>;
    }
    function FailingPage(): ReactNode {
      const [fail, setFail] = useState(false);
      return (
        <>
          <Boundary>
            <Throws fail={fail} />
          </Boundary>
          <button data-testid="fail" onClick={() => setFail(true)} />
        </>
      );
    }
    errors.mockImplementation(() => {});
    const { getByTestId } = await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: FailingPage },
      ],
      {
        request: "/items",
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server one"], 1],
        ],
      },
    );
    expect(text("title")).toBe(titleOf(["Server one"], "Client one"));
    await act(async () => fireEvent.click(getByTestId("fail")));
    expect(text("failed")).toBe("failed");
    expect(text("title")).toBe(titleOf(["Server one"]));
  });

  it("StrictMode's double render and effects give the same result", async () => {
    configure({ reactStrictMode: true });
    const { router, getByTestId } = await mount();
    expect(text("title")).toBe(titleOf(["Server one"], "Client one"));
    router.respondToLoads({ loaders: [[ItemLoader, "loaded"]] });
    await loadAndSettle(getByTestId("load"));
    expect(text("title")).toBe(titleOf(["Server one"], "Client loaded"));
    expect(messages(errors, "usePushHandle")).toEqual([]);
  });

  it("an action revalidation updating the owned segment's server values", async () => {
    const { router } = await mount();
    log = [];
    await router.action({
      loaders: [[ItemLoader, "two"]],
      handles: [
        [Titles, ["Layout"], 0],
        [Titles, ["Server after action"], 1],
      ],
    });
    expect(text("data")).toBe("two");
    expect(text("title")).toBe(titleOf(["Server after action"], "Client two"));
    expect(painted(log).filter(mixes)).toEqual([]);
  });

  it("a pusher that suspends pushes nothing; the server's values show until it commits", async () => {
    const gate = deferred<string>();
    function Suspending(): ReactNode {
      const value = use(gate.promise);
      usePushHandle(Titles)(`Client ${value}`);
      return <p data-testid="data">{value}</p>;
    }
    function SuspendingPage(): ReactNode {
      return (
        <Suspense fallback={<p data-testid="pending">pending</p>}>
          <Suspending />
        </Suspense>
      );
    }
    await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: SuspendingPage },
      ],
      {
        request: "/items",
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server one"], 1],
        ],
      },
    );
    expect(text("pending")).toBe("pending");
    expect(text("title")).toBe(titleOf(["Server one"]));
    await act(async () => {
      gate.resolve("late");
      await gate.promise;
    });
    expect(text("title")).toBe(titleOf(["Server one"], "Client late"));
  });

  it("a last-wins title: the client's title shows", async () => {
    function TitlePage(): ReactNode {
      usePushHandle(Title)("Client title");
      return <p data-testid="t">{useHandle(Title)}</p>;
    }
    await renderRoute(
      [
        { path: "/t", Component: Layout },
        { path: "/t", Component: TitlePage },
      ],
      {
        request: "/t",
        handles: [
          [Title, ["Layout title"], 0],
          [Title, ["Server title"], 1],
        ],
      },
    );
    expect(text("t")).toBe("Client title");
  });

  it("Meta: the client's title wins over the segment's server title; its description stays", async () => {
    function MetaPage(): ReactNode {
      usePushHandle(Meta)({ title: "Client" });
      const meta = useHandle(Meta);
      return <p data-testid="meta">{JSON.stringify(meta)}</p>;
    }
    await renderRoute([{ path: "/m", Component: MetaPage }], {
      request: "/m",
      handles: [
        [Meta, [{ title: "Server" }, { name: "description", content: "D" }]],
      ],
    });
    const meta = JSON.parse(text("meta")) as Record<string, unknown>[];
    expect(meta).toContainEqual({ title: "Client" });
    expect(meta).not.toContainEqual({ title: "Server" });
    expect(meta).toContainEqual({ name: "description", content: "D" });
  });

  it("every reader shape: a selector, the full value, and a component that reads several hooks", async () => {
    function Readers(): ReactNode {
      const last = useHandle(Titles, (titles) => titles.at(-1));
      const all = useHandle(Titles);
      const { data } = useLoader(ItemLoader);
      return (
        <>
          <p data-testid="last">{last}</p>
          <p data-testid="all">{all.join(" / ")}</p>
          <p data-testid="several">{`${data}: ${useHandle(Title)}`}</p>
        </>
      );
    }
    function ReadersPage(): ReactNode {
      const { data, load } = useLoader(ItemLoader);
      usePushHandle(Titles)(`Client ${data}`);
      usePushHandle(Title)(`Title ${data}`);
      return (
        <>
          <Readers />
          <button data-testid="load" onClick={() => void load()} />
        </>
      );
    }
    const { router, getByTestId } = await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: ReadersPage },
      ],
      {
        request: "/items",
        loaders: [[ItemLoader, "one"]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server one"], 1],
        ],
      },
    );
    expect(text("last")).toBe("Client one");
    expect(text("all")).toBe(titleOf(["Server one"], "Client one"));
    expect(text("several")).toBe("one: Title one");
    router.respondToLoads({ loaders: [[ItemLoader, "two"]] });
    await loadAndSettle(getByTestId("load"));
    expect(text("last")).toBe("Client two");
    expect(text("all")).toBe(titleOf(["Server one"], "Client two"));
    expect(text("several")).toBe("two: Title two");
  });

  it("a loader read keeps the server pushes its reply carries; the client's push follows them", async () => {
    function ReadPage(): ReactNode {
      const { data, load } = useLoader(ItemLoader);
      usePushHandle(Titles)(`Client ${data}`);
      return (
        <>
          <p data-testid="data">{data}</p>
          <button data-testid="load" onClick={() => void load()} />
        </>
      );
    }
    const { router, getByTestId } = await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: ReadPage },
      ],
      {
        request: "/items",
        loaders: [[ItemLoader, "one"]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server one"], 1],
        ],
      },
    );
    expect(text("title")).toBe(titleOf(["Server one"], "Client one"));
    router.respondToLoads({
      loaders: [[ItemLoader, "two"]],
      handles: [[Titles, ["Read two"]]],
    });
    await loadAndSettle(getByTestId("load"));
    expect(text("data")).toBe("two");
    // The read's push lands in the loader's segment, the route: after the
    // route's server values and before the client's.
    expect(router.handleData(Titles)[router.segmentId(1)]).toEqual([
      "Server one",
      "Read two",
      "Client two",
    ]);
    expect(text("title")).toBe(
      titleOf(["Server one", "Read two"], "Client two"),
    );
  });
});

describe("push() belongs to the render that called usePushHandle", () => {
  it("a push from an effect throws, naming the rule", async () => {
    let thrown: unknown;
    function FromEffect(): ReactNode {
      const push = usePushHandle(Titles);
      useEffect(() => {
        try {
          push("from effect");
        } catch (error) {
          thrown = error;
        }
      });
      return null;
    }
    await renderRoute([{ path: "/p", Component: FromEffect }], {
      request: "/p",
    });
    expect(String(thrown)).toContain(
      "push() was called after the render that created it committed",
    );
  });

  it("a push from an event handler throws, naming the rule", async () => {
    let thrown: unknown;
    function FromEvent(): ReactNode {
      const push = usePushHandle(Titles);
      return (
        <button
          data-testid="push"
          onClick={() => {
            try {
              push("from click");
            } catch (error) {
              thrown = error;
            }
          }}
        />
      );
    }
    const { getByTestId, router } = await renderRoute(
      [{ path: "/p", Component: FromEvent }],
      { request: "/p" },
    );
    await act(async () => fireEvent.click(getByTestId("push")));
    expect(String(thrown)).toContain("an event handler or a child");
    expect(router.handleData(Titles)).toEqual({});
  });

  it("push handed to a child: its values land in the owner's segment while it renders in the owner's pass", async () => {
    function Child({ push }: { push: (v: string) => void }): ReactNode {
      const [n, setN] = useState(0);
      if (n === 0) push("from child");
      return <button data-testid="child" onClick={() => setN(1)} />;
    }
    function Owner(): ReactNode {
      const push = usePushHandle(Titles);
      push("from owner");
      return <Child push={push} />;
    }
    errors.mockImplementation(() => {});
    const { router, getByTestId } = await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: Owner },
      ],
      {
        request: "/items",
        handles: [[Titles, ["Layout"], 0]],
      },
    );
    expect(router.handleData(Titles)[router.segmentId(1)]).toEqual([
      "from owner",
      "from child",
    ]);
    // The child renders again on its own, and pushes only on its first
    // render: no push, nothing thrown, the owner's committed values stay.
    await act(async () => fireEvent.click(getByTestId("child")));
    expect(router.handleData(Titles)[router.segmentId(1)]).toEqual([
      "from owner",
      "from child",
    ]);
  });

  it("a child that pushes on a render of its own throws, naming the rule", async () => {
    function Child({ push }: { push: (v: string) => void }): ReactNode {
      const [n, setN] = useState(0);
      push(`child ${n}`);
      return <button data-testid="child" onClick={() => setN(1)} />;
    }
    function Owner(): ReactNode {
      return <Child push={usePushHandle(Titles)} />;
    }
    let caught: unknown;
    class Catch extends Component<
      { children: ReactNode },
      { failed: boolean }
    > {
      state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      componentDidCatch(error: unknown): void {
        caught = error;
      }
      render(): ReactNode {
        return this.state.failed ? null : this.props.children;
      }
    }
    function Page(): ReactNode {
      return (
        <Catch>
          <Owner />
        </Catch>
      );
    }
    errors.mockImplementation(() => {});
    const { getByTestId } = await renderRoute(
      [{ path: "/p", Component: Page }],
      {
        request: "/p",
      },
    );
    await act(async () => fireEvent.click(getByTestId("child")));
    expect(String(caught)).toContain(
      "push() was called after the render that created it committed",
    );
  });
});

describe("usePushHandle under an outlet provider with no segment", () => {
  it("files its values under the nearest segment above, as a clientUrls group's page does", async () => {
    // ClientUrlsRoot (client-urls/client-root.tsx) wraps a group's page and
    // layouts in OutletProviders that carry no segment of their own.
    function GroupPage(): ReactNode {
      usePushHandle(Titles)("Client group");
      return null;
    }
    function GroupRoot(): ReactNode {
      return (
        <OutletProvider content={null}>
          <OutletProvider content={null}>
            <GroupPage />
          </OutletProvider>
        </OutletProvider>
      );
    }
    const { router } = await renderRoute(
      [
        { path: "/g", Component: Layout },
        { path: "/g", Component: GroupRoot },
      ],
      {
        request: "/g",
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server group"], 1],
        ],
      },
    );
    expect(router.handleData(Titles)[router.segmentId(1)]).toEqual([
      "Server group",
      "Client group",
    ]);
    expect(text("title")).toBe(titleOf(["Server group"], "Client group"));
    expect(messages(warnings, "rendered outside a route segment")).toEqual([]);
  });
});

describe("usePushHandle outside a route segment", () => {
  it("applies nothing and warns once in development", async () => {
    function Stray({ n }: { n: number }): ReactNode {
      usePushHandle(Titles)(`stray ${n}`);
      return null;
    }
    const { rerender } = render(<Stray n={1} />);
    rerender(<Stray n={2} />);
    expect(messages(warnings, "rendered outside a route segment")).toHaveLength(
      1,
    );
  });
});

describe("usePushHandle: render cost and lifetime", () => {
  const Nested = createHandle<{
    title: string;
    og: { image: { url: string } };
  }>(undefined, "__test_push_handle_nested__");

  it("a fresh nested object on every render, read by the pusher itself: no render loop", async () => {
    let renders = 0;
    function SelfReader(): ReactNode {
      renders++;
      usePushHandle(Nested)({ title: "T", og: { image: { url: "/a.png" } } });
      const read = useHandle(Nested);
      return <p data-testid="nested">{JSON.stringify(read)}</p>;
    }
    await renderRoute([{ path: "/n", Component: SelfReader }], {
      request: "/n",
    });
    expect(JSON.parse(text("nested"))).toEqual([
      [{ title: "T", og: { image: { url: "/a.png" } } }],
    ]);
    // The first render and the one its own push asks for; the next push is
    // equal and asks for none.
    expect(renders).toBeLessThanOrEqual(3);
    const settled = renders;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(renders).toBe(settled);
  });

  it("a fresh React element in a value: no render loop", async () => {
    let renders = 0;
    function ElementCrumb(): ReactNode {
      renders++;
      usePushHandle(Breadcrumbs)({
        label: "P",
        href: "/p",
        content: <b>icon</b>,
      });
      return <p data-testid="crumbs">{useHandle(Breadcrumbs).length}</p>;
    }
    await renderRoute([{ path: "/p", Component: ElementCrumb }], {
      request: "/p",
    });
    expect(text("crumbs")).toBe("1");
    const settled = renders;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(renders).toBe(settled);
    expect(renders).toBeLessThanOrEqual(3);
  });

  it("unmount removes the component's values; a remount with new data replaces them, never adds to them", async () => {
    function Toggled(): ReactNode {
      const [shown, setShown] = useState(true);
      const [n, setN] = useState(1);
      return (
        <>
          {shown && <Pusher data={`v${n}`} />}
          <button data-testid="hide" onClick={() => setShown(false)} />
          <button
            data-testid="show"
            onClick={() => {
              setN((v) => v + 1);
              setShown(true);
            }}
          />
        </>
      );
    }
    const { router, getByTestId } = await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: Toggled },
      ],
      {
        request: "/items",
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server one"], 1],
        ],
      },
    );
    expect(text("title")).toBe(titleOf(["Server one"], "Client v1"));
    await act(async () => fireEvent.click(getByTestId("hide")));
    expect(text("title")).toBe(titleOf(["Server one"]));
    await act(async () => fireEvent.click(getByTestId("show")));
    expect(text("title")).toBe(titleOf(["Server one"], "Client v2"));
    expect(router.handleData(Titles)[router.segmentId(1)]).toEqual([
      "Server one",
      "Client v2",
    ]);
  });

  it("a render that pushes nothing removes the component's values", async () => {
    function Conditional(): ReactNode {
      const [on, setOn] = useState(true);
      const push = usePushHandle(Titles);
      if (on) push("Client on");
      return <button data-testid="off" onClick={() => setOn(false)} />;
    }
    const { router, getByTestId } = await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: Conditional },
      ],
      { request: "/items", handles: [[Titles, ["Layout"], 0]] },
    );
    expect(text("title")).toBe("Layout / Client on");
    await act(async () => fireEvent.click(getByTestId("off")));
    expect(text("title")).toBe("Layout");
    expect(router.handleData(Titles)[router.segmentId(1)]).toBeUndefined();
  });
});

/**
 * push(promise) as on the server (handles/deferred-resolution.ts): the value
 * takes its place when it is pushed, readers keep what they showed until it
 * resolves, and a rejected or nullish one is dropped. `pushNext` sets what
 * the first pusher pushes on its next render; a second pusher after it in
 * the tree pushes "Second".
 */
describe("usePushHandle with a promise", () => {
  let pushNext: (value: string | Promise<string | null> | undefined) => void;
  function PromisePusher(): ReactNode {
    const [value, setValue] = useState<
      string | Promise<string | null> | undefined
    >("Client v1");
    pushNext = (next) => setValue(() => next);
    const push = usePushHandle(Titles);
    if (value !== undefined) push(value);
    return null;
  }
  function Second(): ReactNode {
    usePushHandle(Titles)("Second");
    return null;
  }
  function PromisePage(): ReactNode {
    const [shown, setShown] = useState(true);
    return (
      <>
        {shown && <PromisePusher />}
        <Second />
        <button data-testid="unmount" onClick={() => setShown(false)} />
      </>
    );
  }
  const mountPromisePage = () =>
    renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: PromisePage },
      ],
      {
        request: "/items",
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server one"], 1],
        ],
      },
    );
  const settle = (): Promise<void> =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

  it("readers keep what they showed until it resolves; the value takes the place it was pushed in", async () => {
    await mountPromisePage();
    expect(text("title")).toBe(titleOf(["Server one", "Client v1"], "Second"));
    const next = deferred<string | null>();
    log = [];
    await act(async () => pushNext(next.promise));
    // Pending: the previous value stays, never a blank.
    expect(text("title")).toBe(titleOf(["Server one", "Client v1"], "Second"));
    await act(async () => {
      next.resolve("Client v2");
      await next.promise;
    });
    // Resolved after "Second" committed, shown before it: its place.
    expect(text("title")).toBe(titleOf(["Server one", "Client v2"], "Second"));
    expect(
      log.filter((f) => !f.title.includes("Client v")).map((f) => f.title),
    ).toEqual([]);
  });

  it.each([
    { outcome: "rejects", settleWith: "reject" as const },
    { outcome: "resolves to null", settleWith: null },
  ])("a promise that $outcome is dropped", async ({ settleWith }) => {
    await mountPromisePage();
    let reject!: (error: Error) => void;
    let resolve!: (value: string | null) => void;
    const next = new Promise<string | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    next.catch(() => {});
    await act(async () => pushNext(next));
    await act(async () => {
      if (settleWith === "reject") reject(new Error("fetch failed"));
      else resolve(settleWith);
    });
    await settle();
    expect(text("title")).toBe(titleOf(["Server one"], "Second"));
  });

  it("a newer push drops a pending promise's result", async () => {
    await mountPromisePage();
    const older = deferred<string | null>();
    const newer = deferred<string | null>();
    await act(async () => pushNext(older.promise));
    await act(async () => pushNext(newer.promise));
    await act(async () => {
      newer.resolve("Newer");
      await newer.promise;
    });
    expect(text("title")).toBe(titleOf(["Server one", "Newer"], "Second"));
    await act(async () => {
      older.resolve("Older");
      await older.promise;
    });
    await settle();
    expect(text("title")).toBe(titleOf(["Server one", "Newer"], "Second"));
  });

  it("an unmount while pending drops the result", async () => {
    const { getByTestId } = await mountPromisePage();
    const next = deferred<string | null>();
    await act(async () => pushNext(next.promise));
    await act(async () => fireEvent.click(getByTestId("unmount")));
    expect(text("title")).toBe(titleOf(["Server one"], "Second"));
    await act(async () => {
      next.resolve("Too late");
      await next.promise;
    });
    await settle();
    expect(text("title")).toBe(titleOf(["Server one"], "Second"));
  });

  it.each([
    { kind: "the same promise on every render", fresh: false },
    { kind: "a fresh promise on every render", fresh: true },
  ])(
    "$kind, read by the pusher itself: no render loop, no blank frame",
    async ({ fresh }) => {
      let renders = 0;
      const stable = Promise.resolve("Fetched");
      function SelfReader(): ReactNode {
        renders++;
        usePushHandle(Title)(fresh ? Promise.resolve("Fetched") : stable);
        return <p data-testid="t">{useHandle(Title) || "-"}</p>;
      }
      const seen: string[] = [];
      await renderRoute(
        [
          {
            path: "/t",
            Component: () => (
              <Profiler id="t" onRender={() => seen.push(text("t"))}>
                <SelfReader />
              </Profiler>
            ),
          },
        ],
        { request: "/t" },
      );
      await settle();
      expect(text("t")).toBe("Fetched");
      const settled = renders;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(renders).toBe(settled);
      expect(renders).toBeLessThanOrEqual(4);
      // Once shown, the value never goes back to blank while a new promise
      // is pending.
      expect(seen.slice(seen.indexOf("Fetched"))).not.toContain("-");
    },
  );

  const Plain = createHandle<{ title: string }, { title: string }[]>(
    (segments) => segments.flat().map((v) => ({ ...v })),
    "__test_push_handle_plain_promise__",
  );
  it.each([
    { kind: "Meta", handle: Meta as Handle<any, any>, value: { title: "T" } },
    { kind: "a plain object handle", handle: Plain, value: { title: "T" } },
  ])(
    "a fresh promise resolving to $kind on every render, read by the pusher itself or by a component above it: bounded renders",
    async ({ handle, value }) => {
      let renders = 0;
      function SelfReader(): ReactNode {
        renders++;
        usePushHandle(handle)(Promise.resolve({ ...value }));
        const read = useHandle(handle);
        return <p data-testid="t">{JSON.stringify(read)}</p>;
      }
      let layoutRenders = 0;
      function ReadingLayout(): ReactNode {
        layoutRenders++;
        useHandle(handle);
        return <Outlet />;
      }
      await renderRoute(
        [
          {
            path: "/t",
            Component: ReadingLayout,
          },
          { path: "/t", Component: SelfReader },
        ],
        { request: "/t" },
      );
      await settle();
      expect(text("t")).toContain("T");
      const settled = [renders, layoutRenders];
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect([renders, layoutRenders]).toEqual(settled);
      expect(renders).toBeLessThanOrEqual(4);
    },
  );

  it("a promise inside a pushed value passes through untouched (a crumb's content)", async () => {
    const content = Promise.resolve(<b>icon</b>);
    function CrumbPage(): ReactNode {
      usePushHandle(Breadcrumbs)({ label: "P", href: "/p", content });
      const crumbs = useHandle(Breadcrumbs);
      return <p data-testid="same">{String(crumbs[0]?.content === content)}</p>;
    }
    await renderRoute([{ path: "/p", Component: CrumbPage }], {
      request: "/p",
    });
    expect(text("same")).toBe("true");
  });
});

/**
 * A server crumb with the project's old name and a client crumb with the new
 * name, same href, in the same segment: the client's follows the server's,
 * and the handle's collect decides what shows.
 */
describe("Breadcrumbs: the server's crumb and the client's for one href", () => {
  const Identity = createHandle<BreadcrumbItem>(
    undefined,
    "__test_push_handle_identity_crumbs__",
  );
  const Flat = createHandle<BreadcrumbItem, BreadcrumbItem[]>(
    (segments) => segments.flat(),
    "__test_push_handle_flat_crumbs__",
  );
  const old = { label: "Old name", href: "/p/1" };
  const renamed = { label: "New name", href: "/p/1" };

  it.each<{
    collect: string;
    handle: Handle<BreadcrumbItem, unknown>;
    shows: unknown;
  }>([
    { collect: "identity", handle: Identity, shows: [[old, renamed]] },
    { collect: "flat", handle: Flat, shows: [old, renamed] },
    {
      collect: "Breadcrumbs (dedupe by href, last value)",
      handle: Breadcrumbs,
      shows: [renamed],
    },
  ])("$collect", async ({ handle, shows }) => {
    function CrumbPage(): ReactNode {
      usePushHandle(handle)(renamed);
      return <p data-testid="crumbs">{JSON.stringify(useHandle(handle))}</p>;
    }
    await renderRoute([{ path: "/p/:id", Component: CrumbPage }], {
      request: "/p/1",
      handles: [[handle, [old]]],
    });
    expect(JSON.parse(text("crumbs"))).toEqual(shows);
  });
});

/**
 * Why arrival order is rejected: the document's loader pushed a promise that
 * settles to "Old" only after a load() refreshed the data and the client
 * pushed "New". Position decides, so "New" shows; a merge by arrival time
 * puts "Old" last and a last-wins title shows it.
 */
describe("a late server value older than the client's", () => {
  it('shows "New"; an arrival-order merge would show "Old"', async () => {
    function TitlePage(): ReactNode {
      const { data, load } = useLoader(ItemLoader);
      usePushHandle(Title)(data);
      return (
        <>
          <p data-testid="t">{useHandle(Title)}</p>
          <button data-testid="load" onClick={() => void load()} />
        </>
      );
    }
    const { router, getByTestId } = await renderRoute(
      [{ path: "/t", Component: TitlePage }],
      {
        request: "/t",
        loaders: [[ItemLoader, "Old"]],
      },
    );
    router.respondToLoads({ loaders: [[ItemLoader, "New"]] });
    await loadAndSettle(getByTestId("load"));
    expect(text("t")).toBe("New");
    await router.pushLateHandles([[Title, ["Old"]]]);
    expect(text("t")).toBe("New");

    const byArrival = collectHandleData(
      Title,
      { [Title.$$id]: { [router.segmentId()]: ["New", "Old"] } },
      [router.segmentId()],
    );
    expect(byArrival).toBe("Old");
  });
});
