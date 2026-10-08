// @vitest-environment happy-dom
import {
  startTransition,
  Suspense,
  use,
  useContext,
  type ReactNode,
} from "react";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EventController } from "../../browser/event-controller.js";
import { createNavigationTransaction } from "../../browser/navigation-transaction.js";
import { createPartialUpdater } from "../../browser/partial-update.js";
import { cancelPendingFill, emitAdoption } from "../../browser/pending-fill.js";
import {
  LocationStateContext,
  NavigationStoreContext,
} from "../../browser/react/context.js";
import { useNavigation } from "../../browser/react/use-navigation.js";
import type { NavigationUpdate } from "../../browser/types.js";
import type { ResolvedSegment } from "../../types.js";
import { renderRoute } from "../render-route.js";

// What useNavigation() reads while React holds the update of an adopted
// prefetch that waits for its fill (`prefetch: false`), through the real
// provider and the real event controller. The adoption commits in the task
// of the click: `loading` was never rendered, and the state after the commit
// reaches React inside the update's transition. Where nothing can show a
// fallback React holds that transition until the fill returns
// (browser/pending-fill.ts emitAdoption).

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

/**
 * The click of an adopted prefetch, up to its commit: the controller goes
 * through `loading` and back in one task, with a stream still open (the
 * fill). Nothing has been delivered to React when this returns.
 */
function clickAndCommit(): { end: () => void } {
  const handle = controller.startNavigation("http://localhost/next");
  const fill = handle.startStreaming();
  handle.complete(new URL("http://localhost/next"));
  return fill;
}

describe("useNavigation() while React holds an adoption that waits for a fill", () => {
  it("reads loading until the update commits, then what the commit set", async () => {
    const { emit, update, nav, shown } = await mount();
    expect(nav()).toBe("idle/false");
    const gate = deferred<string>();
    // No boundary to fall back to: React holds the transition.
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    let fill!: { end: () => void };
    await act(async () => {
      fill = clickAndCommit();
      startTransition(() => emitAdoption(() => emit(update(<Held />))));
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

    let fill!: { end: () => void };
    await act(async () => {
      fill = clickAndCommit();
      startTransition(() =>
        emitAdoption(() => emit(update(<p data-testid="page">fallback</p>))),
      );
    });
    expect(shown()).toBe("fallback");
    expect(nav()).toBe("idle/true");
    fill.end();
  });

  // The control: the same update handed over as any other one is.
  it("reads idle all the while without emitAdoption", async () => {
    const { emit, update, nav, shown } = await mount();
    const gate = deferred<string>();
    function Held() {
      return <p data-testid="page">{use(gate.promise)}</p>;
    }

    let fill!: { end: () => void };
    await act(async () => {
      fill = clickAndCommit();
      startTransition(() => emit(update(<Held />)));
    });
    expect(shown()).toBe("home");
    expect(nav()).toBe("idle/false");

    await act(async () => gate.resolve("filled"));
    expect(nav()).toBe("idle/true");
    fill.end();
  });

  // A deferred unit on a page that commits in a transition: the adoption's
  // update carries a promise nobody resolves, and its fill hands the tree
  // over with its first chunk, in a transition of its own
  // (browser/partial-update.ts Fill.held). Two transition updates of one
  // state: React commits them as one, so the page commits once, as a plain
  // click commits it with its response, and the location state the fill
  // carries is there in the content's first render.
  it("holds an update whose root is a promise until the fill's update takes the page, in one commit", async () => {
    const { emit, update, nav, shown } = await mount();
    const commits: string[] = [];
    const states: unknown[] = [];
    function State(): ReactNode {
      states.push(useContext(LocationStateContext)?.state);
      return null;
    }

    let fill!: { end: () => void };
    await act(async () => {
      fill = clickAndCommit();
      startTransition(() =>
        emitAdoption(() =>
          emit({
            ...update(null),
            root: new Promise<ReactNode>(() => {}),
            onCommit: () => commits.push("adoption"),
          }),
        ),
      );
    });
    expect(shown(), "React holds the page being left").toBe("home");
    expect(nav()).toBe("loading/true");
    expect(commits).toEqual([]);

    await act(async () => {
      controller.commitLocationState({ state: "from the fill" });
      startTransition(() =>
        emit({
          ...update(
            <>
              <State key="state" />
              <p data-testid="page">landed</p>
            </>,
          ),
          onCommit: () => commits.push("fill"),
        }),
      );
    });
    expect(shown()).toBe("landed");
    expect(nav(), "the fill is still streaming").toBe("idle/true");
    expect(commits, "one commit calls both back").toEqual(["adoption", "fill"]);
    expect(new Set(states)).toEqual(new Set(["from the fill"]));
    fill.end();
  });

  // The fill failed, or the visitor left: another update takes the page and
  // the promise is never resolved. Nothing stays pinned to it.
  it("lets go of a held promise root when another update takes the page", async () => {
    const { emit, update, nav, shown } = await mount();
    const tree = deferred<ReactNode>();

    let fill!: { end: () => void };
    await act(async () => {
      fill = clickAndCommit();
      startTransition(() =>
        emitAdoption(() => emit({ ...update(null), root: tree.promise })),
      );
    });
    expect(nav()).toBe("loading/true");

    await act(async () => {
      fill.end();
      emit(update(<p data-testid="page">error</p>));
      await tick();
    });
    expect(shown()).toBe("error");
    expect(nav()).toBe("idle/false");
  });
});

// The real updater, a real transaction and renderRoute's provider: an
// adopted prefetch with deferred segments, and its fill.
describe("a fill for an adoption React is still holding", () => {
  const UNIT = "U";
  const DATA = "UD0.data";

  const placeholder = (
    id: string,
    type: "route" | "loader",
    extra: Partial<ResolvedSegment>,
  ): ResolvedSegment =>
    ({
      id,
      namespace: "unit",
      type,
      index: 0,
      component: null,
      params: {},
      ...extra,
    }) as unknown as ResolvedSegment;

  /**
   * `adopted` is the prefetched payload's segments, `filled` what the fill
   * answers with, `stream` how long the fill's response stays open. The tree
   * is whatever `render` makes of the segments on the page.
   */
  async function adopt(options: {
    adopted: ResolvedSegment[];
    filled: ResolvedSegment[];
    stream?: Promise<void>;
    render: (find: (id: string) => ResolvedSegment | undefined) => ReactNode;
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
    const updater = createPartialUpdater({
      store: router.store,
      client: {
        fetchPartial: async (request: { fill?: boolean }) => {
          if (!request.fill) {
            return {
              payload: payload(options.adopted),
              streamComplete: Promise.resolve(),
              fullyPrefetched: true,
            };
          }
          await answer.promise;
          return {
            payload: payload(options.filled),
            streamComplete: options.stream ?? Promise.resolve(),
          };
        },
      } as any,
      onUpdate: (update) => router.store.emitUpdate(update),
      renderSegments: (segments) =>
        options.render((id) => segments.find((s) => s.id === id)),
    });
    const here = window.location.href;
    const tx = createNavigationTransaction(
      router.store,
      router.eventController,
      here,
      { replace: true },
    );
    await act(async () => {
      await updater(
        here,
        [],
        false,
        tx.handle.signal,
        tx.with({ url: here, replace: true }),
      );
    });
    tx[Symbol.dispose]();
    return {
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

  // A layout above the unit reads the route's loader, with no boundary: the
  // read is above the unit's fallback, so React holds the adoption on that
  // loader's gate. The gate waited for the fill's tree, the tree for the
  // adoption's commit: the page being left stayed for good.
  it("commits a unit whose own loader is read above its fallback", async () => {
    function Above({ find }: { find: (id: string) => ResolvedSegment }) {
      return (
        <div>
          <i>{read(find(DATA).loaderData)}</i>
          <Suspense fallback={<p data-testid="page">skeleton</p>}>
            <Unit content={find(UNIT).component} />
          </Suspense>
        </div>
      );
    }
    function Unit({ content }: { content: unknown }) {
      return <p data-testid="page">{read(content)}</p>;
    }
    const { shown, fill } = await adopt({
      adopted: [
        placeholder(UNIT, "route", { loading: "skeleton", deferred: true }),
        placeholder(DATA, "loader", { loaderId: "data", deferred: true }),
      ],
      filled: [
        placeholder(UNIT, "route", {
          loading: "skeleton",
          component: "content",
        }),
        placeholder(DATA, "loader", { loaderId: "data", loaderData: "value" }),
      ],
      render: (find) => (
        <Above find={find as (id: string) => ResolvedSegment} />
      ),
    });
    expect(shown(), "React holds the page being left").toBe("home");

    await fill(500);
    expect(shown()).toBe("content");
  });

  // A read with no boundary, in a response that stays open behind it: no
  // fallback is on screen, so there is nothing to keep up for 300 ms.
  it("shows a held page as its value arrives, however long the response stays open", async () => {
    function Bare({ data }: { data: unknown }) {
      return <p data-testid="page">{read(data)}</p>;
    }
    const { shown, fill } = await adopt({
      adopted: [
        placeholder(DATA, "loader", { loaderId: "data", deferred: true }),
      ],
      filled: [
        placeholder(DATA, "loader", { loaderId: "data", loaderData: "value" }),
      ],
      stream: new Promise<void>(() => {}),
      render: (find) => <Bare data={find(DATA)?.loaderData} />,
    });
    expect(shown(), "React holds the page being left").toBe("home");

    await fill(100);
    expect(shown()).toBe("value");
  });
});
