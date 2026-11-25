// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Activity,
  startTransition,
  Suspense,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  createLocationState,
  Link,
  Meta,
  Outlet,
  useHandle,
  useLoader,
  useLocationState,
  useMount,
  useNavigation,
  useParams,
  usePathname,
  usePushHandle,
  useSearchParams,
} from "../../client.js";
import { createHandle } from "../../handle.js";
import { ScrollRestoration } from "../../html.js";
import { MetaTags } from "../../handles/MetaTags.js";
import { resetPrefetchObserverForTesting } from "../../browser/prefetch/observer.js";
import {
  getSavedScrollPosition,
  saveCurrentScrollPosition,
} from "../../browser/scroll-restoration.js";
import type { LoaderDefinition } from "../../types.js";
import { withLocationStateKey } from "../index.js";
import { renderRoute } from "../render-route.js";

/**
 * What the router's client hooks, loaders, handles and components do inside
 * a part of a page that userland hides with React's <Activity mode="hidden">,
 * across a hide, a navigation and a show, on today's router.
 *
 * Every probe logs each render (`render <probe> <value>`) and each commit of
 * that render (`commit <probe> <value>`, from a layout effect, which a hidden
 * <Activity> does not run). A show re-runs the layout effects of the last
 * render, so the first `commit` after `--- show` is what the first visible
 * commit drew. Under act() the passive effects of a commit flush before act
 * returns, so two commits here can be one browser frame or two; the
 * `useEndOfTask` probes, run without act(), tell them apart in a DOM.
 */

let log: string[];
const mark = (event: string): void => {
  log.push(`--- ${event}`);
};
/** The log after the last `--- <event>`. */
const since = (event: string): string[] =>
  log.slice(log.lastIndexOf(`--- ${event}`) + 1);
/** The log between `--- <from>` and the next `--- <to>`. */
const between = (from: string, to: string): string[] => {
  const tail = since(from);
  const end = tail.indexOf(`--- ${to}`);
  return end === -1 ? tail : tail.slice(0, end);
};
const dump = (title: string): void => {
  if (process.env.ACTIVITY_LOG)
    process.stderr.write(`# ${title}\n${log.join("\n")}\n\n`);
};

function useLogged(name: string, value: string): void {
  log.push(`render ${name} ${value}`);
  useLayoutEffect(() => {
    log.push(`commit ${name} ${value}`);
  });
}

let setMode: (mode: "visible" | "hidden") => void;

/** A part of the layout the test hides and shows. */
function Hideable({ children }: { children: ReactNode }): ReactNode {
  const [mode, set] = useState<"visible" | "hidden">("visible");
  setMode = set;
  return <Activity mode={mode}>{children}</Activity>;
}

async function hide(): Promise<void> {
  mark("hide");
  await act(async () => setMode("hidden"));
}
async function show(inTransition = false): Promise<void> {
  mark("show");
  await act(async () => {
    if (inTransition) startTransition(() => setMode("visible"));
    else setMode("visible");
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const text = (id: string): string =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>(),
  "HiddenActivityFlash",
);

function UrlProbe({ name }: { name: string }): ReactNode {
  const pathname = usePathname();
  const id = useParams((p) => p.id ?? "");
  const [search] = useSearchParams();
  const state = useLocationState(Flash);
  const value = `${pathname}?${search.toString()} id=${id} state=${state?.text ?? "-"}`;
  useLogged(name, value);
  return <p data-testid={name}>{value}</p>;
}

function NavProbe({ name }: { name: string }): ReactNode {
  const nav = useNavigation();
  const loading = useNavigation((n) => n.state === "loading");
  const value = `${nav.state} ${nav.location.pathname} selector=${loading ? "loading" : "idle"}`;
  useLogged(name, value);
  return <p data-testid={name}>{value}</p>;
}

function Leaf(): ReactNode {
  return <p data-testid="leaf">leaf</p>;
}

let errors: ReturnType<typeof vi.spyOn>;
let warnings: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = [];
  errors = vi.spyOn(console, "error");
  warnings = vi.spyOn(console, "warn");
});
afterEach(() => {
  cleanup();
  // No probe here makes React or the router report an error.
  expect(errors).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

// renderRoute keys every segment of the chain by its params unless the chain
// is in a transition() scope (segment-system.tsx), so a param change would
// remount the layout and the <Activity> with it. A search change keeps every
// key; a param change keeps them under transition().
const chain = (Layout: () => ReactNode, transition: boolean) => [
  { path: "/", Component: Layout, ...(transition && { transition: {} }) },
  { path: "/p/:id", Component: Leaf },
];

describe("A2: URL hooks and location state inside a hidden <Activity>", () => {
  function Layout(): ReactNode {
    return (
      <>
        <UrlProbe name="shown" />
        <Hideable>
          <UrlProbe name="hidden" />
        </Hideable>
        <Outlet />
      </>
    );
  }

  it.each([
    { to: "/p/1?q=b", transition: false, inTransition: false },
    { to: "/p/1?q=b", transition: false, inTransition: true },
    { to: "/p/2?q=b", transition: true, inTransition: false },
    { to: "/p/2?q=b", transition: true, inTransition: true },
  ])(
    "hide, navigate to $to (transition() $transition), show (in a transition: $inTransition)",
    async ({ to, transition, inTransition }) => {
      const { router } = await renderRoute(chain(Layout, transition), {
        request: "/p/1?q=a",
      });
      await hide();
      mark("navigate");
      await router.navigate(to, { state: [Flash({ text: "two" })] });
      await show(inTransition);
      dump(`A2 ${to} ${transition} ${inTransition}`);
      const before = "/p/1?q=a id=1";
      const after = to === "/p/1?q=b" ? "/p/1?q=b id=1" : "/p/2?q=b id=2";

      // While hidden: the URL hooks keep their value, location state moves.
      expect(between("navigate", "show")).toEqual([
        `render shown ${after} state=two`,
        `commit shown ${after} state=two`,
        `render hidden ${before} state=two`,
      ]);
      // The first visible commit draws the old URL with the new state; a
      // second commit brings the URL.
      expect(since("show")).toEqual([
        `commit hidden ${before} state=two`,
        `render hidden ${after} state=two`,
        `commit hidden ${after} state=two`,
      ]);
      expect(text("hidden")).toBe(`${after} state=two`);
    },
  );

  it("shown while React holds a navigation's page: the destination's URL beside the held page", async () => {
    const PageLoader = {
      __brand: "loader",
      $$id: "hidden-activity#A2PageLoader",
    } as unknown as LoaderDefinition<string>;
    function Page(): ReactNode {
      return <p data-testid="page">{useLoader(PageLoader).data}</p>;
    }
    const { router } = await renderRoute(
      [
        { path: "/", Component: Layout },
        { path: "/p/:id", Component: Page, transition: {} },
      ],
      { request: "/p/1?q=a", loaders: [[PageLoader, "one"]] },
    );
    await hide();
    const next = deferred<string>();
    mark("navigate");
    await router.navigate("/p/2?q=b", {
      loaders: [[PageLoader, next.promise]],
    });
    await show();
    dump("A2 held");
    // The reader shown mid-navigation reads the controller's location, which
    // is already the destination's while React holds the page on /p/1.
    expect(since("show").slice(0, 3)).toEqual([
      "commit hidden /p/1?q=a id=1 state=-",
      "render hidden /p/2?q=b id=2 state=-",
      "commit hidden /p/2?q=b id=2 state=-",
    ]);
    expect(text("page")).toBe("one");
    expect(text("shown")).toBe("/p/1?q=a id=1 state=-");
    expect(text("hidden")).toBe("/p/2?q=b id=2 state=-");
    await act(async () => next.resolve("two"));
    await settle();
    expect(text("shown")).toBe("/p/2?q=b id=2 state=-");
    expect(text("hidden")).toBe("/p/2?q=b id=2 state=-");
  });
});

describe("A3: useNavigation inside a hidden <Activity>", () => {
  const PageLoader = {
    __brand: "loader",
    $$id: "hidden-activity#PageLoader",
  } as unknown as LoaderDefinition<string>;

  function Layout(): ReactNode {
    return (
      <>
        <NavProbe name="shown" />
        <Hideable>
          <NavProbe name="hidden" />
        </Hideable>
        <Outlet />
      </>
    );
  }
  function Page(): ReactNode {
    return <p data-testid="page">{useLoader(PageLoader).data}</p>;
  }
  const routes = [
    { path: "/", Component: Layout },
    { path: "/p/:id", Component: Page, transition: {} },
  ];

  it("hidden before a navigation, shown after it settled", async () => {
    const { router } = await renderRoute(routes, {
      request: "/p/1",
      loaders: [[PageLoader, "one"]],
    });
    await hide();
    mark("navigate");
    await router.navigate("/p/2", { loaders: [[PageLoader, "two"]] });
    await settle();
    await show();
    dump("A3 settled");
    expect(since("show")).toEqual([
      "commit hidden idle /p/1 selector=idle",
      "render hidden idle /p/2 selector=idle",
      "commit hidden idle /p/2 selector=idle",
    ]);
  });

  it("hidden while a navigation is pending, shown after it settled", async () => {
    const { router } = await renderRoute(routes, {
      request: "/p/1",
      loaders: [[PageLoader, "one"]],
    });
    const next = deferred<string>();
    mark("navigate");
    await router.navigate("/p/2", { loaders: [[PageLoader, next.promise]] });
    expect(text("hidden")).toBe("loading /p/1 selector=loading");
    await hide();
    mark("settle");
    await act(async () => next.resolve("two"));
    await settle();
    expect(text("page")).toBe("two");
    await show();
    dump("A3 pending");
    // The settle set the hidden reader in the page's own transition, before
    // the hide: it rendered offscreen, and the show commits it.
    expect(since("show")).toEqual(["commit hidden idle /p/2 selector=idle"]);
  });

  it("hidden while idle, shown while a navigation is pending", async () => {
    const { router } = await renderRoute(routes, {
      request: "/p/1",
      loaders: [[PageLoader, "one"]],
    });
    await hide();
    const next = deferred<string>();
    mark("navigate");
    await router.navigate("/p/2", { loaders: [[PageLoader, next.promise]] });
    await show();
    dump("A3 shown pending");
    // The reader shown mid-navigation reads the controller's live state, not
    // the held page's: it draws the destination, idle, beside a page still
    // held on /p/1 whose other reader says loading.
    expect(since("show").slice(0, 3)).toEqual([
      "commit hidden idle /p/1 selector=idle",
      "render hidden idle /p/2 selector=idle",
      "commit hidden idle /p/2 selector=idle",
    ]);
    expect(text("page")).toBe("one");
    expect(text("shown")).toBe("loading /p/1 selector=loading");
    expect(text("hidden")).toBe("idle /p/2 selector=idle");
    mark("settle");
    await act(async () => next.resolve("two"));
    await settle();
    dump("A3 shown pending, settled");
    expect(text("page")).toBe("two");
    expect(text("hidden")).toBe("idle /p/2 selector=idle");
    expect(text("shown")).toBe("idle /p/2 selector=idle");
  });
});

/**
 * The DOM at the end of the task that committed a render: a layout effect
 * queues a chain of microtasks, which runs after React's own microtask work
 * of that task and before the next task, where a browser could paint.
 */
function useEndOfTask(name: string, enabled = true): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    let hops = 0;
    const hop = (): void => {
      if (++hops < 50) queueMicrotask(hop);
      else log.push(`end of task ${name} ${text(name)}`);
    };
    queueMicrotask(hop);
  });
}

/** Runs `start` with act() off and waits for the tasks it schedules. */
async function withoutAct(start: () => void): Promise<void> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    start();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = true;
  }
}

/** A click on the layout's show button, a discrete event as a user's is. */
const clickShow = (): void => {
  document
    .querySelector('[data-testid="show"]')!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
};

function TaskProbe({ name }: { name: string }): ReactNode {
  const pathname = usePathname();
  const nav = useNavigation((n) => `${n.state} ${n.location.pathname}`);
  const value = `${pathname} nav=${nav}`;
  useLogged(name, value);
  useEndOfTask(name);
  return <p data-testid={name}>{value}</p>;
}

describe("A2, A3: the show's first task, without act()", () => {
  function Layout(): ReactNode {
    return (
      <>
        <button data-testid="show" onClick={() => setMode("visible")} />
        <Hideable>
          <TaskProbe name="hidden" />
        </Hideable>
        <Outlet />
      </>
    );
  }
  it.each(["a click", "a transition"])(
    "shown by %s: the stale value is on screen at the end of a task",
    async (by) => {
      const { router } = await renderRoute(chain(Layout, true), {
        request: "/p/1",
      });
      await hide();
      await router.navigate("/p/2");
      await settle();
      mark("show");
      await withoutAct(
        by === "a click"
          ? clickShow
          : () => startTransition(() => setMode("visible")),
      );
      dump(`A2/A3 end of task, ${by}`);
      // The show's commit draws the pre-hide URL and navigation location, and
      // its task ends with them on screen; the current ones commit in a
      // later task, from the hooks' passive subscription effect.
      expect(since("show")).toEqual([
        "commit hidden /p/1 nav=idle /p/1",
        "end of task hidden /p/1 nav=idle /p/1",
        "render hidden /p/2 nav=idle /p/2",
        "commit hidden /p/2 nav=idle /p/2",
        "end of task hidden /p/2 nav=idle /p/2",
      ]);
    },
  );
});

describe("A4: useLoader inside a hidden <Activity>", () => {
  const DataLoader = {
    __brand: "loader",
    $$id: "hidden-activity#DataLoader",
  } as unknown as LoaderDefinition<string>;

  function Reader({
    name,
    keyed,
  }: {
    name: string;
    keyed?: boolean;
  }): ReactNode {
    const { data, load } = useLoader(
      DataLoader,
      keyed ? { key: "k" } : undefined,
    );
    useLogged(name, data);
    return (
      <>
        <p data-testid={name}>{data}</p>
        <button
          data-testid={`${name}-refresh`}
          onClick={() => void load().catch(() => {})}
        />
      </>
    );
  }
  function Fallback({ name }: { name: string }): ReactNode {
    useLogged(`${name}-fallback`, "loading");
    return <p data-testid={`${name}-fallback`}>loading</p>;
  }
  function layout(keyed: boolean) {
    return function Layout(): ReactNode {
      return (
        <>
          <Suspense fallback={<Fallback name="shown" />}>
            <Reader name="shown" keyed={keyed} />
          </Suspense>
          <Hideable>
            <Suspense fallback={<Fallback name="hidden" />}>
              <Reader name="hidden" keyed={keyed} />
            </Suspense>
          </Hideable>
          <Outlet />
        </>
      );
    };
  }
  // The layout's loader, re-run by a search-only navigation (keys stay).
  const open = (keyed = false) =>
    renderRoute(
      [
        { path: "/", Component: layout(keyed), loaderIds: [DataLoader.$$id] },
        { path: "/p", Component: Leaf },
      ],
      { request: "/p?v=1", loaders: [[DataLoader, "one"]] },
    );

  it("data that landed while hidden: the first visible commit draws it", async () => {
    const { router } = await open();
    await hide();
    mark("navigate");
    await router.navigate("/p?v=2", { loaders: [[DataLoader, "two"]] });
    await show();
    dump("A4 settled");
    // While hidden the reader re-renders offscreen from the new route data;
    // the show commits it, then its reset effect, which the hide had
    // disconnected, renders it once more with the same data.
    expect(since("navigate")).toEqual([
      "render shown two",
      "commit shown two",
      "render shown two",
      "commit shown two",
      "render hidden two",
      "--- show",
      "commit hidden two",
      "render hidden two",
      "commit hidden two",
    ]);
  });

  it("data that streams in while hidden: the hidden reader suspends offscreen, no fallback is committed", async () => {
    const { router } = await open();
    await hide();
    const next = deferred<string>();
    mark("navigate");
    await router.navigate("/p?v=2", { loaders: [[DataLoader, next.promise]] });
    mark("resolve");
    await act(async () => next.resolve("two"));
    await settle();
    await show();
    dump("A4 streamed while hidden");
    expect(log.filter((l) => l.startsWith("commit hidden-fallback"))).toEqual(
      [],
    );
    expect(since("show")).toEqual([
      "commit hidden two",
      "render hidden two",
      "commit hidden two",
    ]);
  });

  it.each([false, true])(
    "data still streaming at the show (show in a transition: %s)",
    async (inTransition) => {
      const { router } = await open();
      await hide();
      const next = deferred<string>();
      mark("navigate");
      await router.navigate("/p?v=2", {
        loaders: [[DataLoader, next.promise]],
      });
      await show(inTransition);
      const atShow = since("show");
      mark("resolve");
      await act(async () => next.resolve("two"));
      await settle();
      dump(`A4 streaming at show ${inTransition}`);
      // The boundary inside the hidden part suspended offscreen, so the
      // show reveals its fallback, in a transition too: React does not hold
      // the content it had before the hide.
      expect(atShow).toEqual(["commit hidden-fallback loading"]);
      expect(since("resolve")).toContain("commit hidden two");
    },
  );

  it("a keyed reader shown after the navigation resets the family: a visible reader's refresh made while it was hidden is dropped", async () => {
    const { router } = await open(true);
    await hide();
    mark("navigate");
    await router.navigate("/p?v=2", { loaders: [[DataLoader, "two"]] });
    await settle();
    router.respondToLoads({ loaders: [[DataLoader, "two refreshed"]] });
    mark("refresh");
    fireEvent.click(document.querySelector('[data-testid="shown-refresh"]')!);
    await waitFor(() => expect(text("shown")).toBe("two refreshed"));
    await show();
    await settle();
    dump("A4 keyed refresh");
    // The shown reader's reset effect sees route data other than what it
    // last committed ("one") and clears every sticky bucket of the loader,
    // the visible reader's refresh with it.
    expect(since("show")).toEqual([
      "commit hidden two",
      "render hidden two",
      "commit hidden two",
      "render shown two",
      "render hidden two",
      "commit shown two",
      "commit hidden two",
    ]);
    expect(text("shown")).toBe("two");
  });
});

describe("A5: handles pushed and read inside a hidden <Activity>", () => {
  const Notes = createHandle<string, string[]>(
    (segments) => segments.flat(),
    "__hidden_activity_notes__",
  );

  function Pusher(): ReactNode {
    usePushHandle(Notes)("pushed");
    usePushHandle(Meta)({ title: "Pushed title" });
    return null;
  }
  function NotesReader({ name }: { name: string }): ReactNode {
    const notes = useHandle(Notes).join(",");
    useLogged(name, notes);
    return <p data-testid={name}>{notes}</p>;
  }
  /** document.title at each commit of the layout's subtree. */
  function TitleLog(): ReactNode {
    useLayoutEffect(() => {
      log.push(`title ${document.title}`);
    });
    return null;
  }
  function Layout(): ReactNode {
    return (
      <>
        <MetaTags />
        <TitleLog />
        <NotesReader name="shown" />
        <Hideable>
          <Pusher />
          <NotesReader name="hidden" />
        </Hideable>
        <Outlet />
      </>
    );
  }
  const open = () =>
    renderRoute(
      [
        { path: "/", Component: Layout },
        { path: "/p", Component: Leaf },
      ],
      {
        request: "/p?v=1",
        handles: [
          [Notes, ["server"], 0],
          [Meta, [{ title: "Server title" }], 0],
        ],
      },
    );

  it("a hide withdraws the hidden part's pushes in its commit; a show puts them back in its commit", async () => {
    const { router } = await open();
    expect(text("shown")).toBe("server,pushed");
    expect(document.title).toBe("Pushed title");

    await hide();
    dump("A5 hide");
    expect(text("shown")).toBe("server");
    expect(document.title).toBe("Server title");
    expect(router.handleData(Notes)).toEqual({ L0: ["server"] });

    await show();
    dump("A5 show");
    expect(since("show")).toEqual([
      "commit hidden server",
      "render shown server,pushed",
      "render hidden server,pushed",
      "commit shown server,pushed",
      "commit hidden server,pushed",
    ]);
    expect(document.title).toBe("Pushed title");
  });

  it("a navigation while hidden: the show restores the pushes over the new page's server values", async () => {
    const { router } = await open();
    await hide();
    mark("navigate");
    await router.navigate("/p?v=2", {
      handles: [
        [Notes, ["server two"], 0],
        [Meta, [{ title: "Server two" }], 0],
      ],
    });
    await settle();
    expect(text("shown")).toBe("server two");
    expect(document.title).toBe("Server two");
    await show();
    dump("A5 navigate");
    expect(since("show")).toEqual([
      "commit hidden server",
      "render shown server two,pushed",
      "render hidden server two,pushed",
      "commit shown server two,pushed",
      "commit hidden server two,pushed",
    ]);
    expect(document.title).toBe("Pushed title");
  });

  it("without act(): the show's task ends with the pushes on screen", async () => {
    function TaskReader({ name }: { name: string }): ReactNode {
      const notes = useHandle(Notes).join(",");
      useLogged(name, notes);
      useEndOfTask(name);
      return <p data-testid={name}>{notes}</p>;
    }
    function TaskLayout(): ReactNode {
      return (
        <>
          <button data-testid="show" onClick={() => setMode("visible")} />
          <TaskReader name="reader" />
          <Hideable>
            <Pusher />
            <TaskReader name="inner" />
          </Hideable>
          <Outlet />
        </>
      );
    }
    await renderRoute(
      [
        { path: "/", Component: TaskLayout },
        { path: "/p", Component: Leaf },
      ],
      { request: "/p", handles: [[Notes, ["server"], 0]] },
    );
    await hide();
    expect(text("reader")).toBe("server");
    mark("show");
    await withoutAct(clickShow);
    dump("A5 end of task");
    // The reader inside the shown part commits its pre-show value first;
    // its layout effect and the pusher's correct both readers before the
    // task ends.
    expect(since("show")).toEqual([
      "commit inner server",
      "render reader server,pushed",
      "render inner server,pushed",
      "commit reader server,pushed",
      "commit inner server,pushed",
      "end of task inner server,pushed",
      "end of task reader server,pushed",
      "end of task inner server,pushed",
    ]);
  });
});

describe("A6: a keyless refreshGroup read across a hide", () => {
  const GroupLoader = {
    __brand: "loader",
    $$id: "hidden-activity#GroupLoader",
  } as unknown as LoaderDefinition<string>;

  function Reader({
    keyed,
    task = false,
  }: {
    keyed: boolean;
    task?: boolean;
  }): ReactNode {
    const { data, load } = useLoader(GroupLoader, {
      refreshGroup: "live",
      ...(keyed && { key: "k" }),
    });
    useLogged("reader", data);
    useEndOfTask("reader", task);
    return (
      <>
        <p data-testid="reader">{data}</p>
        <button
          data-testid="refresh"
          onClick={() => void load().catch(() => {})}
        />
      </>
    );
  }

  /** The page opened with its read refreshed, then hidden. */
  async function refreshAndHide(keyed: boolean, task = false): Promise<void> {
    function Page(): ReactNode {
      return (
        <>
          <button data-testid="show" onClick={() => setMode("visible")} />
          <Hideable>
            <Reader keyed={keyed} task={task} />
          </Hideable>
        </>
      );
    }
    const { router } = await renderRoute([{ path: "/p", Component: Page }], {
      request: "/p",
      loaders: [[GroupLoader, "route data"]],
    });
    router.respondToLoads({ loaders: [[GroupLoader, "refreshed"]] });
    fireEvent.click(document.querySelector('[data-testid="refresh"]')!);
    await waitFor(() => expect(text("reader")).toBe("refreshed"));
    await hide();
  }

  it.each([
    { keyed: false, shown: "route data" },
    { keyed: true, shown: "refreshed" },
  ])("key: $keyed, shows again with $shown", async ({ keyed, shown }) => {
    await refreshAndHide(keyed);
    await show();
    await settle();
    dump(`A6 keyed=${keyed}`);
    expect(text("reader")).toBe(shown);
    expect(since("show")).toEqual(
      keyed
        ? ["commit reader refreshed"]
        : // The first visible commit draws the refresh, then the read falls
          // back to the route data.
          [
            "commit reader refreshed",
            "render reader route data",
            "commit reader route data",
          ],
    );
  });

  it("without act(), no key: the show's task ends with the refresh on screen", async () => {
    await refreshAndHide(false, true);
    mark("show");
    await withoutAct(clickShow);
    dump("A6 end of task");
    expect(since("show")).toEqual([
      "commit reader refreshed",
      "end of task reader refreshed",
      "render reader route data",
      "commit reader route data",
      "end of task reader route data",
    ]);
  });
});

describe("A7: the router's own client components under a hide and a show", () => {
  it("a viewport <Link> stops observing when hidden and observes again when shown, once", async () => {
    const observed = new Set<Element>();
    const calls: string[] = [];
    class StubObserver {
      observe(element: Element): void {
        calls.push("observe");
        observed.add(element);
      }
      unobserve(element: Element): void {
        calls.push("unobserve");
        observed.delete(element);
      }
      disconnect(): void {
        observed.clear();
      }
    }
    vi.stubGlobal("IntersectionObserver", StubObserver);
    resetPrefetchObserverForTesting();
    function Page(): ReactNode {
      return (
        <Hideable>
          <Link to="/target" prefetch="viewport">
            target
          </Link>
        </Hideable>
      );
    }
    await renderRoute([{ path: "/p", Component: Page }], { request: "/p" });
    for (let i = 0; i < 3; i++) {
      await hide();
      expect(observed.size).toBe(0);
      await show();
      expect(observed.size).toBe(1);
    }
    expect(calls).toEqual([
      "observe",
      ...Array.from({ length: 3 }, () => ["unobserve", "observe"]).flat(),
    ]);
    expect(errors).not.toHaveBeenCalled();
    resetPrefetchObserverForTesting();
  });

  it("<ScrollRestoration> inside the hidden part tears scroll restoration down on hide and starts it again on show", async () => {
    function Page(): ReactNode {
      return (
        <Hideable>
          <ScrollRestoration />
        </Hideable>
      );
    }
    await renderRoute([{ path: "/p", Component: Page }], { request: "/p" });
    expect(window.history.scrollRestoration).toBe("manual");
    window.scrollTo(0, 120);
    saveCurrentScrollPosition();
    expect(getSavedScrollPosition()).toBe(120);
    await hide();
    expect(window.history.scrollRestoration).toBe("auto");
    await show();
    expect(window.history.scrollRestoration).toBe("manual");
    // The teardown dropped the positions saved in this document; the restart
    // reads only what a pagehide persisted.
    expect(getSavedScrollPosition()).toBeUndefined();
    window.scrollTo(0, 0);
    expect(warnings).not.toHaveBeenCalledWith("[Scroll] Already initialized");
    expect(errors).not.toHaveBeenCalled();
  });

  it("useMount reads the same mount hidden and shown, with no extra commit", async () => {
    function MountProbe(): ReactNode {
      const mount = useMount();
      useLogged("mount", mount);
      useEffect(() => {
        log.push("effect mount");
        return () => {
          log.push("cleanup mount");
        };
      }, []);
      return null;
    }
    function Page(): ReactNode {
      return (
        <Hideable>
          <MountProbe />
        </Hideable>
      );
    }
    await renderRoute([{ path: "/p", Component: Page }], {
      request: "/p",
      mount: "/shop",
    });
    await hide();
    await show();
    dump("A7 useMount");
    expect(between("hide", "show")).toEqual(["cleanup mount"]);
    expect(since("show")).toEqual(["commit mount /shop", "effect mount"]);
    expect(errors).not.toHaveBeenCalled();
  });
});
