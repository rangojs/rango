// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Suspense,
  useLayoutEffect,
  ViewTransition,
  type ReactNode,
} from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import {
  Link,
  Outlet,
  useAction,
  useLinkStatus,
  useNavigation,
  usePathname,
} from "../../client.js";
import { useParams } from "../../browser/react/use-params.js";
import { useLoader } from "../../use-loader.js";
import { emitNavigationError } from "../../browser/network-error-handler.js";
import type { LoaderDefinition, TransitionConfig } from "../../types.js";
import { renderRoute } from "../dom.entry.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

// Consumer contract (hooks review dc-d152, W2): optimistic hook values show
// the work at once and settle in the page's commit, and they never take the
// page's transition types.
// - useLinkStatus().pending is true from the call until the page commits,
//   held with it under transition() (q1, rows LS1, LS6).
// - A second click while a page is held, to a link with a useLinkStatus
//   reader: the page still commits with its types (p8, row TT4).
// - A server action that changes state while a page is held: the page still
//   commits with its types, and no view transition starts without them (p6,
//   row A2).
// The "frames" cases log every commit of a reader in link 2 (useLinkStatus,
// useNavigation and usePathname together) and of a full-state useAction
// reader, each with the page on screen.

const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;

let spinnerLog: string[];
/** Every commit of link 2's reader: "<pending> <state> <pathname> <page>". */
let chrome: string[];
/** Every commit of the full-state useAction reader: "<state> <page>". */
let actions: string[];
let stub: ReturnType<typeof installViewTransitionStub> | undefined;
/** The types each commit of the push-keyed <ViewTransition> resolved with. */
let pushAnimated: string[][];

function Spinner({ id }: { id: string }): ReactNode {
  const { pending } = useLinkStatus();
  spinnerLog.push(`${id}:${pending ? "pending" : "idle"}`);
  return <span data-testid={`spinner-${id}`}>{pending ? "pending" : ""}</span>;
}

function ActionStatus(): ReactNode {
  const state = useAction("save", (s) => s.state);
  return <span data-testid="action">{state}</span>;
}

function onScreen(): string {
  if (document.querySelector('[data-testid="skeleton"]')) return "skeleton";
  return document.querySelector('[data-testid="page"]')?.textContent ?? "-";
}

/** Reads three hooks in one component, inside link 2. */
function Chrome(): ReactNode {
  const { pending } = useLinkStatus();
  const { state } = useNavigation();
  const pathname = usePathname();
  useLayoutEffect(() => {
    chrome.push(
      `${pending ? "pending" : "idle"} ${state} ${pathname} ${onScreen()}`,
    );
  });
  return null;
}

/** A full-state useAction reader. */
function ActionLog(): ReactNode {
  const action = useAction("save");
  useLayoutEffect(() => {
    actions.push(`${action.state} ${onScreen()}`);
  });
  return null;
}

function Shell(): ReactNode {
  return (
    <div>
      <nav>
        {["2", "3", "4"].map((id) => (
          <Link key={id} to={`/items/${id}`}>
            {id}
            {id !== "4" && <Spinner id={id} />}
            {id === "2" && <Chrome />}
          </Link>
        ))}
      </nav>
      <ActionStatus />
      <ActionLog />
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <Outlet />
      </Suspense>
    </div>
  );
}

function Item(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const { data } = useLoader(ItemLoader);
  return (
    <ViewTransition
      key={id}
      enter={{ push: "page", default: "none" }}
      onEnter={(_, types) => void pushAnimated.push([...types])}
    >
      <p data-testid="page">{`${id}:${data}`}</p>
    </ViewTransition>
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function deferred(): {
  promise: Promise<string>;
  resolve: (v: string) => void;
} {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { promise, resolve };
}

async function render(transition: boolean | TransitionConfig) {
  return renderRoute(
    [
      { path: "/items", Component: Shell },
      {
        path: "/items/:id",
        Component: Item,
        ...(transition && {
          transition: transition === true ? {} : transition,
        }),
      },
    ],
    { request: "/items/1", loaders: [[ItemLoader, "one"]] },
  );
}

function dedupe(list: string[]): string[] {
  return list.filter((v, i) => i === 0 || list[i - 1] !== v);
}

beforeEach(() => {
  chrome = [];
  actions = [];
  spinnerLog = [];
  pushAnimated = [];
  stub = installViewTransitionStub();
});

afterEach(() => {
  cleanup();
  stub?.uninstall();
});

describe("renderRoute: optimistic hook values settle in the page's commit", () => {
  it("transition(): a link stays pending while React holds its page, and settles with the page (q1)", async () => {
    const { getByTestId, router } = await render(true);
    const item = deferred();

    await router.navigate("/items/2", {
      loaders: [[ItemLoader, item.promise]],
    });
    await settle();
    // React holds the destination: the page being left, its link pending.
    expect(getByTestId("page").textContent).toBe("1:one");
    expect(getByTestId("spinner-2").textContent).toBe("pending");

    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(getByTestId("page").textContent).toBe("2:two"));
    expect(getByTestId("spinner-2").textContent).toBe("");
  });

  it("no transition(): a link is pending until its skeleton commits (LS1 none)", async () => {
    const { getByTestId, queryByTestId, router } = await render(false);
    const item = deferred();

    await router.navigate("/items/2", {
      loaders: [[ItemLoader, item.promise]],
    });
    await settle();
    expect(queryByTestId("skeleton")).not.toBeNull();
    expect(getByTestId("spinner-2").textContent).toBe("");
    expect(spinnerLog).toContain("2:pending");

    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(getByTestId("page").textContent).toBe("2:two"));
  });

  it("a newer navigation ends the held link's pending at its call", async () => {
    const { getByTestId, router } = await render(true);
    const two = deferred();
    const three = deferred();

    await router.navigate("/items/2", { loaders: [[ItemLoader, two.promise]] });
    await settle();
    expect(getByTestId("spinner-2").textContent).toBe("pending");

    const next = router.navigate("/items/3", {
      loaders: [[ItemLoader, three.promise]],
    });
    await settle();
    expect(getByTestId("spinner-2").textContent).toBe("");
    expect(getByTestId("spinner-3").textContent).toBe("pending");
    await next;

    await act(async () => {
      two.resolve("two");
      three.resolve("three");
      await Promise.all([two.promise, three.promise]);
    });
    await waitFor(() =>
      expect(getByTestId("page").textContent).toBe("3:three"),
    );
    expect(getByTestId("spinner-3").textContent).toBe("");
  });

  it("a second click while a page is held, to a link with a useLinkStatus reader: the page commits with its types (p8)", async () => {
    const { getByTestId, router } = await render(true);
    const two = deferred();

    await router.navigate("/items/2", { loaders: [[ItemLoader, two.promise]] });
    await settle();
    await router.navigate("/items/3", { loaders: [[ItemLoader, "three"]] });
    await settle();
    await waitFor(() =>
      expect(getByTestId("page").textContent).toBe("3:three"),
    );
    await act(async () => {
      two.resolve("two");
      await two.promise;
    });
    await settle();

    expect(getByTestId("page").textContent).toBe("3:three");
    expect(pushAnimated).toEqual([["push", "navigation"]]);
    expect(stub!.types()).toEqual([["push", "navigation"]]);
  });

  it("an action that changes state while a page is held: the page commits with its types, and no view transition starts without them (p6)", async () => {
    const { getByTestId, router } = await render(true);
    const item = deferred();

    await router.navigate("/items/2", {
      loaders: [[ItemLoader, item.promise]],
    });
    await settle();
    const action = router.eventController.startAction("x#save", []);
    await settle();
    expect(getByTestId("action").textContent).toBe("loading");
    action.startStreaming();
    await settle();
    expect(getByTestId("action").textContent).toBe("streaming");

    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(getByTestId("page").textContent).toBe("2:two"));
    await settle();
    expect(pushAnimated).toEqual([["push", "navigation"]]);
    expect(stub!.types()).toEqual([["push", "navigation"]]);
    action[Symbol.dispose]();
  });
});

describe("renderRoute: optimistic hook values settle in the page's commit (frames)", () => {
  it("a component that reads useLinkStatus, useNavigation and usePathname: pending and loading commit together at the call, and idle, idle and the pathname with the page", async () => {
    const { router } = await render(true);
    const item = deferred();

    await router.navigate("/items/2", {
      loaders: [[ItemLoader, item.promise]],
    });
    await settle();
    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(onScreen()).toBe("2:two"));

    expect(dedupe(chrome)).toEqual([
      "idle idle /items/1 1:one",
      "pending loading /items/1 1:one",
      "idle idle /items/2 2:two",
    ]);
  });

  it("transition: false on a transition() route: the commit is urgent, the link is pending until the skeleton commits, and the push map animates nothing", async () => {
    const { router } = await render(true);
    const item = deferred();

    await router.navigate("/items/2", {
      transition: false,
      loaders: [[ItemLoader, item.promise]],
    });
    await settle();
    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(onScreen()).toBe("2:two"));

    // The skeleton's commit brings all three; the reveal changes none.
    expect(dedupe(chrome)).toEqual([
      "idle idle /items/1 1:one",
      "pending loading /items/1 1:one",
      "idle idle /items/2 skeleton",
    ]);
    // Urgent: no commit carries the push. The view transitions React starts
    // for the skeleton's reveal carry no types (Suspense retries, #1078; the
    // same on the base).
    expect(pushAnimated).toEqual([]);
    expect(stub!.types().flat()).toEqual([]);
  });

  it("transition({ viewTransition: false }): React holds the page, the link is pending until it commits, and an action during the wait leaves the page its types", async () => {
    const { router } = await render({ viewTransition: false });
    const item = deferred();

    await router.navigate("/items/2", {
      loaders: [[ItemLoader, item.promise]],
    });
    await settle();
    const action = router.eventController.startAction("x#save", []);
    await settle();
    action.startStreaming();
    await settle();
    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(onScreen()).toBe("2:two"));
    await settle();

    expect(dedupe(chrome)).toEqual([
      "idle idle /items/1 1:one",
      "pending loading /items/1 1:one",
      "idle loading /items/2 2:two",
    ]);
    // The page's own <ViewTransition> animates the push.
    expect(pushAnimated).toEqual([["push", "navigation"]]);
    expect(stub!.types()).toEqual([["push", "navigation"]]);
    action[Symbol.dispose]();
  });

  it("a full-state useAction reader: each action state commits at once while React holds a page, and the page keeps its types", async () => {
    const { router } = await render(true);
    const item = deferred();

    await router.navigate("/items/2", {
      loaders: [[ItemLoader, item.promise]],
    });
    await settle();
    const action = router.eventController.startAction("x#save", []);
    await settle();
    const stream = action.startStreaming();
    await settle();
    action.complete("saved");
    stream.end();
    await settle();
    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(onScreen()).toBe("2:two"));
    await settle();

    expect(dedupe(actions)).toEqual([
      "idle 1:one",
      "loading 1:one",
      "streaming 1:one",
      "idle 1:one",
      "idle 2:two",
    ]);
    expect(pushAnimated).toEqual([["push", "navigation"]]);
    expect(stub!.types()).toEqual([["push", "navigation"]]);
  });

  it("a navigation the router fails (a network error, a response it cannot read): the root error screen replaces the page and its link in one commit", async () => {
    const { router, queryByText } = await render(true);

    const handle = router.eventController.startNavigation(
      "http://localhost/items/2",
    );
    await settle();
    // navigation-bridge.ts navigate(): the error goes to the boundary, then
    // the transaction is disposed.
    await act(async () => {
      emitNavigationError(
        (update) => router.store.emitUpdate(update),
        new Error("unreadable response"),
        "/items/2",
      );
      handle[Symbol.dispose]();
    });
    await settle();

    expect(queryByText("Internal Server Error")).not.toBeNull();
    // The link's last commit is the page it was pending on: no frame shows
    // it beside the error screen.
    expect(dedupe(chrome)).toEqual([
      "idle idle /items/1 1:one",
      "pending loading /items/1 1:one",
    ]);
    expect(document.querySelector('[data-testid="spinner-2"]')).toBeNull();
  });
});
