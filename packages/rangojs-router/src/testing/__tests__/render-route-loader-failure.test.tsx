// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  Component,
  Suspense,
  useEffect,
  useState,
  type ErrorInfo as ReactErrorInfo,
  type ReactNode,
} from "react";
import {
  createLocationState,
  useLoader,
  useLocationState,
} from "../../client.js";
import type { LoaderDefinition } from "../../types.js";
import { loaderFailure, renderRoute } from "../dom.entry.js";
import { withLocationStateKey } from "../index.js";

// Consumer contract: loaderFailure() hands a renderRoute loader seed the
// result of a loader that called notFound(), threw redirect() or threw an
// error, and the router places it as it places a real one: the not-found UI
// or the errorBoundary() fallback in place of the route's content, a
// redirect as a replace-navigation, an error without a fallback at its read.

afterEach(cleanup);

interface Item {
  name: string;
}

const ItemLoader = {
  __brand: "loader",
  $$id: "loader-failure#ItemLoader",
} as unknown as LoaderDefinition<Item>;

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>(),
  "LoaderFailureFlash",
);

let goneMounts: number;

/** A not-found UI with local state, as a notFoundBoundary() renders it. */
function ItemGone(): ReactNode {
  const [note, setNote] = useState("");
  useEffect(() => {
    goneMounts++;
  }, []);
  return (
    <div data-testid="gone">
      <p>Item gone</p>
      <input
        data-testid="note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
    </div>
  );
}

function ItemPage(): ReactNode {
  const { data } = useLoader(ItemLoader);
  const flash = useLocationState(Flash);
  return (
    <p data-testid="item">
      {data.name}
      {flash ? ` (${flash.text})` : ""}
    </p>
  );
}

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  componentDidCatch(_error: Error, _info: ReactErrorInfo): void {}
  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return <p data-testid="app-error">{`${error.name}: ${error.message}`}</p>;
    }
    return this.props.children;
  }
}

/** The page's reader under an error boundary of the app. */
function GuardedItemPage(): ReactNode {
  return (
    <AppErrorBoundary>
      <ItemPage />
    </AppErrorBoundary>
  );
}

/** The page's reader under a Suspense boundary of the app. */
function SuspendedItemPage(): ReactNode {
  return (
    <Suspense fallback={<p data-testid="loading">loading</p>}>
      <ItemPage />
    </Suspense>
  );
}

const routes = [{ path: "/items/:id", Component: ItemPage }];
const guardedRoutes = [{ path: "/items/:id", Component: GuardedItemPage }];
const suspendedRoutes = [{ path: "/items/:id", Component: SuspendedItemPage }];

const text = (testId: string): string | null =>
  document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("renderRoute: a loader that calls notFound()", () => {
  it("a not-found UI a navigation shows keeps its instance when an action re-runs the loader and it still calls notFound()", async () => {
    goneMounts = 0;
    const { router, getByTestId } = await renderRoute(routes, {
      request: "/items/1",
      loaders: [[ItemLoader, { name: "one" }]],
    });
    expect(getByTestId("item").textContent).toBe("one");

    await router.navigate("/items/2", {
      loaders: [
        [ItemLoader, loaderFailure({ notFound: true, fallback: <ItemGone /> })],
      ],
    });
    const gone = getByTestId("gone");
    fireEvent.change(getByTestId("note"), { target: { value: "draft" } });
    expect(goneMounts).toBe(1);

    await router.action({
      loaders: [
        [ItemLoader, loaderFailure({ notFound: true, fallback: <ItemGone /> })],
      ],
    });

    expect(getByTestId("gone")).toBe(gone);
    expect((getByTestId("note") as HTMLInputElement).value).toBe("draft");
    expect(goneMounts).toBe(1);
  });

  it("an action whose loader finds the item again shows the content in its place", async () => {
    const { router, getByTestId, queryByTestId } = await renderRoute(routes, {
      request: "/items/2",
      loaders: [
        [ItemLoader, loaderFailure({ notFound: true, fallback: <ItemGone /> })],
      ],
    });
    expect(queryByTestId("gone")).not.toBeNull();

    await router.action({ loaders: [[ItemLoader, { name: "two" }]] });

    expect(queryByTestId("gone")).toBeNull();
    expect(getByTestId("item").textContent).toBe("two");
  });

  it("a refresh and a click on a prefetched page show the not-found UI their response carries", async () => {
    const { router, getByTestId, queryByTestId } = await renderRoute(routes, {
      request: "/items/1",
      loaders: [[ItemLoader, { name: "one" }]],
    });

    await router.refresh({
      loaders: [
        [ItemLoader, loaderFailure({ notFound: true, fallback: <ItemGone /> })],
      ],
    });
    expect(queryByTestId("gone")).not.toBeNull();

    router.prefetch("/items/3", {
      loaders: [
        [ItemLoader, loaderFailure({ notFound: true, fallback: <ItemGone /> })],
      ],
    });
    await router.navigate("/items/2", {
      loaders: [[ItemLoader, { name: "two" }]],
    });
    expect(getByTestId("item").textContent).toBe("two");
    await router.navigate("/items/3");
    expect(queryByTestId("gone")).not.toBeNull();
  });

  it("a hydrated document whose loader called notFound() shows its not-found UI", async () => {
    const { getByTestId, shellError } = await renderRoute(routes, {
      request: "/items/2",
      hydrate: true,
      loaders: [
        [ItemLoader, loaderFailure({ notFound: true, fallback: <ItemGone /> })],
      ],
    });
    // The read throws outside any <Suspense>: the server pass fails the
    // shell, and the browser renders the recovery document's tree.
    expect((shellError as Error).name).toBe("DataNotFoundError");
    expect(getByTestId("gone").textContent).toContain("Item gone");
  });

  it("without a fallback renders the router's default not-found UI", async () => {
    const { container } = await renderRoute(routes, {
      request: "/items/2",
      loaders: [[ItemLoader, loaderFailure({ notFound: true })]],
    });
    expect(container.querySelector("h1")?.textContent).toBe("Not Found");
  });

  it("a loader that streams and then calls notFound() shows its not-found UI once it settles", async () => {
    const { router, getByTestId } = await renderRoute(suspendedRoutes, {
      request: "/items/1",
      loaders: [[ItemLoader, { name: "one" }]],
    });
    const late = deferred<unknown>();

    await router.navigate("/items/2", {
      loaders: [[ItemLoader, late.promise]],
    });
    expect(getByTestId("loading").textContent).toBe("loading");

    await act(async () => {
      late.resolve(loaderFailure({ notFound: true, fallback: <ItemGone /> }));
      await late.promise;
    });
    await waitFor(() => expect(text("gone")).toContain("Item gone"));
  });

  it("Back onto the entry whose loader called notFound() restores its not-found UI", async () => {
    const { router } = await renderRoute(routes, {
      request: "/items/2",
      loaders: [
        [ItemLoader, loaderFailure({ notFound: true, fallback: <ItemGone /> })],
      ],
    });

    await router.navigate("/items/1", {
      // Pushes an entry, so Back restores the first page from its own.
      state: { from: "items" },
      loaders: [[ItemLoader, { name: "one" }]],
    });
    expect(text("item")).toBe("one");

    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(text("gone")).toContain("Item gone"));
    expect(text("item")).toBeNull();
  });
});

describe("renderRoute: a loader that throws an error", () => {
  it("with an errorBoundary() fallback renders the fallback in place of the content", async () => {
    const { router, getByTestId, queryByTestId } = await renderRoute(routes, {
      request: "/items/1",
      loaders: [[ItemLoader, { name: "one" }]],
    });

    await router.navigate("/items/2", {
      loaders: [
        [
          ItemLoader,
          loaderFailure({
            error: new Error("database down"),
            fallback: <p data-testid="item-error">Could not load the item</p>,
          }),
        ],
      ],
    });

    expect(getByTestId("item-error").textContent).toBe(
      "Could not load the item",
    );
    expect(queryByTestId("item")).toBeNull();
  });

  it("on an action's re-run renders its errorBoundary() fallback in place of the content", async () => {
    const { router, getByTestId, queryByTestId } = await renderRoute(routes, {
      request: "/items/1",
      loaders: [[ItemLoader, { name: "one" }]],
    });

    await router.action({
      loaders: [
        [
          ItemLoader,
          loaderFailure({
            error: new Error("database down"),
            fallback: <p data-testid="item-error">Could not load the item</p>,
          }),
        ],
      ],
    });

    expect(getByTestId("item-error").textContent).toBe(
      "Could not load the item",
    );
    expect(queryByTestId("item")).toBeNull();
  });

  it("without a fallback throws the error at its read, to the app's error boundary", async () => {
    const error = new TypeError("database down");
    const { router, getByTestId } = await renderRoute(guardedRoutes, {
      request: "/items/1",
      loaders: [[ItemLoader, { name: "one" }]],
    });

    await router.navigate("/items/2", {
      loaders: [[ItemLoader, loaderFailure({ error })]],
    });

    expect(getByTestId("app-error").textContent).toBe(
      "TypeError: database down",
    );
  });

  it("a load() the endpoint answers with the failure rejects with its message", async () => {
    function Reload(): ReactNode {
      const { data, load } = useLoader(ItemLoader);
      const [error, setError] = useState("");
      return (
        <>
          <p data-testid="item">{data.name}</p>
          <p data-testid="load-error">{error}</p>
          <button
            data-testid="reload"
            onClick={() => void load().catch((e: Error) => setError(e.message))}
          />
        </>
      );
    }
    const { router, getByTestId } = await renderRoute(
      [{ path: "/items/:id", Component: Reload }],
      { request: "/items/1", loaders: [[ItemLoader, { name: "one" }]] },
    );

    router.respondToLoads({
      loaders: [[ItemLoader, loaderFailure({ error: new Error("gone away") })]],
    });
    fireEvent.click(getByTestId("reload"));

    await waitFor(() =>
      expect(getByTestId("load-error").textContent).toBe("gone away"),
    );
    expect(getByTestId("item").textContent).toBe("one");
  });
});

describe("renderRoute: a loader that throws redirect()", () => {
  it("replace-navigates to the target, with the redirect's location state", async () => {
    const { router, getByTestId } = await renderRoute(routes, {
      request: "/items/1",
      loaders: [[ItemLoader, { name: "one" }]],
    });

    await act(async () => {
      await router.navigate("/items/2", {
        loaders: [
          [
            ItemLoader,
            loaderFailure({
              redirect: "/items/1",
              state: [[Flash, { text: "moved" }]],
            }),
          ],
        ],
      });
    });

    await waitFor(() => expect(router.pathname()).toBe("/items/1"));
    await waitFor(() =>
      expect(getByTestId("item").textContent).toBe("one (moved)"),
    );
  });

  it("on an action's re-run replace-navigates to the target", async () => {
    const { router, queryByTestId } = await renderRoute(routes, {
      request: "/items/1",
      loaders: [[ItemLoader, { name: "one" }]],
    });
    await router.navigate("/items/2", {
      loaders: [[ItemLoader, { name: "two" }]],
    });

    await act(async () => {
      await router.action({
        loaders: [[ItemLoader, loaderFailure({ redirect: "/items/9" })]],
      });
    });

    await waitFor(() => expect(router.pathname()).toBe("/items/9"));
    // The action's seeds are the data every later response carries, so the
    // target's loader redirects too: its segment stays empty.
    expect(queryByTestId("item")).toBeNull();
  });

  it("a cross-origin target lands on the root, as the server's guard sends it", async () => {
    const { router } = await renderRoute(
      [{ path: "/*", Component: ItemPage }],
      { request: "/items/1", loaders: [[ItemLoader, { name: "one" }]] },
    );

    await act(async () => {
      await router.navigate("/items/2", {
        loaders: [
          [ItemLoader, loaderFailure({ redirect: "https://elsewhere.test/x" })],
        ],
      });
    });

    await waitFor(() => expect(router.pathname()).toBe("/"));
  });
});
