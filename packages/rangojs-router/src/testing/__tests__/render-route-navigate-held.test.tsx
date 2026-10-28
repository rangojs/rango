// @vitest-environment happy-dom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { Suspense, type ReactNode } from "react";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { Link, Outlet, useNavigation, useParams } from "../../client.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";

// Consumer contract: router.navigate() shows its page while React holds a
// transition() page, with or without the test's own act(), and prints no
// act() warning.

const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;

const pathOf = (url: string | null): string =>
  url ? new URL(url).pathname : "-";

function Shell(): ReactNode {
  const nav = useNavigation(
    (n) => `${n.state} ${n.isStreaming} ${pathOf(n.pendingUrl)}`,
  );
  return (
    <>
      <i data-testid="nav">{nav}</i>
      <Link to="/items/3" transition={false} data-testid="urgent">
        3
      </Link>
      <Suspense fallback={<p>skeleton</p>}>
        <Outlet />
      </Suspense>
    </>
  );
}

function Item(): ReactNode {
  const { id } = useParams();
  const { data } = useLoader(ItemLoader);
  return <p data-testid="item">{`${id}:${data}`}</p>;
}

function deferred<T = string>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const task = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const text = (id: string): string | null | undefined =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent;

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error");
});

afterEach(() => {
  const actWarnings = consoleError.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => /\bact\b/.test(message));
  consoleError.mockRestore();
  cleanup();
  expect(actWarnings).toEqual([]);
});

/** /items/1 on screen; React holds /items/2, whose loader never answers. */
async function holdPage2(): Promise<Awaited<ReturnType<typeof renderRoute>>> {
  const mounted = await renderRoute(
    [
      { path: "/items/:id", Component: Shell },
      { path: "/items/:id", Component: Item, transition: {} },
    ],
    { request: "/items/1", loaders: [[ItemLoader, "1"]] },
  );
  await mounted.router.navigate("/items/2", {
    loaders: [[ItemLoader, new Promise<string>(() => {})]],
  });
  await task();
  expect(text("item")).toBe("1:1");
  expect(text("nav")).toBe("loading true /items/2");
  return mounted;
}

describe("renderRoute: router.navigate() while React holds a transition() page", () => {
  it.each([
    ["without act()", (call: () => Promise<void>) => call()],
    [
      "inside the test's own async act()",
      (call: () => Promise<void>) => act(call),
    ],
  ])("an urgent navigation shows its page %s", async (_, run) => {
    const { router } = await holdPage2();

    await run(() =>
      router.navigate("/items/3", {
        loaders: [[ItemLoader, "3"]],
        transition: false,
      }),
    );

    expect(text("item")).toBe("3:3");
    expect(text("nav")).toBe("idle false -");
  });

  it("a streamUntil navigation shows its page, streaming until the promise settles", async () => {
    const { router } = await holdPage2();
    const tail = deferred<void>();

    await router.navigate("/items/3", {
      loaders: [[ItemLoader, "3"]],
      transition: false,
      streamUntil: tail.promise,
    });

    expect(text("item")).toBe("3:3");
    expect(text("nav")).toBe("idle true -");

    tail.resolve();
    await task();
    expect(text("nav")).toBe("idle false -");
  });

  it("a held navigation keeps the page on screen, then commits with idle", async () => {
    const { router } = await holdPage2();
    const page3 = deferred();

    await router.navigate("/items/3", {
      loaders: [[ItemLoader, page3.promise]],
    });
    await task();
    expect(text("item")).toBe("1:1");
    expect(text("nav")).toBe("loading true /items/3");

    await act(async () => {
      page3.resolve("3");
      await page3.promise;
    });
    expect(text("item")).toBe("3:3");
    expect(text("nav")).toBe("idle false -");
  });

  it("a <Link> click over the held page shows the clicked page", async () => {
    await holdPage2();

    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="urgent"]')!);
    });
    await task();

    expect(text("item")).toBe("3:1");
    expect(text("nav")).toBe("idle false -");
  });
});
