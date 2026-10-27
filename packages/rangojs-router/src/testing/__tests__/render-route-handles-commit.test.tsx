// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Component, Profiler, Suspense, use, type ReactNode } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { createHandle } from "../../handle.js";
import { useHandle } from "../../browser/react/use-handle.js";
import { usePathname } from "../../browser/react/use-pathname.js";
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

// The visible element: a revealed <Suspense> that suspends again keeps its
// content in the DOM, hidden, beside its fallback.
const text = (id: string): string =>
  Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
  ).find((el) => !el.closest('[style*="display: none"]'))?.textContent ?? "";

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

/**
 * Userland (hook lock row HD4): the breadcrumb a consumer writes, its last
 * crumb's `content` a promise read with use() in a <Suspense> that is already
 * revealed. Two quick clicks on transition() routes: the first click's page is
 * still held when the second is handed over. The second page shows when its
 * response arrives and only the crumb's boundary waits for its content
 * (handle-and-actions.md:56-58), whichever crumb is pending and whatever the
 * reader's shape. The first click's crumb never shows: its page never did.
 */
interface Crumb {
  label: string;
  content: Promise<string>;
}
const Crumbs = createHandle<Crumb, Crumb[]>(
  (segments) => segments.flat(),
  "__test_userland_crumbs__",
);

const settled = (value: string): Promise<string> =>
  Object.assign(Promise.resolve(value), { status: "fulfilled", value });

function deferred(): {
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function CrumbContent({ content }: { content: Promise<string> }): ReactNode {
  return use(content);
}

function Crumb({ crumb }: { crumb: Crumb | undefined }): ReactNode {
  return (
    <>
      <i data-testid="crumb">{crumb?.label}</i>
      <Suspense fallback={<i data-testid="content">pending</i>}>
        <i data-testid="content">
          {crumb ? <CrumbContent content={crumb.content} /> : null}
        </i>
      </Suspense>
    </>
  );
}

/** The last crumb, marked with the current path. */
function TrailWithPath(): ReactNode {
  const last = useHandle(Crumbs).at(-1);
  const pathname = usePathname();
  return (
    <nav data-path={pathname}>
      <Crumb crumb={last} />
    </nav>
  );
}

function TrailFull(): ReactNode {
  return <Crumb crumb={useHandle(Crumbs).at(-1)} />;
}

function TrailSelector(): ReactNode {
  return <Crumb crumb={useHandle(Crumbs, (crumbs) => crumbs.at(-1))} />;
}

const readers = [
  { reader: "a reader of several hooks", Trail: TrailWithPath },
  { reader: "a full-state reader", Trail: TrailFull },
  { reader: "a selector reader", Trail: TrailSelector },
];

const tick = (): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });

describe.each(
  readers.flatMap((r) => [
    { ...r, variant: "with a view transition", vt: true },
    { ...r, variant: "without a view transition", vt: false },
  ]),
)(
  "renderRoute: a crumb's pending content never holds the page ($reader, $variant)",
  ({ Trail, vt }) => {
    function TrailShell(): ReactNode {
      return (
        <Profiler
          id="trail"
          onRender={() =>
            log.push(`${text("crumb")}|${text("content")}|${text("item")}`)
          }
        >
          <Trail />
          <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
            <Outlet />
          </Suspense>
        </Profiler>
      );
    }

    async function twoClicks(second: Promise<string>, first: Promise<string>) {
      if (vt) stub = installViewTransitionStub();
      const { router } = await renderRoute(
        [
          { path: "/", Component: TrailShell },
          { path: "/items/:id", Component: Item, transition: {} },
        ],
        {
          request: "/items/1",
          loaders: [[ItemLoader, "one"]],
          handles: [[Crumbs, [{ label: "one", content: settled("c1") }]]],
        },
      );
      const two = deferred();
      const three = deferred();
      await router.navigate("/items/2", {
        loaders: [[ItemLoader, two.promise]],
        handles: [[Crumbs, [{ label: "two", content: first }]]],
      });
      await tick();
      await router.navigate("/items/3", {
        loaders: [[ItemLoader, three.promise]],
        handles: [[Crumbs, [{ label: "three", content: second }]]],
      });
      await tick();
      // Both pages are held; the page being left keeps its crumb.
      expect(text("item")).toBe("one");
      expect(text("crumb")).toBe("one");

      await act(async () => two.resolve("two"));
      await tick();
      await act(async () => three.resolve("three"));
      await tick();
      await tick();
    }

    it("the second click's crumb content pending: the page shows, only the crumb waits", async () => {
      const content = deferred();
      await twoClicks(content.promise, settled("c2"));

      expect(text("item")).toBe("three");
      expect(text("crumb")).toBe("three");
      expect(text("content")).toBe("pending");

      await act(async () => content.resolve("c3"));
      await tick();
      expect(text("content")).toBe("c3");
      // No crumb of a destination over the page being left.
      expect(
        log.filter((l) => l.endsWith("|one") && l !== "one|c1|one"),
      ).toEqual([]);
      expect(log.filter((l) => l.startsWith("two|"))).toEqual([]);
    });

    it("the first click's crumb content pending: it holds neither page", async () => {
      await twoClicks(settled("c3"), deferred().promise);

      expect(text("item")).toBe("three");
      expect(text("crumb")).toBe("three");
      expect(text("content")).toBe("c3");
      expect(log.filter((l) => l.startsWith("two|"))).toEqual([]);
    });
  },
);

/**
 * Userland (hook lock rows HD13 and the abort/failure rows): a page React
 * holds in a transition has a handle value that waits for its commit. When the
 * navigation does not commit as a page (a newer one takes over, or the page
 * fails into an error boundary), the reader never shows the value of a page
 * that is not on screen and settles on the page that is.
 */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? (
      <p data-testid="item">failed</p>
    ) : (
      this.props.children
    );
  }
}

describe.each([
  { variant: "with a view transition", vt: true },
  { variant: "without a view transition", vt: false },
])(
  "renderRoute: handle values of a held page that does not show ($variant)",
  ({ vt }) => {
    function Held(): ReactNode {
      return (
        <Profiler
          id="held"
          onRender={() => log.push(`${text("title")}|${text("item")}`)}
        >
          <Title />
          <Boundary>
            <Suspense fallback={<p data-testid="skeleton">skeleton</p>}>
              <Outlet />
            </Suspense>
          </Boundary>
        </Profiler>
      );
    }

    async function mountHeld() {
      if (vt) stub = installViewTransitionStub();
      return renderRoute(
        [
          { path: "/", Component: Held },
          { path: "/items/:id", Component: Item, transition: {} },
        ],
        {
          request: "/items/1",
          loaders: [[ItemLoader, "one"]],
          handles: [[Titles, ["Item one"]]],
        },
      );
    }

    it("a newer navigation takes over a held page: the reader shows the newer page's value, never the held page's", async () => {
      const { router } = await mountHeld();
      const two = deferred();
      await router.navigate("/items/2", {
        loaders: [[ItemLoader, two.promise]],
        handles: [[Titles, ["Item two"]]],
      });
      await tick();
      // Page two is held with its value waiting.
      expect(text("item")).toBe("one");
      expect(text("title")).toBe("Item one");

      await act(async () => {
        await router.navigate("/items/3", {
          transition: false,
          loaders: [[ItemLoader, "three"]],
          handles: [[Titles, ["Item three"]]],
        });
      });
      await tick();
      expect(text("item")).toBe("three");
      expect(text("title")).toBe("Item three");

      // The held page's response arrives late and is ignored.
      await act(async () => two.resolve("two"));
      await tick();
      expect(text("item")).toBe("three");
      expect(text("title")).toBe("Item three");
      expect(log.filter((l) => l === "Item two|one")).toEqual([]);
      expect(log.filter((l) => l === "Item three|one")).toEqual([]);
    });

    it("a held page that fails into an error boundary: the reader shows the failed page's value only with it", async () => {
      const { router } = await mountHeld();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const two = deferred();
        await router.navigate("/items/2", {
          loaders: [[ItemLoader, two.promise]],
          handles: [[Titles, ["Item two"]]],
        });
        await tick();
        expect(text("item")).toBe("one");
        expect(text("title")).toBe("Item one");

        two.promise.catch(() => {});
        await act(async () => two.reject(new Error("down")));
        await tick();
        // The page on screen is the error boundary's, at the new location.
        expect(text("item")).toBe("failed");
        expect(text("title")).toBe("Item two");
        expect(log.filter((l) => l === "Item two|one")).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  },
);
