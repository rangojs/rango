// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Suspense, type ReactNode } from "react";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Link, Outlet, useLinkStatus, useRouter } from "../../client.js";
import { useParams } from "../../browser/react/use-params.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../dom.entry.js";

// Consumer contract: useLinkStatus().pending marks the link that was clicked.
// - Two <Link>s to one address: a click on one makes only that one pending,
//   until its page commits; a click on the other moves the mark to it.
// - A navigation no link started (useRouter().push, router.navigate) marks
//   every link to its URL.

const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;

function Spinner({ id }: { id: string }): ReactNode {
  const { pending } = useLinkStatus();
  return <span data-testid={`spinner-${id}`}>{pending ? "pending" : ""}</span>;
}

function PushButton(): ReactNode {
  const router = useRouter();
  return (
    <button data-testid="push" onClick={() => router.push("/items/2")}>
      push
    </button>
  );
}

function Shell(): ReactNode {
  return (
    <div>
      <nav>
        <Link to="/items/2" data-testid="link-a">
          A<Spinner id="a" />
        </Link>
        <Link to="/items/2" data-testid="link-b">
          B<Spinner id="b" />
        </Link>
      </nav>
      <PushButton />
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <Outlet />
      </Suspense>
    </div>
  );
}

function Item(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const { data } = useLoader(ItemLoader);
  return <p data-testid="page">{`${id}:${data}`}</p>;
}

function deferred(): {
  promise: Promise<string>;
  resolve: (v: string) => void;
} {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { promise, resolve };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/**
 * /items/:id holds the page being left under transition(), so a pending
 * loader keeps the navigation in flight with both links on screen.
 */
async function render() {
  return renderRoute(
    [
      { path: "/items", Component: Shell },
      { path: "/items/:id", Component: Item, transition: {} },
    ],
    { request: "/items/1", loaders: [[ItemLoader, "one"]] },
  );
}

function spinners(get: (id: string) => HTMLElement): string {
  return `a=${get("spinner-a").textContent || "idle"} b=${get("spinner-b").textContent || "idle"}`;
}

afterEach(() => {
  cleanup();
});

describe("renderRoute: useLinkStatus marks the clicked link", () => {
  it("two links to one address: a click marks only the clicked link, until its page commits", async () => {
    const { getByTestId, router } = await render();
    const item = deferred();
    router.prefetch("/items/2", { loaders: [[ItemLoader, item.promise]] });

    await act(async () => {
      fireEvent.click(getByTestId("link-a"));
    });
    await settle();
    expect(getByTestId("page").textContent).toBe("1:one");
    expect(spinners(getByTestId)).toBe("a=pending b=idle");

    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(getByTestId("page").textContent).toBe("2:two"));
    expect(spinners(getByTestId)).toBe("a=idle b=idle");
  });

  it("a click on the other link to the same address moves the mark to it", async () => {
    const { getByTestId, router } = await render();
    const item = deferred();
    router.prefetch("/items/2", { loaders: [[ItemLoader, item.promise]] });

    await act(async () => {
      fireEvent.click(getByTestId("link-a"));
    });
    await settle();
    expect(spinners(getByTestId)).toBe("a=pending b=idle");

    await act(async () => {
      fireEvent.click(getByTestId("link-b"));
    });
    await settle();
    expect(spinners(getByTestId)).toBe("a=idle b=pending");

    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(getByTestId("page").textContent).toBe("2:two"));
    expect(spinners(getByTestId)).toBe("a=idle b=idle");
  });

  it("useRouter().push, which no link started, marks every link to its URL", async () => {
    const { getByTestId, router } = await render();
    const item = deferred();
    router.prefetch("/items/2", { loaders: [[ItemLoader, item.promise]] });

    await act(async () => {
      fireEvent.click(getByTestId("push"));
    });
    await settle();
    expect(getByTestId("page").textContent).toBe("1:one");
    expect(spinners(getByTestId)).toBe("a=pending b=pending");

    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(getByTestId("page").textContent).toBe("2:two"));
    expect(spinners(getByTestId)).toBe("a=idle b=idle");
  });

  it("router.navigate(), a scripted navigation, marks every link to its URL", async () => {
    const { getByTestId, router } = await render();
    const item = deferred();

    await router.navigate("/items/2", {
      loaders: [[ItemLoader, item.promise]],
    });
    await settle();
    expect(getByTestId("page").textContent).toBe("1:one");
    expect(spinners(getByTestId)).toBe("a=pending b=pending");

    await act(async () => {
      item.resolve("two");
      await item.promise;
    });
    await waitFor(() => expect(getByTestId("page").textContent).toBe("2:two"));
    expect(spinners(getByTestId)).toBe("a=idle b=idle");
  });
});
