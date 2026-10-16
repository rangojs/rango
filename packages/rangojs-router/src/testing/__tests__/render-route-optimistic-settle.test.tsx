// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Suspense, ViewTransition, type ReactNode } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { Link, Outlet, useAction, useLinkStatus } from "../../client.js";
import { useParams } from "../../browser/react/use-params.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
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

const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;

let spinnerLog: string[];
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

function Shell(): ReactNode {
  return (
    <div>
      <nav>
        {["2", "3", "4"].map((id) => (
          <Link key={id} to={`/items/${id}`}>
            {id}
            {id !== "4" && <Spinner id={id} />}
          </Link>
        ))}
      </nav>
      <ActionStatus />
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

async function render(transition: boolean) {
  return renderRoute(
    [
      { path: "/items", Component: Shell },
      {
        path: "/items/:id",
        Component: Item,
        ...(transition && { transition: {} }),
      },
    ],
    { request: "/items/1", loaders: [[ItemLoader, "one"]] },
  );
}

beforeEach(() => {
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
