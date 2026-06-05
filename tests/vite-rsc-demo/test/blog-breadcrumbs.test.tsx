// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { collectHandle } from "@rangojs/router/testing";
import { renderRoute } from "@rangojs/router/testing/dom";
import { BreadcrumbNav } from "../src/components/BreadcrumbNav.js";
import {
  Breadcrumbs,
  type BreadcrumbItem,
} from "../src/handles/breadcrumbs.js";

afterEach(cleanup);

/**
 * An ALREADY-SETTLED promise carrying React's tracking fields (`status`/`value`).
 * `use()` reads those synchronously and returns the value without suspending —
 * representing streamed content that has already arrived.
 *
 * Why not a plain `Promise.resolve(node)`? In a bare RTL/happy-dom test, React's
 * Suspense RETRY after a pending `use()` promise resolves does NOT flush (the
 * render isn't inside an awaited `act`, and renderRoute does its render
 * internally). So a raw resolving promise stays stuck on the fallback. The
 * resolved-content transition is an e2e concern; here a settled promise gives a
 * deterministic "content arrived" state.
 */
function settled(node: ReactNode): Promise<ReactNode> {
  const p = Promise.resolve(node) as Promise<ReactNode> & {
    status: "fulfilled";
    value: ReactNode;
  };
  p.status = "fulfilled";
  p.value = node;
  return p;
}

// The blog handlers (urls/blog.handlers.tsx) push breadcrumb items whose
// `content` is a Promise<ReactNode> that streams in (e.g. an author's post count
// after 2s, a post's published date after 3s). BreadcrumbNav renders that streamed
// content inside a <Suspense fallback={<skeleton/>}> via React `use()`. These
// tests cover the handle accumulator AND the streaming render of that content.

describe("blog Breadcrumbs handle — accumulation (collectHandle)", () => {
  it("flattens blog breadcrumb items parent -> child and preserves the streamed content reference", () => {
    const blogRoot: BreadcrumbItem = { label: "Blog", href: "/blog" };
    // The streamed bit a blog handler attaches (here resolved synchronously).
    const streamed = Promise.resolve(<span>(3 posts)</span>);
    const author: BreadcrumbItem = {
      label: "Ada Lovelace",
      href: "/blog/author/ada",
      content: streamed,
    };

    const result = collectHandle(Breadcrumbs, [[blogRoot], [author]]);

    expect(result).toEqual([blogRoot, author]);
    // The Promise<ReactNode> survives the collect by reference (it is rendered,
    // not serialized, so the accumulator must not drop or copy it).
    expect(result[1].content).toBe(streamed);
  });
});

describe("BreadcrumbNav — streamed breadcrumb content", () => {
  it("renders the static labels and the arrived (settled) streamed content", async () => {
    const { getByText } = await renderRoute(
      [{ path: "/blog/author/:authorSlug", Component: BreadcrumbNav }],
      {
        initialUrl: "/blog/author/ada",
        handles: [
          [
            Breadcrumbs,
            [
              { label: "Blog", href: "/blog" },
              {
                label: "Ada Lovelace",
                href: "/blog/author/ada",
                content: settled(<span>(3 posts)</span>),
              },
            ],
          ],
        ],
      },
    );

    // Static labels render (parent is a Link, leaf is a span)...
    expect(getByText("Blog")).toBeTruthy();
    expect(getByText("Ada Lovelace")).toBeTruthy();
    // ...and the streamed content (already arrived) renders via use() inline.
    expect(getByText("(3 posts)")).toBeTruthy();
  });

  it("shows the Suspense fallback (skeleton) while the streamed content is still pending", async () => {
    // A pending promise: BreadcrumbNav's <Suspense> shows the skeleton fallback.
    const pending = new Promise<ReactNode>(() => {});

    const { getByText, queryByText, container } = await renderRoute(
      [{ path: "/blog/:slug", Component: BreadcrumbNav }],
      {
        initialUrl: "/blog/hello-world",
        handles: [
          [
            Breadcrumbs,
            [
              {
                label: "Hello World",
                href: "/blog/hello-world",
                content: pending,
              },
            ],
          ],
        ],
      },
    );

    // Label is present immediately; the streamed content is suspended (absent),
    // and the skeleton fallback is mounted in its place.
    expect(getByText("Hello World")).toBeTruthy();
    expect(queryByText("(published today)")).toBeNull();
    const skeleton = container.querySelector(
      'span[style*="pulse"]',
    ) as HTMLElement | null;
    expect(skeleton).not.toBeNull();
  });

  it("renders nothing when no breadcrumbs are seeded", async () => {
    const { container } = await renderRoute(
      [{ path: "/blog/:slug", Component: BreadcrumbNav }],
      { initialUrl: "/blog/hello-world" },
    );
    expect(container.querySelector('nav[aria-label="Breadcrumb"]')).toBeNull();
  });
});
