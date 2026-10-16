// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  Suspense,
  use,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  createEventController,
  type EventController,
  type NavigationHandle,
} from "../browser/event-controller.js";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "../browser/react/context.js";
import {
  LinkContext,
  useLinkStatus,
} from "../browser/react/use-link-status.js";
import { commitInTransition } from "../browser/partial-update.js";
import { LoaderStore } from "../loader-store.js";
import type { NavigationUpdate } from "../browser/types.js";

/**
 * When useLinkStatus().pending commits, against a real event controller and
 * production's commitInTransition (browser/partial-update.ts), with an
 * update subscriber that does what NavigationProvider's does: the tree, then
 * the controller's queued notification flushed inside the update, "anchor"
 * for a commit in a transition. The link sits in the chrome, outside the
 * tree each commit replaces; every one of its commits is logged with the
 * page on screen. Each case asserts the frames.
 */

const ORIGIN = "http://localhost";

let controller: EventController;
let loaders: LoaderStore;
let log: string[];
let setTree!: (tree: ReactNode) => void;

function onScreen(): string {
  if (document.querySelector('[data-testid="skeleton"]')) return "skeleton";
  return document.querySelector('[data-testid="page"]')?.textContent ?? "-";
}

function Spinner({ to }: { to: string }): ReactNode {
  const { pending } = useLinkStatus();
  useLayoutEffect(() => {
    log.push(`${to}:${pending ? "pending" : "idle"}:${onScreen()}`);
  });
  return null;
}

function Page({ id }: { id: string }): ReactNode {
  return <p data-testid="page">{id}</p>;
}

function Hold({ until }: { until: Promise<void> }): ReactNode {
  use(until);
  return null;
}

function Shell(): ReactNode {
  const [tree, set] = useState<ReactNode>(<Page id="1" />);
  setTree = set;
  return (
    <>
      {["/items/1", "/items/2"].map((to) => (
        <LinkContext.Provider key={to} value={to}>
          <Spinner to={to} />
        </LinkContext.Provider>
      ))}
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        {tree}
      </Suspense>
    </>
  );
}

function mount() {
  const value = {
    eventController: controller,
    origin: ORIGIN,
  } as NavigationStoreContextValue;
  return render(
    <NavigationStoreContext.Provider value={value}>
      <Shell />
    </NavigationStoreContext.Provider>,
  );
}

/** NavigationProvider's update subscriber, reduced to what links read. */
const onUpdate = (update: NavigationUpdate): void => {
  setTree(update.root as ReactNode);
  controller.flushRouteState(update.inTransition ? "anchor" : "release");
};

function tree(id: string, until?: Promise<void>): NavigationUpdate {
  return {
    root: (
      <>
        <Page id={id} />
        {until && <Hold until={until} />}
      </>
    ),
    metadata: {},
  } as unknown as NavigationUpdate;
}

/** A commit in a transition (a navigation's, an action's, a revalidation's). */
function held(update: NavigationUpdate): void {
  commitInTransition(loaders, onUpdate, [], update, "push", []);
}

/** The controller's debounced notification (event-controller.ts). */
async function notified(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function release(hold: {
  promise: Promise<void>;
  resolve: () => void;
}): Promise<void> {
  await act(async () => {
    hold.resolve();
    await hold.promise;
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Link `to`'s commits, deduplicated. */
function frames(to: string): string[] {
  return log
    .filter((entry) => entry.startsWith(`${to}:`))
    .map((entry) => entry.slice(to.length + 1))
    .filter((entry, i, all) => i === 0 || all[i - 1] !== entry);
}

beforeEach(() => {
  log = [];
  loaders = new LoaderStore();
  controller = createEventController({
    initialLocation: new URL("/items/1", ORIGIN),
  });
});

afterEach(() => cleanup());

describe("useLinkStatus commit lane", () => {
  it("a click whose start is flushed inside another flow's held commit shows pending at once", async () => {
    mount();
    const foreign = deferred();
    const page = deferred();

    let handle!: NavigationHandle;
    await act(async () => {
      handle = controller.startNavigation(`${ORIGIN}/items/2`);
      // An action's commit, handed to React before the click's notification
      // goes out; React holds it.
      held(tree("1", foreign.promise));
    });
    expect(frames("/items/2")).toEqual(["idle:1", "pending:1"]);

    await release(foreign);
    expect(frames("/items/2")).toEqual(["idle:1", "pending:1"]);

    await act(async () => {
      handle.complete(new URL("/items/2", ORIGIN));
      held(tree("2", page.promise));
    });
    expect(frames("/items/2")).toEqual(["idle:1", "pending:1"]);
    await release(page);
    await waitFor(() =>
      expect(frames("/items/2")).toEqual(["idle:1", "pending:1", "idle:2"]),
    );
  });

  it("a navigation aborted while another flow's commit is held ends its pending at once", async () => {
    mount();
    const foreign = deferred();

    const handle = controller.startNavigation(`${ORIGIN}/items/2`);
    await notified();
    await act(async () => held(tree("1", foreign.promise)));
    handle[Symbol.dispose]();
    await notified();
    expect(frames("/items/2")).toEqual(["idle:1", "pending:1", "idle:1"]);

    await release(foreign);
    expect(frames("/items/2")).toEqual(["idle:1", "pending:1", "idle:1"]);
  });

  it("a prefetch: false fill: the fill's flush shows pending before the hand-over, and it ends with the page", async () => {
    mount();
    const holes = deferred();

    await act(async () => {
      const handle = controller.startNavigation(`${ORIGIN}/items/2`);
      // partial-update.ts: a tree with holes commits in the click's task;
      // the bridge delivers the navigation state first
      // (PartialUpdateConfig.fill.flush, flushSync(flushRouteState)).
      flushSync(() => controller.flushRouteState());
      expect(frames("/items/2")).toEqual(["idle:1", "pending:1"]);
      handle.complete(new URL("/items/2", ORIGIN));
      held(tree("2", holes.promise));
    });
    expect(frames("/items/2")).toEqual(["idle:1", "pending:1"]);

    await release(holes);
    await waitFor(() =>
      expect(frames("/items/2")).toEqual(["idle:1", "pending:1", "idle:2"]),
    );
  });

  it("Back to a stale entry while it revalidates: no link goes pending", async () => {
    mount();
    // On /items/2, its page committed.
    const handle = controller.startNavigation(`${ORIGIN}/items/2`);
    await notified();
    await act(async () => {
      handle.complete(new URL("/items/2", ORIGIN));
      onUpdate(tree("2"));
    });

    // Back restores /items/1 from the history cache (navigation-bridge.ts
    // handlePopstate), then revalidates the stale entry in the background
    // (skipLoadingState), in a transition React holds while it streams.
    const revalidation = deferred();
    await act(async () => {
      controller.setLocation(new URL("/items/1", ORIGIN));
      onUpdate(tree("1"));
    });
    const background = controller.startNavigation(`${ORIGIN}/items/1`, {
      skipLoadingState: true,
      replace: true,
    });
    await notified();
    await act(async () => {
      background.complete(new URL("/items/1", ORIGIN));
      held(tree("1*", revalidation.promise));
    });
    await release(revalidation);
    await waitFor(() => expect(onScreen()).toBe("1*"));

    // Every commit of the link to the restored entry reads idle: the page
    // left, the restored one and its revalidation.
    expect(frames("/items/1")).toEqual([
      "idle:1",
      "idle:2",
      "idle:1",
      "idle:1*",
    ]);
    expect(frames("/items/2")).toEqual([
      "idle:1",
      "pending:1",
      "idle:2",
      "idle:1",
      "idle:1*",
    ]);
  });

  it("a background navigation (an action's refetch) while a link's page is held leaves that link pending until the page shows", async () => {
    mount();
    const page = deferred();

    const handle = controller.startNavigation(`${ORIGIN}/items/2`);
    await notified();
    await act(async () => {
      handle.complete(new URL("/items/2", ORIGIN));
      held(tree("2", page.promise));
    });
    // server-action-bridge.ts refetchRoute: skipLoadingState.
    const refetch = controller.startNavigation(`${ORIGIN}/items/2`, {
      skipLoadingState: true,
      replace: true,
    });
    await notified();
    expect(frames("/items/2")).toEqual(["idle:1", "pending:1"]);

    await release(page);
    await waitFor(() => expect(onScreen()).toBe("2"));
    expect(frames("/items/2")).toEqual(["idle:1", "pending:1", "idle:2"]);
    refetch[Symbol.dispose]();
  });
});
