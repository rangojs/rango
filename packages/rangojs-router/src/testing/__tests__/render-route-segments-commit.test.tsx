// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Profiler, Suspense, useEffect, type ReactNode } from "react";
import { act, cleanup } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { usePathname } from "../../browser/react/use-pathname.js";
import { useSegments } from "../../browser/react/use-segments.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import { renderRoute } from "../render-route.js";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";

/**
 * Userland (hook lock row: useSegments): segment ids and location cannot
 * suspend, so useSegments commits with its page, unlike a handle value, which
 * waits for the page's commit. Two quick clicks on a transition() route: the
 * first click's page is still held when the second is handed over. Layout
 * readers of usePathname and a useSegments selector, in either hook order,
 * and a page reader of the full state see segments that match the pathname in
 * every committed render and every effect.
 */

const ItemLoader = { __brand: "loader" } as unknown as LoaderDefinition<string>;

interface Seen {
  at: string;
  pathname: string;
  segments: string;
  location?: string;
}

let seen: Seen[];
let stub: ReturnType<typeof installViewTransitionStub> | undefined;

// The visible element: a revealed <Suspense> that suspends again keeps its
// content in the DOM, hidden, beside its fallback.
const visible = (id: string): HTMLElement | undefined =>
  Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
  ).find((el) => !el.closest('[style*="display: none"]'));

const READERS = ["segments-first", "pathname-first", "page"];

function useSeen(
  at: string,
  pathname: string,
  segments: string,
  location?: string,
): void {
  useEffect(() => {
    seen.push({ at: `${at} effect`, pathname, segments, location });
  }, [at, pathname, segments, location]);
}

function SegmentsFirst(): ReactNode {
  const segments = useSegments((s) => s.path.join("/"));
  const pathname = usePathname();
  useSeen("segments-first", pathname, segments);
  return (
    <nav
      data-testid="segments-first"
      data-pathname={pathname}
      data-segments={segments}
    />
  );
}

function PathnameFirst(): ReactNode {
  const pathname = usePathname();
  const segments = useSegments((s) => s.path.join("/"));
  useSeen("pathname-first", pathname, segments);
  return (
    <nav
      data-testid="pathname-first"
      data-pathname={pathname}
      data-segments={segments}
    />
  );
}

function Layout(): ReactNode {
  return (
    <Profiler
      id="layout"
      onRender={() => {
        for (const id of READERS) {
          const el = visible(id);
          if (!el) continue;
          seen.push({
            at: `${id} frame ${el.textContent}`,
            pathname: el.dataset.pathname!,
            segments: el.dataset.segments!,
            location: el.dataset.location,
          });
        }
      }}
    >
      <SegmentsFirst />
      <PathnameFirst />
      <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
        <Outlet />
      </Suspense>
    </Profiler>
  );
}

function Item(): ReactNode {
  const item = useLoader(ItemLoader).data;
  const { path, location } = useSegments();
  const pathname = usePathname();
  const segments = path.join("/");
  useSeen(`page ${item}`, pathname, segments, location.pathname);
  return (
    <p
      data-testid="page"
      data-pathname={pathname}
      data-segments={segments}
      data-location={location.pathname}
    >
      {item}
    </p>
  );
}

function deferred(): {
  promise: Promise<string>;
  resolve: (v: string) => void;
} {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });

const mismatched = (s: Seen): boolean =>
  s.segments !== s.pathname.slice(1) ||
  (s.location !== undefined && s.location !== s.pathname);

beforeEach(() => {
  seen = [];
  stub = undefined;
});

afterEach(() => {
  cleanup();
  stub?.uninstall();
});

describe.each([
  { variant: "with a view transition", vt: true },
  { variant: "without a view transition", vt: false },
])("renderRoute: useSegments commits with its page ($variant)", ({ vt }) => {
  it("two quick clicks over a held page: every render and effect sees the segments of its pathname", async () => {
    if (vt) stub = installViewTransitionStub();
    const { router } = await renderRoute(
      [
        { path: "/", Component: Layout },
        { path: "/items/:id", Component: Item, transition: {} },
      ],
      { request: "/items/1", loaders: [[ItemLoader, "one"]] },
    );
    const two = deferred();
    const three = deferred();
    await router.navigate("/items/2", {
      loaders: [[ItemLoader, two.promise]],
    });
    await tick();
    await router.navigate("/items/3", {
      loaders: [[ItemLoader, three.promise]],
    });
    await tick();
    // Both pages are held; the page being left keeps its location.
    expect(visible("page")?.textContent).toBe("one");
    expect(visible("segments-first")?.dataset.pathname).toBe("/items/1");

    await act(async () => two.resolve("two"));
    await tick();
    await act(async () => three.resolve("three"));
    await tick();
    await tick();

    expect(visible("page")?.textContent).toBe("three");
    for (const id of READERS) {
      expect(visible(id)?.dataset.segments).toBe("items/3");
      expect(
        seen.some((s) => s.at.startsWith(id) && s.pathname === "/items/3"),
      ).toBe(true);
    }
    expect(seen.filter(mismatched)).toEqual([]);
  });
});
