// @vitest-environment happy-dom
import { Suspense, use, useContext, useEffect, type ReactNode } from "react";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventController } from "../../browser/event-controller.js";
import { createNavigationTransaction } from "../../browser/navigation-transaction.js";
import { createPartialUpdater } from "../../browser/partial-update.js";
import { cancelPendingFill } from "../../browser/pending-fill.js";
import { NavigationStoreContext } from "../../browser/react/context.js";
import { consumeHandles } from "../../browser/react/NavigationProvider.js";
import { useNavigation } from "../../browser/react/use-navigation.js";
import type { NavigationUpdate } from "../../browser/types.js";
import type { ResolvedSegment } from "../../types.js";
import { renderRoute } from "../render-route.js";

// A click that adopts a payload with deferred segments (`prefetch: false`),
// through the real provider and the real event controller: what
// useNavigation() reads while React holds the click's tree, and how many
// trees the click and its fill hand React (one: the fill resolves what that
// tree is waiting for, browser/partial-update.ts settleHoles).

afterEach(() => {
  cancelPendingFill();
  cleanup();
});

let controller: EventController;

function Nav(): ReactNode {
  controller = useContext(NavigationStoreContext)!.eventController;
  const nav = useNavigation();
  return <i data-testid="nav">{`${nav.state}/${nav.isStreaming}`}</i>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount() {
  const { router, getByTestId } = await renderRoute(
    [{ path: "/", Component: () => <p data-testid="page">home</p> }],
    { request: "/" },
  );
  const update = (page: ReactNode): NavigationUpdate => ({
    // <Nav> keeps its place in every root: one instance reads throughout.
    root: (
      <>
        <Nav key="nav" />
        {page}
      </>
    ),
    metadata: { pathname: "/", segments: [] },
  });
  const emit = (u: NavigationUpdate) => router.store.emitUpdate(u);
  await act(async () => emit(update(<p data-testid="page">home</p>)));
  return {
    emit,
    update,
    nav: (): string | null => getByTestId("nav").textContent,
    shown: (): string | null => getByTestId("page").textContent,
  };
}

// The click commits in its own task, before the notification of the click
// has gone out (the controller's notifier is debounced), and React holds the
// commit where a hole is read with no boundary. So the updater delivers the
// navigation state first (PartialUpdateConfig.fill.flush): React commits
// `loading` in the microtask after it, and the tree's update arrives later,
// after the render's awaits. Two act() scopes stand for those two flushes.
describe("useNavigation() while React holds a tree that waits for its fill", () => {
  /** The click up to the delivery of its state. */
  async function clickAndFlush() {
    let handle!: ReturnType<EventController["startNavigation"]>;
    await act(async () => {
      handle = controller.startNavigation("http://localhost/next");
      controller.flushRouteState();
    });
    return handle;
  }

  /** The commit: the stream of the fill stays open. */
  function commit(handle: ReturnType<EventController["startNavigation"]>) {
    const fill = handle.startStreaming();
    handle.complete(new URL("http://localhost/next"));
    return fill;
  }

  it("reads loading until React commits the tree, then what the commit set", async () => {
    const { emit, update, nav, shown } = await mount();
    expect(nav()).toBe("idle/false");
    const gate = deferred<string>();
    // No boundary to fall back to: React holds the update.
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    const handle = await clickAndFlush();
    expect(nav()).toBe("loading/true");
    let fill!: { end: () => void };
    await act(async () => {
      fill = commit(handle);
      emit(update(<Held />));
    });
    expect(shown(), "React holds the page being left").toBe("home");
    expect(nav()).toBe("loading/true");

    await act(async () => gate.resolve("filled"));
    expect(shown()).toBe("filled");
    expect(nav(), "the fill is still streaming").toBe("idle/true");

    await act(async () => {
      fill.end();
      await tick();
    });
    expect(nav()).toBe("idle/false");
  });

  it("reads loading for no longer than the commit takes when a fallback can show", async () => {
    const { emit, update, nav, shown } = await mount();

    const handle = await clickAndFlush();
    let fill!: { end: () => void };
    await act(async () => {
      fill = commit(handle);
      emit(update(<p data-testid="page">fallback</p>));
    });
    expect(shown()).toBe("fallback");
    expect(nav()).toBe("idle/true");
    fill.end();
  });

  // The control: the state reaches React with the tree's update, in the
  // batch React holds. `loading` was never on screen.
  it("reads idle all the while when the state is not delivered first", async () => {
    const { emit, update, nav, shown } = await mount();
    const gate = deferred<string>();
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    let fill!: { end: () => void };
    await act(async () => {
      fill = commit(controller.startNavigation("http://localhost/next"));
      emit(update(<Held />));
    });
    expect(shown()).toBe("home");
    expect(nav()).toBe("idle/false");

    await act(async () => gate.resolve("filled"));
    expect(nav()).toBe("idle/true");
    fill.end();
  });
});

// The real updater, a real transaction and renderRoute's provider: a click
// that adopts a prefetch with deferred segments, and its fill. Every update
// that reaches the provider is counted.
describe("a click that adopts a prefetch, and its fill", () => {
  const UNIT = "U";
  const ROUTE = "UR";
  const DATA = "UD0.data";

  const mounts = { fallback: 0 };
  beforeEach(() => {
    mounts.fallback = 0;
  });

  function Fallback(): ReactNode {
    useEffect(() => {
      mounts.fallback++;
    }, []);
    return <p data-testid="page">skeleton</p>;
  }

  const segment = (
    id: string,
    type: "layout" | "route" | "loader" | "parallel",
    extra: Partial<ResolvedSegment>,
  ): ResolvedSegment =>
    ({
      id,
      namespace: id,
      type,
      index: 0,
      component: null,
      params: {},
      ...extra,
    }) as unknown as ResolvedSegment;

  /**
   * `adopted` is the prefetched payload's segments, `filled` what the fill
   * answers with, `stream` how long the fill's response stays open. The tree
   * is whatever `render` makes of the segments on the page. `plain`: the
   * click with no prefetch, answered with the `filled` segments in one
   * response.
   */
  async function adopt(options: {
    adopted: ResolvedSegment[];
    filled: ResolvedSegment[];
    stream?: Promise<void>;
    plain?: boolean;
    render: (find: (id: string) => ResolvedSegment) => ReactNode;
  }) {
    const { router, getByTestId } = await renderRoute(
      [{ path: "/", Component: () => <p data-testid="page">home</p> }],
      { request: "/" },
    );
    const held = router.store.getSegmentState().currentSegmentIds;
    const added = options.adopted.map((s) => s.id);
    const payload = (segments: ResolvedSegment[]) => ({
      metadata: {
        isPartial: true,
        pathname: "/",
        matched: [...held, ...added],
        diff: added,
        segments,
      },
    });
    const answer = deferred<void>();
    let updates = 0;
    const updater = createPartialUpdater({
      store: router.store,
      client: {
        fetchPartial: async (request: { fill?: boolean }) => {
          if (!request.fill) {
            return {
              payload: payload(
                options.plain ? options.filled : options.adopted,
              ),
              streamComplete: Promise.resolve(),
              fullyPrefetched: !options.plain,
            };
          }
          await answer.promise;
          return {
            payload: payload(options.filled),
            streamComplete: options.stream ?? Promise.resolve(),
          };
        },
      } as any,
      onUpdate: (update) => {
        updates++;
        router.store.emitUpdate(update);
      },
      renderSegments: (segments) =>
        options.render((id) => segments.find((s) => s.id === id)!),
      // As the navigation bridge supplies them.
      fill: {
        redirect: () => {},
        locationState: () => {},
        handles: (metadata) => {
          if (metadata.handles) {
            consumeHandles(metadata, router.eventController, router.store);
          }
        },
        flush: router.eventController.flushRouteState,
      },
    });
    const here = window.location.href;
    const tx = createNavigationTransaction(
      router.store,
      router.eventController,
      here,
      { replace: true },
    );
    const navigation = updater(
      here,
      [],
      false,
      tx.handle.signal,
      tx.with({ url: here, replace: true }),
    ).finally(() => tx[Symbol.dispose]());
    // A click that waits for its fill is still pending after this.
    await act(async () => {
      await Promise.race([navigation, tick()]);
    });
    return {
      navigation,
      updates: (): number => updates,
      shown: (): string | null => getByTestId("page").textContent,
      /** The fill answers; `ms` later the page is read. */
      fill: (ms: number) =>
        act(async () => {
          answer.resolve();
          await new Promise((resolve) => setTimeout(resolve, ms));
        }),
    };
  }

  const read = (value: unknown): ReactNode =>
    (value instanceof Promise ? use(value) : value) as ReactNode;

  function Unit({ content }: { content: unknown }) {
    return <p data-testid="page">{read(content)}</p>;
  }

  const unit = (extra: Partial<ResolvedSegment> = {}) => ({
    adopted: segment(UNIT, "route", {
      loading: "skeleton",
      deferred: true,
      ...extra,
    }),
    filled: segment(UNIT, "route", {
      loading: "skeleton",
      component: "content",
      ...extra,
    }),
  });

  it("shows a unit's fallback with the click and its content when the fill answers: one update, the fallback mounted once", async () => {
    const { adopted, filled } = unit();
    const { shown, fill, updates } = await adopt({
      adopted: [adopted],
      filled: [filled],
      render: (find) => (
        <Suspense fallback={<Fallback />}>
          <Unit content={find(UNIT).component} />
        </Suspense>
      ),
    });
    expect(shown()).toBe("skeleton");
    expect(updates()).toBe(1);

    await fill(500);
    expect(shown()).toBe("content");
    expect(updates(), "the fill handed React nothing").toBe(1);
    expect(mounts.fallback).toBe(1);
  });

  // A flagged layout: the route below it is a hole of the same tree, read
  // by the content the layout's gate resolves with.
  it("fills a layout unit and the route below it in the tree the click built", async () => {
    function Section({ find }: { find: (id: string) => ResolvedSegment }) {
      return (
        <section>
          {read(find(UNIT).component)}
          <Unit content={find(ROUTE).component} />
        </section>
      );
    }
    const { shown, fill, updates } = await adopt({
      adopted: [
        segment(UNIT, "layout", { loading: "skeleton", deferred: true }),
        segment(ROUTE, "route", { deferred: true }),
      ],
      filled: [
        segment(UNIT, "layout", { loading: "skeleton", component: "layout " }),
        segment(ROUTE, "route", { component: "content" }),
      ],
      render: (find) => (
        <Suspense fallback={<Fallback />}>
          <Section find={find} />
        </Suspense>
      ),
    });
    expect(shown()).toBe("skeleton");

    await fill(500);
    expect(shown()).toBe("content");
    expect(updates()).toBe(1);
    expect(mounts.fallback).toBe(1);
  });

  // A layout above the unit reads the route's loader, with no boundary: the
  // read is above the unit's fallback, so React holds the click on that
  // loader's gate. Every gate resolves when the fill answers, the unit's
  // included. Whether the commit that ends the hold shows the page or the
  // unit's fallback first is React's (it has read the unit's gate where it
  // rendered past the suspended read): the browser suite compares that with
  // a plain click (tests/shared-e2e, the `above` parity cases).
  it("commits a unit whose own loader is read above its fallback", async () => {
    function Above({ find }: { find: (id: string) => ResolvedSegment }) {
      return (
        <div>
          <i>{read(find(DATA).loaderData)}</i>
          <Suspense fallback={<Fallback />}>
            <Unit content={find(UNIT).component} />
          </Suspense>
        </div>
      );
    }
    const { adopted, filled } = unit();
    const { shown, fill, updates } = await adopt({
      adopted: [
        adopted,
        segment(DATA, "loader", { loaderId: "data", deferred: true }),
      ],
      filled: [
        filled,
        segment(DATA, "loader", { loaderId: "data", loaderData: "value" }),
      ],
      render: (find) => <Above find={find} />,
    });
    expect(shown(), "React holds the page being left").toBe("home");

    await fill(500);
    expect(shown()).toBe("content");
    expect(updates()).toBe(1);
  });

  // A read with no boundary, in a response that stays open behind it: no
  // fallback is on screen, so there is nothing to keep up for 300 ms.
  it("shows a held page as its value arrives, however long the response stays open", async () => {
    function Bare({ data }: { data: unknown }) {
      return <p data-testid="page">{read(data)}</p>;
    }
    const { shown, fill, updates } = await adopt({
      adopted: [segment(DATA, "loader", { loaderId: "data", deferred: true })],
      filled: [
        segment(DATA, "loader", { loaderId: "data", loaderData: "value" }),
      ],
      stream: new Promise<void>(() => {}),
      render: (find) => <Bare data={find(DATA)?.loaderData} />,
    });
    expect(shown(), "React holds the page being left").toBe("home");

    await fill(100);
    expect(shown()).toBe("value");
    expect(updates()).toBe(1);
  });

  // A unit on a page that commits in a transition: the click is a
  // navigation that waits for its fill. Nothing reaches React with the
  // click, and the page commits once, with the fill's first chunk.
  it("hands React nothing for a unit under transition() until its fill answers, then one update with the content", async () => {
    const { adopted, filled } = unit({
      transition: {} as ResolvedSegment["transition"],
    });
    const { shown, fill, updates, navigation } = await adopt({
      adopted: [adopted],
      filled: [filled],
      render: (find) => (
        <Suspense fallback={<Fallback />}>
          <Unit content={find(UNIT).component} />
        </Suspense>
      ),
    });
    expect(shown()).toBe("home");
    expect(updates()).toBe(0);

    await fill(50);
    await navigation;
    expect(shown()).toBe("content");
    expect(updates()).toBe(1);
    expect(mounts.fallback).toBe(0);
  });

  // The count the model stands on. An update that hands React a tree belongs
  // to a navigation or an action: the adopted click makes one, as the plain
  // click to the same page does, and its fill makes none.
  describe("hands React one tree, as the plain click to the same page does", () => {
    const LATE = "UD1.late";
    const SLOT = "U.@side";
    type Find = (id: string) => ResolvedSegment;

    const loader = (id: string, value?: string): ResolvedSegment =>
      segment(
        id,
        "loader",
        value === undefined
          ? { loaderId: id, deferred: true }
          : { loaderId: id, loaderData: value },
      );
    const Read = ({ value }: { value: unknown }): ReactNode => read(value);
    const Page = ({ children }: { children: ReactNode }): ReactNode => (
      <p data-testid="page">{children}</p>
    );
    const underTransition = unit({
      transition: {} as ResolvedSegment["transition"],
    });

    const pages: Array<
      [
        string,
        {
          adopted: ResolvedSegment[];
          filled: ResolvedSegment[];
          render: (find: Find) => ReactNode;
          ends: string;
        },
      ]
    > = [
      [
        "a loader read behind its own boundary",
        {
          adopted: [loader(DATA)],
          filled: [loader(DATA, "value")],
          render: (find) => (
            <Page>
              <Suspense fallback="waiting">
                <Read value={find(DATA).loaderData} />
              </Suspense>
            </Page>
          ),
          ends: "value",
        },
      ],
      [
        "a route unit",
        {
          adopted: [unit().adopted],
          filled: [unit().filled],
          render: (find) => (
            <Suspense fallback={<Fallback />}>
              <Unit content={find(UNIT).component} />
            </Suspense>
          ),
          ends: "content",
        },
      ],
      [
        "a layout unit and the route below it",
        {
          adopted: [
            segment(UNIT, "layout", { loading: "skeleton", deferred: true }),
            segment(ROUTE, "route", { deferred: true }),
          ],
          filled: [
            segment(UNIT, "layout", { loading: "skeleton", component: "in " }),
            segment(ROUTE, "route", { component: "content" }),
          ],
          render: (find) => (
            <Page>
              <Suspense fallback="skeleton">
                <Read value={find(UNIT).component} />
                <Read value={find(ROUTE).component} />
              </Suspense>
            </Page>
          ),
          ends: "in content",
        },
      ],
      [
        "two loaders read in nested boundaries",
        {
          adopted: [loader(DATA), loader(LATE)],
          filled: [loader(DATA, "early "), loader(LATE, "late")],
          render: (find) => (
            <Page>
              <Suspense fallback="outer">
                <Read value={find(DATA).loaderData} />
                <Suspense fallback="inner">
                  <Read value={find(LATE).loaderData} />
                </Suspense>
              </Suspense>
            </Page>
          ),
          ends: "early late",
        },
      ],
      [
        "a unit whose loader is read above its fallback",
        {
          adopted: [unit().adopted, loader(DATA)],
          filled: [unit().filled, loader(DATA, "value")],
          render: (find) => (
            <Page>
              <Read value={find(DATA).loaderData} />
              <Suspense fallback=" skeleton">
                {" "}
                <Read value={find(UNIT).component} />
              </Suspense>
            </Page>
          ),
          ends: "value content",
        },
      ],
      [
        "a slot unit and its loader, beside a route the prefetch rendered",
        {
          adopted: [
            segment(SLOT, "parallel", {
              slot: "@side",
              loading: "skeleton",
              deferred: true,
            }),
            loader(DATA),
          ],
          filled: [
            segment(SLOT, "parallel", {
              slot: "@side",
              loading: "skeleton",
              component: "side ",
            }),
            loader(DATA, "value"),
          ],
          render: (find) => (
            <Page>
              route{" "}
              <Suspense fallback="skeleton">
                <Read value={find(SLOT).component} />
                <Read value={find(DATA).loaderData} />
              </Suspense>
            </Page>
          ),
          ends: "route side value",
        },
      ],
      [
        "a read with no boundary",
        {
          adopted: [loader(DATA)],
          filled: [loader(DATA, "value")],
          render: (find) => (
            <Page>
              <Read value={find(DATA).loaderData} />
            </Page>
          ),
          ends: "value",
        },
      ],
      [
        "a unit under transition()",
        {
          adopted: [underTransition.adopted],
          filled: [underTransition.filled],
          render: (find) => (
            <Suspense fallback={<Fallback />}>
              <Unit content={find(UNIT).component} />
            </Suspense>
          ),
          ends: "content",
        },
      ],
    ];

    it.each(pages)("%s", async (_name, page) => {
      const adopted = await adopt(page);
      await adopted.fill(500);
      await adopted.navigation;
      expect(adopted.shown()).toBe(page.ends);
      expect(adopted.updates(), "the adopted click and its fill").toBe(1);

      cancelPendingFill();
      cleanup();
      const plain = await adopt({ ...page, plain: true });
      await plain.navigation;
      expect(plain.shown()).toBe(page.ends);
      expect(plain.updates(), "the plain click").toBe(1);
    });
  });
});
