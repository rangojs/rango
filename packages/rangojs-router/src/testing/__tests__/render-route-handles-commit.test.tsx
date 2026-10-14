// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Profiler, Suspense, type ReactNode } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { createHandle } from "../../handle.js";
import { useHandle } from "../../browser/react/use-handle.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

/**
 * Userland: a navigation's handle values commit with its page, through
 * renderRoute's navigate() with `handles` (the response's handle stream). A
 * transition() route whose loader is pending is held; the title its layout
 * reads keeps the page being left's value until the page commits, with and
 * without a view transition.
 */

const Titles = createHandle<string, string[]>(
  (segments) => segments.flat(),
  "__test_userland_titles__",
);
const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;

let log: string[];
let stub: ReturnType<typeof installViewTransitionStub> | undefined;

const text = (id: string): string =>
  document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

function Title(): ReactNode {
  return <p data-testid="title">{useHandle(Titles).at(-1)}</p>;
}

function Shell(): ReactNode {
  return (
    <Profiler
      id="shell"
      onRender={() => log.push(`${text("title")}|${text("item")}`)}
    >
      <Title />
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <Outlet />
      </Suspense>
    </Profiler>
  );
}

function Item(): ReactNode {
  return <p data-testid="item">{useLoader(ItemLoader).data}</p>;
}

beforeEach(() => {
  log = [];
  stub = undefined;
});

afterEach(() => {
  cleanup();
  stub?.uninstall();
});

describe.each([
  { variant: "with a view transition", vt: true },
  { variant: "without a view transition", vt: false },
])("renderRoute: handle values commit with the page ($variant)", ({ vt }) => {
  it("a held navigation's title never shows over the page being left", async () => {
    if (vt) stub = installViewTransitionStub();
    const { router } = await renderRoute(
      [
        { path: "/items", Component: Shell },
        { path: "/items", Component: Item, transition: {} },
      ],
      {
        request: "/items?id=1",
        loaders: [[ItemLoader, "one"]],
        handles: [[Titles, ["Item one"]]],
      },
    );
    expect(text("title")).toBe("Item one");

    let resolve!: (item: string) => void;
    const next = new Promise<string>((r) => (resolve = r));
    await router.navigate("/items?id=2", {
      loaders: [[ItemLoader, next]],
      handles: [[Titles, ["Item two"]]],
    });
    // The handle stream has been read; React still holds the page.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(text("item")).toBe("one");
    expect(text("title")).toBe("Item one");

    await act(async () => {
      resolve("two");
      await next;
    });
    await waitFor(() => expect(text("item")).toBe("two"));
    expect(text("title")).toBe("Item two");
    expect(log).not.toContain("Item two|one");
  });
});
