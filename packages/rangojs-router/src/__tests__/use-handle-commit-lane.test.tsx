// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  memo,
  Profiler,
  Suspense,
  use,
  useEffect,
  useLayoutEffect,
  useState,
  ViewTransition,
  type ReactNode,
} from "react";
import { createHandle } from "../handle.js";
import {
  createEventController,
  type EventController,
} from "../browser/event-controller.js";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "../browser/react/context.js";
import { useHandle } from "../browser/react/use-handle.js";
import { useSegments } from "../browser/react/use-segments.js";
import { commitInTransition } from "../browser/partial-update.js";
import { LoaderStore } from "../loader-store.js";
import type { NavigationUpdate } from "../browser/types.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

/**
 * A navigation's handle values commit with its page, never over the page
 * being left. NavigationProvider's update subscriber flushes the controller
 * inside the payload update. For a page in a transition it sends "anchor"
 * (flushRouteState("anchor")): from there a new value waits for that page,
 * and the provider's layout effect releases it in the commit's task
 * (releaseRouteState). For an urgent page it sends "release": a value set
 * before React renders the page is set at default priority, in the page's
 * lane, and the page's effects read it. useHandle starts no transition of
 * its own, so it never commits ahead of a held page or takes its transition
 * types (#1165), and a reader whose value did not move does not render.
 *
 * useSegments() waits the same way: a handle notification moves its route
 * segment ids.
 *
 * The title reader sits outside the page's <Suspense> (and its
 * <ViewTransition>), as MetaTags does. A <Profiler> logs what each commit
 * shows, "<title>|<page>", with the segment ids and a task stamp. Each page
 * logs the title its mount effect reads, as an analytics page view does.
 */

interface Crumb {
  label: string;
  content?: Promise<string>;
}

const Crumbs = createHandle<Crumb, Crumb[]>(
  (segments) => segments.flat(),
  "__test_commit_lane_crumbs__",
);

const MATCHED = ["R0"];
const crumbs = (...items: Crumb[]) => ({ [Crumbs.$$id]: { R0: items } });

let controller: EventController;
let loaders: LoaderStore;
let log: { shown: string; segments: string; task: number }[];
let task: number;
let ticking: ReturnType<typeof setTimeout> | undefined;
let setTree!: (tree: ReactNode) => void;
let effects: string[];
let stub: ReturnType<typeof installViewTransitionStub> | undefined;

const text = (id: string): string =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

let titleRenders: number;

// Memoized: it renders for its own state only, not for Shell's tree.
const Title = memo(function Title(): ReactNode {
  titleRenders++;
  const label = useHandle(Crumbs, (items) => items.at(-1)?.label ?? "");
  return <p data-testid="title">{label}</p>;
});

function CrumbContent({ content }: { content: Promise<string> }): ReactNode {
  return <span data-testid="content">{use(content)}</span>;
}

/** The last crumb's content, in a boundary every crumb shares. */
function Trail(): ReactNode {
  const last = useHandle(Crumbs).at(-1);
  return last?.content ? (
    <Suspense fallback={<span data-testid="content-fallback" />}>
      <CrumbContent content={last.content} />
    </Suspense>
  ) : null;
}

function Segments(): ReactNode {
  return <p data-testid="segments">{useSegments().segmentIds.join(",")}</p>;
}

function Page({ id }: { id: string }): ReactNode {
  const label = useHandle(Crumbs, (items) => items.at(-1)?.label ?? "");
  useEffect(() => {
    effects.push(`${id}:${label}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return <p data-testid="page">{id}</p>;
}

function Hold({ until }: { until: Promise<void> }): ReactNode {
  use(until);
  return null;
}

/** The tree NavigationProvider's update handed React, until it commits. */
let committing: ReactNode;

function Shell({ vt }: { vt: boolean }): ReactNode {
  const [tree, set] = useState<ReactNode>(<Page id="1" />);
  setTree = set;
  // NavigationProvider's layout effect: route state that waited for this
  // tree is released in its commit.
  useLayoutEffect(() => {
    if (tree === committing) {
      committing = undefined;
      controller.releaseRouteState();
    }
  });
  const content = (
    <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
      {tree}
    </Suspense>
  );
  return (
    <Profiler
      id="app"
      onRender={() => {
        log.push({
          shown: `${text("title")}|${text("page")}`,
          segments: text("segments"),
          task,
        });
      }}
    >
      <Title />
      <Segments />
      <Trail />
      {vt ? <ViewTransition>{content}</ViewTransition> : content}
    </Profiler>
  );
}

function mount(vt: boolean) {
  const value = {
    eventController: controller,
  } as NavigationStoreContextValue;
  return render(
    <NavigationStoreContext.Provider value={value}>
      <Shell vt={vt} />
    </NavigationStoreContext.Provider>,
  );
}

/** The controller's debounced handle notification (event-controller.ts). */
async function notified(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * NavigationProvider's update subscriber: the tree, the flush with "anchor"
 * for a page in a transition (route state now waits for this tree) or
 * "release" for an urgent one, then the handle data the payload carries
 * (`sync`, a history-cache page's pushes) and a plain flush. Shell's layout
 * effect releases it, as the provider's does.
 */
function subscriber(sync?: ReturnType<typeof crumbs>) {
  return (next: NavigationUpdate): void => {
    committing = next.root as ReactNode;
    setTree(committing);
    controller.flushRouteState(next.inTransition ? "anchor" : "release");
    if (sync) controller.setHandleData(sync, MATCHED);
    controller.flushRouteState();
  };
}

/** Page 2's commit through production's commitInTransition. */
async function navigate(
  until: Promise<void>,
  vt: boolean,
  sync?: ReturnType<typeof crumbs>,
): Promise<void> {
  await act(async () => {
    const update = {
      root: (
        <>
          <Page id="2" />
          <Hold until={until} />
        </>
      ),
      metadata: {},
    } as unknown as NavigationUpdate;
    commitInTransition(
      loaders,
      subscriber(sync),
      [],
      update,
      "push",
      vt ? ["navigation"] : [],
    );
  });
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function release(hold: {
  promise: Promise<void>;
  resolve: () => void;
}): Promise<void> {
  await act(async () => {
    hold.resolve();
    await hold.promise;
  });
  await waitFor(() => expect(text("page")).toBe("2"));
}

/** The commit that showed `shown` first. */
function first(shown: string): (typeof log)[number] | undefined {
  return log.find((entry) => entry.shown === shown);
}

/** The task of the commit that showed page 2 first. */
function pageTask(): number | undefined {
  return log.find((entry) => entry.shown.endsWith("|2"))?.task;
}

function settled<T>(value: T): Promise<T> {
  const promise = Promise.resolve(value) as Promise<T> & {
    status: string;
    value: T;
  };
  promise.status = "fulfilled";
  promise.value = value;
  return promise;
}

beforeEach(() => {
  log = [];
  effects = [];
  titleRenders = 0;
  stub = undefined;
  loaders = new LoaderStore();
  controller = createEventController({
    initialLocation: new URL("http://localhost/one"),
  });
  controller.setHandleData(crumbs({ label: "one" }), MATCHED);
  // A task stamp: two commits with one stamp landed in the same task.
  task = 0;
  const tick = () => {
    task++;
    ticking = setTimeout(tick, 0);
  };
  tick();
});

afterEach(() => {
  clearTimeout(ticking);
  cleanup();
  stub?.uninstall();
});

describe.each([
  { variant: "without view transition", vt: false },
  { variant: "with view transition", vt: true },
] as const)("useHandle commits with the page ($variant)", ({ vt }) => {
  beforeEach(() => {
    if (vt) stub = installViewTransitionStub();
  });

  it("values the payload carries land in the page's task, never before it", async () => {
    mount(vt);
    const hold = deferred();

    await navigate(hold.promise, vt, crumbs({ label: "two" }));
    await notified();
    // React holds page 2: the page being left keeps its title.
    expect(text("title")).toBe("one");
    expect(text("page")).toBe("1");

    await release(hold);
    expect(first("two|1")).toBeUndefined();
    expect(first("two|2")!.task).toBe(pageTask());
    if (vt) expect(stub!.types()).toEqual([["push", "navigation"]]);
  });

  it("a value that arrives while the page is held is applied with the page commit, in its task", async () => {
    mount(vt);
    const hold = deferred();

    await navigate(hold.promise, vt);
    await act(async () => {
      controller.setHandleData(crumbs({ label: "two" }), MATCHED);
    });
    await notified();
    await notified();
    expect(text("title")).toBe("one");
    expect(text("page")).toBe("1");

    await release(hold);
    expect(text("title")).toBe("two");
    expect(first("two|1")).toBeUndefined();
    expect(first("two|2")!.task).toBe(pageTask());
    // The value took no transition of its own: the page's view transition
    // carries the navigation's types.
    if (vt) expect(stub!.types()).toEqual([["push", "navigation"]]);
  });

  it("a value whose content suspends in an already revealed boundary does not hold the page", async () => {
    controller.setHandleData(
      crumbs({ label: "one", content: settled("stock 1") }),
      MATCHED,
    );
    mount(vt);
    expect(text("content")).toBe("stock 1");
    const hold = deferred();
    const stock2 = deferred<string>();

    await navigate(hold.promise, vt);
    await act(async () => {
      controller.setHandleData(
        crumbs({ label: "two", content: stock2.promise }),
        MATCHED,
      );
    });
    await notified();

    // Only the page's own hold is released: the crumb content stays pending.
    await release(hold);
    expect(text("title")).toBe("two");
    expect(first("two|1")).toBeUndefined();

    await act(async () => {
      stock2.resolve("stock 2");
      await stock2.promise;
    });
    await waitFor(() => expect(text("content")).toBe("stock 2"));
  });

  it("useSegments: route segments that arrive while the page is held commit with it", async () => {
    mount(vt);
    expect(text("segments")).toBe("R0");
    const hold = deferred();

    await navigate(hold.promise, vt);
    await act(async () => {
      controller.setHandleData(crumbs({ label: "two" }), ["R1"]);
    });
    await notified();
    await notified();
    expect(text("segments")).toBe("R0");

    await release(hold);
    expect(text("segments")).toBe("R1");
    expect(
      log.filter(
        (entry) => entry.segments === "R1" && entry.shown.endsWith("|1"),
      ),
    ).toEqual([]);
    if (vt) expect(stub!.types()).toEqual([["push", "navigation"]]);
  });

  it("a reader whose value does not move does not render for the navigation", async () => {
    mount(vt);
    const hold = deferred();
    const before = titleRenders;

    await navigate(hold.promise, vt, crumbs({ label: "one" }));
    await notified();
    await release(hold);
    await notified();
    expect(text("title")).toBe("one");
    expect(titleRenders).toBe(before);
  });

  it("a value that arrives after the page committed is applied at once", async () => {
    mount(vt);
    const hold = deferred();
    await navigate(hold.promise, vt);
    await release(hold);
    await notified();

    await act(async () => {
      controller.setHandleData(crumbs({ label: "late" }), MATCHED);
    });
    await notified();
    expect(text("title")).toBe("late");
    expect(text("page")).toBe("2");
  });
});

describe("useHandle commits with an urgent page", () => {
  it("a value set before React renders the page commits with it, and the page's effects read it", async () => {
    mount(false);
    await act(async () => {
      subscriber()({
        root: <Page id="2" />,
        metadata: {},
      } as unknown as NavigationUpdate);
      controller.setHandleData(crumbs({ label: "two" }), MATCHED);
      // The controller's debounced notification, before React renders.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(text("page")).toBe("2"));
    expect(first("two|1")).toBeUndefined();
    expect(first("one|2")).toBeUndefined();
    expect(effects).toEqual(["1:one", "2:two"]);
  });
});

describe("useHandle commits with the page (a value between the page's render and its view transition's update)", () => {
  beforeEach(() => {
    stub = installViewTransitionStub();
  });

  it("is applied in the task that commits the page", async () => {
    mount(true);
    const hold = deferred();
    await navigate(hold.promise, true);
    // When React starts the page's view transition it has rendered page 2;
    // the update callback (the mutation) runs a task later.
    const doc = document as unknown as {
      startViewTransition: (options: unknown) => unknown;
    };
    const start = doc.startViewTransition;
    let shownAtStart: string | undefined;
    doc.startViewTransition = (options) => {
      shownAtStart = `${text("title")}|${text("page")}`;
      controller.setHandleData(crumbs({ label: "two" }), MATCHED);
      controller.flushRouteState();
      return start(options);
    };

    await act(async () => {
      hold.resolve();
      await hold.promise;
    });
    await waitFor(() => expect(text("page")).toBe("2"));
    expect(shownAtStart).toBe("one|1");
    expect(text("title")).toBe("two");
    expect(first("two|1")).toBeUndefined();
    expect(first("two|2")!.task).toBe(pageTask());
    expect(stub!.types()).toEqual([["push", "navigation"]]);
  });
});
