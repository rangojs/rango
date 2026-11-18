// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Component,
  Profiler,
  Suspense,
  use,
  useState,
  type ReactNode,
} from "react";
import { act, cleanup, configure, fireEvent } from "@testing-library/react";
import { Outlet, ParallelOutlet } from "../../client.js";
import { collectHandleData, createHandle, type Handle } from "../../handle.js";
import { Breadcrumbs, type BreadcrumbItem } from "../../handles/breadcrumbs.js";
import { Meta } from "../../handles/meta.js";
import { useHandle } from "../../browser/react/use-handle.js";
import { usePushHandle } from "../../browser/react/use-push-handle.js";
import type { ClientHandleMerge } from "../../browser/event-controller.js";
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
 * first. Each case runs under both merge modes: "append" (the default: the
 * client's values after the server's in their segment) and "replace" (the
 * client's values in place of the server's).
 *
 * Frames are measured, not reasoned: a Profiler over the page records the DOM
 * at every React commit, with a tick that moves at the next microtask, so the
 * last commit of a tick is what the browser can paint. `painted()` keeps those.
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

/** The title for the layout's "Layout" and segment 1's server values. */
const titleOf = (
  mode: ClientHandleMerge,
  server: string[],
  client?: string,
): string =>
  [
    "Layout",
    ...(client === undefined
      ? server
      : mode === "append"
        ? [...server, client]
        : [client]),
  ].join(" / ");

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function mount(
  mode: ClientHandleMerge,
  options: { transition?: boolean; data?: string; hydrate?: boolean } = {},
) {
  return renderRoute(routes(options.transition ?? false), {
    request: "/items?id=1",
    loaders: [[ItemLoader, options.data ?? "one"]],
    handles: [
      [Titles, ["Layout"], 0],
      [Titles, ["Server one"], 1],
    ],
    clientHandleMerge: mode,
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

describe.each<ClientHandleMerge>(["append", "replace"])(
  "usePushHandle (%s)",
  (mode) => {
    it("G1/case 1: a late server push into the owned segment, in either arrival order; unmount shows the server's", async () => {
      // Order A: the pusher is mounted, then the late push lands.
      const a = await mount(mode);
      expect(text("title")).toBe(titleOf(mode, ["Server one"], "Client one"));
      await a.router.pushLateHandles([[Titles, ["Late one"], 1]]);
      const screenA = text("title");
      expect(screenA).toBe(titleOf(mode, ["Late one"], "Client one"));
      await act(async () => fireEvent.click(a.getByTestId("toggle")));
      expect(text("title")).toBe(titleOf(mode, ["Late one"]));
      cleanup();

      // Order B: the late push lands, then the pusher mounts.
      const b = await mount(mode);
      await act(async () => fireEvent.click(b.getByTestId("toggle")));
      await b.router.pushLateHandles([[Titles, ["Late one"], 1]]);
      await act(async () => fireEvent.click(b.getByTestId("toggle")));
      expect(text("title")).toBe(screenA);
    });

    it("case 2: a late push into another segment shows", async () => {
      const { router } = await mount(mode);
      await router.pushLateHandles([[Titles, ["Late layout"], 0]]);
      expect(text("title")).toBe(
        titleOf(mode, ["Server one"], "Client one").replace(
          "Layout",
          "Late layout",
        ),
      );
    });

    it("G2: a plain load() refresh paints no frame with the new data and the old title", async () => {
      const { router, getByTestId } = await mount(mode);
      router.respondToLoads({ loaders: [[ItemLoader, "loaded"]] });
      log = [];
      await loadAndSettle(getByTestId("load"));
      expect(text("data")).toBe("loaded");
      expect(text("title")).toBe(
        titleOf(mode, ["Server one"], "Client loaded"),
      );
      expect(painted(log).filter(mixes)).toEqual([]);
    });

    it("G2 (commit level): a load() refresh commits the new data before the title, corrected before paint", async () => {
      const { router, getByTestId } = await mount(mode);
      router.respondToLoads({ loaders: [[ItemLoader, "loaded"]] });
      log = [];
      await loadAndSettle(getByTestId("load"));
      // Measured: one commit shows "loaded" with the old title; the reader's
      // update from the pusher's layout effect commits in the same task.
      const mixed = log.filter(mixes);
      expect(mixed).toHaveLength(1);
      expect(log.filter((f) => f.tick === mixed[0].tick).at(-1)).toEqual({
        ...mixed[0],
        title: titleOf(mode, ["Server one"], "Client loaded"),
      });
    });

    it("case 3: a load() racing a navigation's revalidation of the same loader: the title follows what the component renders", async () => {
      const { router, getByTestId } = await mount(mode, { transition: true });
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
      "case 4: navigating away ($variant): no frame shows the old client value over the new page",
      async ({ transition }) => {
        const { router } = await mount(mode, { transition });
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
        expect(text("title")).toBe(titleOf(mode, ["Server two"]));
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
      "G2: a reader that mounts with the pusher ($variant) paints no frame without its value",
      async ({ transition }) => {
        const { router } = await mount(mode, { transition });
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
          titleOf(mode, ["Server two"], "Client with reader"),
        );
        const own = painted(log).filter(
          (f) => f.data === "with reader" && f.own !== "",
        );
        expect(own.length).toBeGreaterThan(0);
        expect(
          own.filter((f) => !f.own.includes("Client with reader")),
        ).toEqual([]);
      },
    );

    it("case 5: a same-route navigation held in a transition: the push follows the committed render", async () => {
      const { router } = await mount(mode, { transition: true });
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
      expect(text("title")).toBe(titleOf(mode, ["Server one"], "Client one"));
      await act(async () => {
        nav.resolve("two");
        await nav.promise;
      });
      expect(text("title")).toBe(titleOf(mode, ["Server two"], "Client two"));
      expect(painted(log).filter(mixes)).toEqual([]);
    });

    it("case 6/G7: SSR values until the hydration lock releases, then the client layer; dev warns of the drift", async () => {
      const result = (await mount(mode, {
        hydrate: true,
      })) as RenderRouteHydrateResult;
      expect(result.serverHtml).toContain(
        `<p data-testid="title">${titleOf(mode, ["Server one"])}</p>`,
      );
      expect(result.recoverableErrors).toEqual([]);
      expect(text("title")).toBe(titleOf(mode, ["Server one"], "Client one"));
      expect(messages(warnings, "usePushHandle")).toHaveLength(1);
    });

    it("G7: no drift warning when the client value matches the SSR value", async () => {
      function TitlePage(): ReactNode {
        usePushHandle(Title)("Same");
        return <p data-testid="t">{useHandle(Title)}</p>;
      }
      const result = await renderRoute([{ path: "/t", Component: TitlePage }], {
        request: "/t",
        handles: [[Title, ["Same"]]],
        clientHandleMerge: mode,
        hydrate: true,
      });
      expect(result.recoverableErrors).toEqual([]);
      expect(text("t")).toBe("Same");
      expect(messages(warnings, "usePushHandle")).toEqual([]);
    });

    it("case 7: a ppr live-lane push after hydration into the owned segment", async () => {
      const result = await renderRoute(routes(false), {
        request: "/items?id=1",
        loaders: [[ItemLoader, "one"]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server one"], 1],
        ],
        lateHandles: [[Titles, ["Live lane"], 1]],
        clientHandleMerge: mode,
        hydrate: true,
      });
      expect(result.recoverableErrors).toEqual([]);
      expect(text("title")).toBe(titleOf(mode, ["Live lane"], "Client one"));
    });

    it("case 8: Back/Forward: no client value in the history snapshot; the restored page pushes again in its commit", async () => {
      const { router } = await mount(mode);
      const seg = router.segmentId(1);
      // What production writes into the history entry (liveHandleDataForCache).
      expect(router.eventController.getHandleState().data[Titles.$$id]).toEqual(
        { [router.segmentId(0)]: ["Layout"], [seg]: ["Server one"] },
      );
      await router.navigate("/items?id=2", {
        loaders: [[ItemLoader, "two"]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server two"], 1],
        ],
        state: [],
      });
      expect(text("title")).toBe(titleOf(mode, ["Server two"], "Client two"));
      log = [];
      await act(async () => {
        window.history.back();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(text("data")).toBe("one");
      expect(text("title")).toBe(titleOf(mode, ["Server one"], "Client one"));
      expect(painted(log).filter(mixes)).toEqual([]);
    });

    it("G6/case 9: two pushers of one handle in one segment: a dev error, the first mounted shows", async () => {
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
          clientHandleMerge: mode,
        },
      );
      expect(messages(errors, "two mounted components push")).toHaveLength(1);
      expect(text("title")).toBe(titleOf(mode, ["Server one"], "Client one"));
    });

    it("case 10: a pusher in a layout's slot, an intercept, and a route's own slot files its values in that segment", async () => {
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
          clientHandleMerge: mode,
        },
      );
      expect(router.handleData(Titles)).toEqual({
        [router.segmentId(0)]: ["Layout"],
        [router.segmentId([0, "@side"])]:
          mode === "append" ? ["Server side", "Side"] : ["Side"],
        [router.segmentId([0, "@modal"])]: ["Modal"],
        [router.segmentId([1, "@aside"])]: ["Aside"],
      });
      // The slots collect after their parent, in segment order.
      expect(text("title")).toBe(
        [
          "Layout",
          ...(mode === "append" ? ["Server side"] : []),
          "Side",
          "Modal",
          "Aside",
        ].join(" / "),
      );
    });

    it("case 11: an error boundary replacing the pusher brings back the server values", async () => {
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
          clientHandleMerge: mode,
        },
      );
      expect(text("title")).toBe(titleOf(mode, ["Server one"], "Client one"));
      await act(async () => fireEvent.click(getByTestId("fail")));
      expect(text("failed")).toBe("failed");
      expect(text("title")).toBe(titleOf(mode, ["Server one"]));
    });

    it("case 12: StrictMode's double render and effects give the same result", async () => {
      configure({ reactStrictMode: true });
      const { router, getByTestId } = await mount(mode);
      expect(text("title")).toBe(titleOf(mode, ["Server one"], "Client one"));
      router.respondToLoads({ loaders: [[ItemLoader, "loaded"]] });
      await loadAndSettle(getByTestId("load"));
      expect(text("title")).toBe(
        titleOf(mode, ["Server one"], "Client loaded"),
      );
      expect(messages(errors, "usePushHandle")).toEqual([]);
    });

    it("case 13: an action revalidation updating the owned segment's server values", async () => {
      const { router } = await mount(mode);
      log = [];
      await router.action({
        loaders: [[ItemLoader, "two"]],
        handles: [
          [Titles, ["Layout"], 0],
          [Titles, ["Server after action"], 1],
        ],
      });
      expect(text("data")).toBe("two");
      expect(text("title")).toBe(
        titleOf(mode, ["Server after action"], "Client two"),
      );
      expect(painted(log).filter(mixes)).toEqual([]);
    });

    it("G4: a pusher that suspends pushes nothing; the server's values show until it commits", async () => {
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
          clientHandleMerge: mode,
        },
      );
      expect(text("pending")).toBe("pending");
      expect(text("title")).toBe(titleOf(mode, ["Server one"]));
      await act(async () => {
        gate.resolve("late");
        await gate.promise;
      });
      expect(text("title")).toBe(titleOf(mode, ["Server one"], "Client late"));
    });

    it("G5: a thenable client value is an error", async () => {
      function PushesPromise(): ReactNode {
        usePushHandle(Titles)(Promise.resolve("x") as unknown as string);
        return null;
      }
      errors.mockImplementation(() => {});
      await renderRoute([{ path: "/p", Component: PushesPromise }], {
        request: "/p",
        clientHandleMerge: mode,
      });
      expect(
        messages(errors, "a client push takes a plain value, not a promise"),
      ).not.toEqual([]);
    });

    it("push() after the render committed is an error", async () => {
      let late: ((v: string) => void) | undefined;
      function Keeps(): ReactNode {
        late = usePushHandle(Titles);
        return null;
      }
      await renderRoute([{ path: "/p", Component: Keeps }], {
        request: "/p",
        clientHandleMerge: mode,
      });
      expect(() => late!("x")).toThrow("push() after the render committed");
    });

    it("(a) a last-wins title: the client's title shows", async () => {
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
          clientHandleMerge: mode,
        },
      );
      expect(text("t")).toBe("Client title");
    });

    it("(b) Meta: the client's title over a server title and description from the same segment", async () => {
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
        clientHandleMerge: mode,
      });
      const meta = JSON.parse(text("meta")) as Record<string, unknown>[];
      expect(meta).toContainEqual({ title: "Client" });
      expect(meta).not.toContainEqual({ title: "Server" });
      const description = { name: "description", content: "D" };
      if (mode === "append") expect(meta).toContainEqual(description);
      else expect(meta).not.toContainEqual(description);
    });
  },
);

/**
 * (c) A server crumb with the project's old name and a client crumb with the
 * new name, same href, in the same segment. Recorded per collect and mode.
 */
describe("(c) Breadcrumbs: the server's crumb and the client's for one href", () => {
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
    mode: ClientHandleMerge;
    shows: unknown;
  }>([
    {
      collect: "identity",
      handle: Identity,
      mode: "append",
      shows: [[old, renamed]],
    },
    {
      collect: "identity",
      handle: Identity,
      mode: "replace",
      shows: [[renamed]],
    },
    { collect: "flat", handle: Flat, mode: "append", shows: [old, renamed] },
    { collect: "flat", handle: Flat, mode: "replace", shows: [renamed] },
    {
      collect: "Breadcrumbs (dedupe by href, last value)",
      handle: Breadcrumbs,
      mode: "append",
      shows: [renamed],
    },
    {
      collect: "Breadcrumbs (dedupe by href, last value)",
      handle: Breadcrumbs,
      mode: "replace",
      shows: [renamed],
    },
  ])("$collect, $mode", async ({ handle, mode, shows }) => {
    function CrumbPage(): ReactNode {
      usePushHandle(handle)(renamed);
      return <p data-testid="crumbs">{JSON.stringify(useHandle(handle))}</p>;
    }
    await renderRoute([{ path: "/p/:id", Component: CrumbPage }], {
      request: "/p/1",
      handles: [[handle, [old]]],
      clientHandleMerge: mode,
    });
    expect(JSON.parse(text("crumbs"))).toEqual(shows);
  });
});

/**
 * Why arrival order is rejected: the document's loader pushed a promise that
 * settles to "Old" only after a load() refreshed the data and the client
 * pushed "New". Position decides, so "New" shows in both modes; a merge by
 * arrival time puts "Old" last and a last-wins title shows it.
 */
describe.each<ClientHandleMerge>(["append", "replace"])(
  "a late server value older than the client's (%s)",
  (mode) => {
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
          clientHandleMerge: mode,
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
  },
);
