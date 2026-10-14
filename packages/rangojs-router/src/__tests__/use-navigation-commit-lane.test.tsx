// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  startTransition,
  Suspense,
  use,
  useState,
  ViewTransition,
  type ReactNode,
} from "react";
import {
  createEventController,
  type EventController,
} from "../browser/event-controller.js";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "../browser/react/context.js";
import { useNavigation } from "../browser/react/use-navigation.js";
import { useParams } from "../browser/react/use-params.js";
import { usePathname } from "../browser/react/use-pathname.js";
import { useSearchParams } from "../browser/react/use-search-params.js";
import { commitInTransition } from "../browser/partial-update.js";
import { LoaderStore } from "../loader-store.js";
import type { NavigationUpdate } from "../browser/types.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

/**
 * useNavigation() reaches idle in the commit that brings the navigation's
 * location (#1164). A navigation commits its tree through commitInTransition
 * (browser/partial-update.ts), and NavigationProvider's update subscriber
 * flushes the controller's notification inside it, so useSearchParams,
 * usePathname and useParams take the destination in that transition. React
 * holds that transition while the destination suspends (a same-route hold,
 * a view transition). A reader of both hooks must never render idle with
 * the location of the page being left, nor loading with the destination's.
 *
 * The view-transition variant wraps the tree in <ViewTransition>, commits
 * with the "navigation" transition type, and stubs document.startViewTransition
 * (happy-dom has none), so React commits through its view-transition path:
 * the mutation runs in the stub's update callback, a task after React
 * finishes the render. Each case runs for a reader with a selector
 * (`nav.state === "idle"`) and one of the full state, whose value also
 * changes when the response stream ends.
 */

const ORIGIN = "http://localhost";

let controller: EventController;
let loaders: LoaderStore;
let log: string[];
let setTree!: (tree: ReactNode) => void;
let stub: ReturnType<typeof installViewTransitionStub> | undefined;
let form: "selector" | "full state";
// Rendered next to the tree, inside its <ViewTransition>.
let extra: ReactNode;

function Reader(): ReactNode {
  return form === "selector" ? <SelectorReader /> : <FullStateReader />;
}

function SelectorReader(): ReactNode {
  return <Location idle={useNavigation((nav) => nav.state === "idle")} />;
}

function FullStateReader(): ReactNode {
  return <Location idle={useNavigation().state === "idle"} />;
}

function Location({ idle }: { idle: boolean }): ReactNode {
  const [search] = useSearchParams();
  const pathname = usePathname();
  const id = useParams((params) => params.id);
  const entry = `${idle ? "idle" : "loading"} ${pathname}?${search} id=${id}`;
  log.push(entry);
  return <p data-testid="reader">{entry}</p>;
}

function Hold({ until }: { until: Promise<void> }): ReactNode {
  use(until);
  return null;
}

function Shell({ vt }: { vt: boolean }): ReactNode {
  const [tree, set] = useState<ReactNode>(<Reader />);
  setTree = set;
  const content = (
    <>
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        {tree}
      </Suspense>
      {extra}
    </>
  );
  return vt ? <ViewTransition>{content}</ViewTransition> : content;
}

function mount(vt: boolean) {
  const value = {
    eventController: controller,
    origin: ORIGIN,
  } as NavigationStoreContextValue;
  return render(
    <NavigationStoreContext.Provider value={value}>
      <Shell vt={vt} />
    </NavigationStoreContext.Provider>,
  );
}

/** The controller's debounced notification (event-controller.ts). */
async function notified(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * The navigation's commit: the transaction's commit (handle.complete), then
 * the tree through production's commitInTransition with an update subscriber
 * that does what NavigationProvider's does (the tree, the params, the
 * flushed notification).
 */
async function commit(
  handle: ReturnType<EventController["startNavigation"]>,
  url: string,
  params: Record<string, string>,
  until: Promise<void>,
  vt: boolean,
  urgent = false,
): Promise<void> {
  await act(async () => {
    handle.complete(new URL(url, ORIGIN));
    const onUpdate = (update: NavigationUpdate) => {
      setTree(update.root as ReactNode);
      controller.setParams(update.metadata.params!);
      controller.flushRouteState();
    };
    const update = {
      root: (
        <>
          <Reader />
          <Hold until={until} />
        </>
      ),
      metadata: { params },
    } as unknown as NavigationUpdate;
    // partial-update.ts commits a gated-off navigation (transition: false,
    // a when() that returned false) urgently.
    if (urgent) onUpdate(update);
    else {
      commitInTransition(
        loaders,
        onUpdate,
        [],
        update,
        vt ? ["navigation"] : [],
      );
    }
  });
}

/**
 * A navigation's start whose notification is flushed inside a commit React
 * holds (another navigation's or an action's): it commits in that lane.
 */
async function startInsideHeldCommit(
  until: Promise<void>,
): Promise<ReturnType<EventController["startNavigation"]>> {
  let handle!: ReturnType<EventController["startNavigation"]>;
  await act(async () => {
    startTransition(() => {
      setTree(
        <>
          <Reader />
          <Hold until={until} />
        </>,
      );
      handle = controller.startNavigation("/items/1?tag=b");
      controller.flushRouteState();
    });
  });
  return handle;
}

/** Resolves the hold and waits for React to commit the destination. */
async function release(
  hold: { promise: Promise<void>; resolve: () => void },
  reader: () => string | null,
  expected: string,
): Promise<void> {
  await act(async () => {
    hold.resolve();
    await hold.promise;
  });
  await waitFor(() => expect(reader()).toBe(expected));
}

/** The entries from the navigation's start on. */
function sinceStart(): string[] {
  return dedupe(log.slice(log.findIndex((e) => e.startsWith("loading"))));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function dedupe(list: string[]): string[] {
  return list.filter((v, i) => i === 0 || list[i - 1] !== v);
}

beforeEach(() => {
  log = [];
  extra = null;
  stub = undefined;
  loaders = new LoaderStore();
  controller = createEventController({
    initialLocation: new URL("/items/1?tag=a&tag=b", ORIGIN),
  });
  controller.setParams({ id: "1" });
});

afterEach(() => {
  cleanup();
  stub?.uninstall();
});

describe.each([
  { variant: "without view transition", vt: false, reads: "selector" },
  { variant: "without view transition", vt: false, reads: "full state" },
  { variant: "with view transition", vt: true, reads: "selector" },
  { variant: "with view transition", vt: true, reads: "full state" },
] as const)(
  "useNavigation idle commits with the location ($variant, $reads)",
  ({ vt, reads }) => {
    beforeEach(() => {
      form = reads;
      if (vt) stub = installViewTransitionStub();
    });

    it("the stream ends before React commits the held destination: idle still arrives with the new search", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const hold = deferred();

      const handle = controller.startNavigation("/items/1?tag=b");
      await notified();
      const stream = handle.startStreaming();
      await notified();
      await commit(handle, "/items/1?tag=b", { id: "1" }, hold.promise, vt);
      stream.end();
      await notified();
      expect(reader()).toBe("loading /items/1?tag=a&tag=b id=1");

      await release(hold, reader, "idle /items/1?tag=b id=1");
      expect(sinceStart()).toEqual([
        "loading /items/1?tag=a&tag=b id=1",
        "idle /items/1?tag=b id=1",
      ]);
    });

    it("a held same-route search navigation: idle arrives with the new search, never with the old", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const hold = deferred();

      const handle = controller.startNavigation("/items/1?tag=b");
      await notified();
      expect(reader()).toBe("loading /items/1?tag=a&tag=b id=1");

      await commit(handle, "/items/1?tag=b", { id: "1" }, hold.promise, vt);
      // React holds the destination: the page being left stays on screen and
      // still reports the navigation as loading.
      expect(reader()).toBe("loading /items/1?tag=a&tag=b id=1");
      expect(result.queryByTestId("skeleton")).toBeNull();

      await release(hold, reader, "idle /items/1?tag=b id=1");

      expect(sinceStart()).not.toContain("idle /items/1?tag=a&tag=b id=1");
      expect(sinceStart()).not.toContain("loading /items/1?tag=b id=1");
      expect(sinceStart()).toEqual([
        "loading /items/1?tag=a&tag=b id=1",
        "idle /items/1?tag=b id=1",
      ]);
      expect(stub?.started() ?? 0).toBe(vt ? 1 : 0);
    });

    it("a held navigation to new params: usePathname and useParams arrive with idle too", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const hold = deferred();

      const handle = controller.startNavigation("/items/2?tag=a&tag=b");
      await notified();
      await commit(
        handle,
        "/items/2?tag=a&tag=b",
        { id: "2" },
        hold.promise,
        vt,
      );
      expect(reader()).toBe("loading /items/1?tag=a&tag=b id=1");

      await release(hold, reader, "idle /items/2?tag=a&tag=b id=2");

      expect(sinceStart()).toEqual([
        "loading /items/1?tag=a&tag=b id=1",
        "idle /items/2?tag=a&tag=b id=2",
      ]);
    });

    it("an aborted navigation reports idle again on the page it never left", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;

      const handle = controller.startNavigation("/items/1?tag=b");
      await notified();
      expect(reader()).toBe("loading /items/1?tag=a&tag=b id=1");

      handle[Symbol.dispose]();
      await notified();
      expect(reader()).toBe("idle /items/1?tag=a&tag=b id=1");
    });

    it("a superseded navigation stays loading until the newer one commits", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const hold = deferred();

      controller.startNavigation("/items/1?tag=b");
      await notified();
      const second = controller.startNavigation("/items/1?tag=c");
      await notified();
      expect(reader()).toBe("loading /items/1?tag=a&tag=b id=1");

      await commit(second, "/items/1?tag=c", { id: "1" }, hold.promise, vt);
      await release(hold, reader, "idle /items/1?tag=c id=1");

      expect(sinceStart()).toEqual([
        "loading /items/1?tag=a&tag=b id=1",
        "idle /items/1?tag=c id=1",
      ]);
    });

    it("an urgent commit (transition gated off): idle and the location commit together", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const hold = deferred();

      const handle = controller.startNavigation("/items/1?tag=b");
      await notified();
      await commit(
        handle,
        "/items/1?tag=b",
        { id: "1" },
        hold.promise,
        vt,
        true,
      );
      await release(hold, reader, "idle /items/1?tag=b id=1");

      expect(sinceStart()).not.toContain("idle /items/1?tag=a&tag=b id=1");
      expect(sinceStart()).not.toContain("loading /items/1?tag=b id=1");
    });

    it("an abort while a React async action is pending reports idle at once, not at the action's end", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const action = deferred();
      // Every transition started while an async action is pending is
      // entangled with it.
      await act(async () => {
        startTransition(async () => {
          await action.promise;
        });
      });

      const handle = controller.startNavigation("/items/1?tag=b");
      await notified();
      expect(reader()).toBe("loading /items/1?tag=a&tag=b id=1");

      handle[Symbol.dispose]();
      await notified();
      expect(reader()).toBe("idle /items/1?tag=a&tag=b id=1");

      await act(async () => {
        action.resolve();
        await action.promise;
      });
      expect(reader()).toBe("idle /items/1?tag=a&tag=b id=1");
    });

    it("a navigation that commits while an action settles: idle still arrives with the location", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const hold = deferred();

      // A completed action stays in the controller for its settle window.
      const action = controller.startAction("src/actions.ts#save", []);
      action.complete(undefined);
      await notified();
      expect(controller.getInflightActions().size).toBe(1);

      const handle = controller.startNavigation("/items/1?tag=b");
      await notified();
      await commit(handle, "/items/1?tag=b", { id: "1" }, hold.promise, vt);
      expect(reader()).toBe("loading /items/1?tag=a&tag=b id=1");

      await release(hold, reader, "idle /items/1?tag=b id=1");
      expect(sinceStart()).toEqual([
        "loading /items/1?tag=a&tag=b id=1",
        "idle /items/1?tag=b id=1",
      ]);
    });

    it("a navigation whose start is flushed inside a held commit reports loading when that commit lands", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const hold = deferred();

      const handle = await startInsideHeldCommit(hold.promise);
      await release(hold, reader, "loading /items/1?tag=a&tag=b id=1");

      handle[Symbol.dispose]();
      await notified();
      expect(reader()).toBe("idle /items/1?tag=a&tag=b id=1");
    });

    it("a navigation aborted while another commit is held reports idle at once, and nothing reports loading once that commit lands", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const hold = deferred();

      const handle = await startInsideHeldCommit(hold.promise);
      handle[Symbol.dispose]();
      await notified();
      expect(reader()).toBe("idle /items/1?tag=a&tag=b id=1");

      await release(hold, reader, "idle /items/1?tag=a&tag=b id=1");
    });

    // Overlap, not covered yet (on main either): while a navigation's commit
    // is held, a notification that is not quiet (an action, another
    // navigation) delivers the controller's whole state at default priority,
    // the held idle included, ahead of the commit that brings the location.
    it.fails("overlap: an action that starts and settles while a navigation's commit is held never shows idle with the old search", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const hold = deferred();

      const handle = controller.startNavigation("/items/1?tag=b");
      await notified();
      await commit(handle, "/items/1?tag=b", { id: "1" }, hold.promise, vt);
      const action = controller.startAction("src/actions.ts#save", []);
      await notified();
      action.complete(undefined);
      await notified();

      await release(hold, reader, "idle /items/1?tag=b id=1");
      expect(sinceStart()).not.toContain("idle /items/1?tag=a&tag=b id=1");
    });

    it.fails("overlap: a second navigation started and aborted while a navigation's commit is held never shows idle with the old search", async () => {
      const result = mount(vt);
      const reader = () => result.getByTestId("reader").textContent;
      const hold = deferred();

      const handle = controller.startNavigation("/items/1?tag=b");
      await notified();
      await commit(handle, "/items/1?tag=b", { id: "1" }, hold.promise, vt);
      const second = controller.startNavigation("/items/1?tag=c");
      await notified();
      second[Symbol.dispose]();
      await notified();

      await release(hold, reader, "idle /items/1?tag=b id=1");
      expect(sinceStart()).not.toContain("idle /items/1?tag=a&tag=b id=1");
    });
  },
);

/**
 * A notification that moves neither the state nor the location (the stream
 * starting, which clears pendingUrl, or ending, which clears isStreaming)
 * goes in a transition only while a value of the reader's is held, so React
 * entangles it with that value. Otherwise it is urgent: a transition of its
 * own starts a view transition inside a <ViewTransition> that resolves a
 * class for a commit with no types (transition({}) does), and commits ahead
 * of a held page, taking the page's transition types.
 */
describe("useNavigation: a quiet notification", () => {
  let vtTypes: string[][];

  function QuietReader(): ReactNode {
    const pendingUrl = useNavigation((nav) => nav.pendingUrl);
    const streaming = useNavigation((nav) => nav.isStreaming);
    return <p data-testid="quiet">{`${pendingUrl ?? "none"} ${streaming}`}</p>;
  }

  beforeEach(() => {
    form = "selector";
    extra = <QuietReader />;
    stub = installViewTransitionStub();
    vtTypes = [];
    const doc = document as unknown as {
      startViewTransition: (options: { types?: Iterable<string> }) => unknown;
    };
    const start = doc.startViewTransition;
    doc.startViewTransition = (options) => {
      vtTypes.push([...(options.types ?? [])]);
      return start(options);
    };
  });

  it("starts no view transition when nothing of the reader's is held", async () => {
    const result = mount(true);
    const quiet = () => result.getByTestId("quiet").textContent;

    const handle = controller.startNavigation("/items/1?tag=b");
    await notified();
    expect(quiet()).toBe("/items/1?tag=b true");

    const stream = handle.startStreaming();
    await notified();
    await waitFor(() => expect(quiet()).toBe("none true"));

    // Urgent, and already settled: the commit itself starts no view
    // transition and reveals no boundary.
    const settled = Object.assign(Promise.resolve(), {
      status: "fulfilled",
      value: undefined,
    });
    await commit(handle, "/items/1?tag=b", { id: "1" }, settled, true, true);
    stream.end();
    await notified();
    await waitFor(() => expect(quiet()).toBe("none false"));
    expect(vtTypes).toEqual([]);
  });

  it("while a page is held, starts no view transition of its own and leaves the page its types", async () => {
    const result = mount(true);
    const quiet = () => result.getByTestId("quiet").textContent;
    const hold = deferred();

    const handle = controller.startNavigation("/items/1?tag=b");
    await notified();
    const stream = handle.startStreaming();
    await notified();
    await commit(handle, "/items/1?tag=b", { id: "1" }, hold.promise, true);
    // The stream ends while React holds the page.
    stream.end();
    await notified();
    await waitFor(() => expect(quiet()).toBe("none false"));

    await release(
      hold,
      () => result.getByTestId("reader").textContent,
      "idle /items/1?tag=b id=1",
    );
    // One view transition: the page's, with the types its commit added.
    expect(vtTypes).toHaveLength(1);
    expect(vtTypes[0]).toContain("navigation");
  });
});
