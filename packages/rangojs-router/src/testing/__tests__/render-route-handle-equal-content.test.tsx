// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Component,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { installViewTransitionStub } from "@shared/e2e/view-transition-stub";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Outlet } from "../../client.js";
import { createHandle, type Handle } from "../../handle.js";
import { Breadcrumbs, type BreadcrumbItem } from "../../handles/breadcrumbs.js";
import { Meta } from "../../handles/meta.js";
import { useHandle } from "../../browser/react/use-handle.js";
import { usePathname } from "../../browser/react/use-pathname.js";
import { useSegments } from "../../browser/react/use-segments.js";
import { usePushHandle } from "../../browser/react/use-push-handle.js";
import { useLoader } from "../../use-loader.js";
import type { LoaderDefinition } from "../../types.js";
import {
  renderRoute,
  type HandleSeed,
  type RenderRouteSpec,
} from "../render-route.js";

/**
 * Userland: useHandle keeps its reference while the collected value's content
 * is equal, so an effect keyed on it runs once per change, not once per
 * delivery. Every re-delivery here (an action's revalidation, a refresh, a
 * late push, a navigation and a Back/Forward) is seeded with fresh objects;
 * a crumb's `content` is a fresh host element (`<b>`) each time. The seeds do
 * not cross Flight, where a client component's type decodes as a fresh lazy
 * reference and never compares equal: handle-equal-content-flight.rsc-test
 * pins both sides through the real codec.
 *
 * Each reader logs what its effect saw, with the page's loader data at that
 * moment, so a real change is also pinned to the commit of its page.
 */

const ItemLoader = {
  __brand: "loader",
  $$id: "equal-content#ItemLoader",
} as unknown as LoaderDefinition<string>;

interface Crumb {
  label: string;
  href: string;
  content: ReactNode;
}
/** The default collect: one array per segment (`T[][]`). */
const Crumbs = createHandle<Crumb>(undefined, "__test_equal_content_crumbs__");

const crumb = (label: string, href: string): BreadcrumbItem & Crumb => ({
  label,
  href,
  content: <b className="crumb">{label}</b>,
});

/** The page's handle values for `label`, fresh objects on every call. */
function seeds(label: string): HandleSeed[] {
  return [
    [Breadcrumbs, [crumb("Home", "/")], 0],
    [Breadcrumbs, [crumb(label, "/items")], 1],
    [Crumbs, [crumb("Home", "/")], 0],
    [Crumbs, [crumb(label, "/items")], 1],
    [Meta, [{ title: "Site" }], 0],
    [Meta, [{ title: label }, { name: "description", content: label }], 1],
  ];
}

const text = (id: string): string =>
  Array.from(
    document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
  ).find((el) => !el.closest('[style*="display: none"]'))?.textContent ?? "";

/** What each reader's effect saw: `<reader>:<data on screen>`. */
let fired: string[];

function useLogged(name: string, value: unknown): void {
  useEffect(() => {
    fired.push(`${name}:${text("item")}`);
  }, [value]);
}

function FullBreadcrumbs(): null {
  useLogged("breadcrumbs", useHandle(Breadcrumbs));
  return null;
}
function SelectedBreadcrumb(): null {
  useLogged(
    "selector",
    useHandle(Breadcrumbs, (crumbs) => ({ last: crumbs.at(-1) })),
  );
  return null;
}
function DefaultCollect(): null {
  useLogged("default", useHandle(Crumbs));
  return null;
}
function MetaReader(): null {
  useLogged("meta", useHandle(Meta));
  return null;
}
/** A component that reads several hooks. */
function TrailWithPath(): ReactNode {
  const crumbs = useHandle(Breadcrumbs);
  const pathname = usePathname();
  useLogged("several", crumbs);
  return <nav data-path={pathname} />;
}

const READERS = ["breadcrumbs", "selector", "default", "meta", "several"];
const all = (data: string): string[] => READERS.map((r) => `${r}:${data}`);

function Layout(): ReactNode {
  return (
    <>
      <FullBreadcrumbs />
      <SelectedBreadcrumb />
      <DefaultCollect />
      <MetaReader />
      <TrailWithPath />
      <Suspense fallback={<p data-testid="fallback">loading</p>}>
        <Outlet />
      </Suspense>
    </>
  );
}

function Item(): ReactNode {
  return <p data-testid="item">{useLoader(ItemLoader).data}</p>;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  fired = [];
});

afterEach(() => {
  cleanup();
});

describe.each([
  { variant: "a held page (transition())", transition: {} },
  { variant: "a page that commits at once", transition: undefined },
])("renderRoute: useHandle on equal content ($variant)", ({ transition }) => {
  const routes: RenderRouteSpec[] = [
    { path: "/items", Component: Layout },
    { path: "/items", Component: Item, transition },
  ];
  const mount = async () => {
    const result = await renderRoute(routes, {
      request: "/items?id=1",
      loaders: [[ItemLoader, "one"]],
      handles: seeds("Item"),
    });
    fired = [];
    return result;
  };

  it("the first render: each reader's effect runs once", async () => {
    await renderRoute(routes, {
      request: "/items?id=1",
      loaders: [[ItemLoader, "one"]],
      handles: seeds("Item"),
    });
    expect(fired).toEqual(all("one"));
  });

  it("an action's revalidation that re-delivers equal content runs no reader's effect", async () => {
    const { router } = await mount();
    await router.action({
      loaders: [[ItemLoader, "two"]],
      handles: seeds("Item"),
    });
    expect(text("item")).toBe("two");
    expect(fired).toEqual([]);
  });

  it("an action's revalidation that changes a value: each reader's effect runs once, with the action's page", async () => {
    const { router } = await mount();
    await router.action({
      loaders: [[ItemLoader, "two"]],
      handles: seeds("Renamed"),
    });
    expect(fired).toEqual(all("two"));
  });

  it("a refresh that re-delivers equal content runs no reader's effect", async () => {
    const { router } = await mount();
    await router.refresh({ handles: seeds("Item") });
    expect(fired).toEqual([]);
  });

  it("a late push of equal content runs no reader's effect", async () => {
    const { router } = await mount();
    await router.pushLateHandles(seeds("Item"));
    expect(fired).toEqual([]);
  });

  it("a navigation to a page with equal content, then Back and Forward, runs no reader's effect", async () => {
    const { router } = await mount();
    await router.navigate("/items?id=2", {
      loaders: [[ItemLoader, "two"]],
      handles: seeds("Item"),
      state: [],
    });
    expect(text("item")).toBe("two");
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(text("item")).toBe("one");
    await act(async () => {
      window.history.forward();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(text("item")).toBe("two");
    expect(fired).toEqual([]);
  });

  it("a navigation that changes a value: the new value commits with its page, and Back brings the old one with its page", async () => {
    const { router } = await mount();
    // A held page waits for its loader; the page being left keeps its values.
    const next = deferred<string>();
    await router.navigate("/items?id=2", {
      loaders: [[ItemLoader, transition ? next.promise : "two"]],
      handles: seeds("Other"),
      state: [],
    });
    if (transition) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(text("item")).toBe("one");
      expect(fired).toEqual([]);
      await act(async () => {
        next.resolve("two");
        await next.promise;
      });
    }
    await waitFor(() => expect(text("item")).toBe("two"));
    expect(fired).toEqual(all("two"));
    fired = [];
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(text("item")).toBe("one");
    expect(fired).toEqual(all("one"));
  });
});

describe("renderRoute: useHandle on equal content, a held page", () => {
  it("values that change while the page is held and come back before it commits: no reader's effect runs", async () => {
    const { router } = await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: Item, transition: {} },
      ],
      {
        request: "/items?id=1",
        loaders: [[ItemLoader, "one"]],
        handles: seeds("Item"),
      },
    );
    fired = [];
    const held = deferred<string>();
    await router.navigate("/items?id=2", {
      loaders: [[ItemLoader, held.promise]],
      handles: seeds("Other"),
      state: [],
    });
    // A late push for the held page brings back what is on screen.
    await router.pushLateHandles(seeds("Item"));
    expect(text("item")).toBe("one");
    await act(async () => {
      held.resolve("two");
      await held.promise;
    });
    await waitFor(() => expect(text("item")).toBe("two"));
    expect(fired).toEqual([]);
  });
});

describe("renderRoute: useHandle on a pending crumb's content", () => {
  it("the same content promise keeps the reference; a fresh one is a change", async () => {
    const pending = new Promise<string>(() => {});
    const trail = (content: Promise<string>): HandleSeed[] => [
      [Breadcrumbs, [{ label: "Item", href: "/items", content }]],
    ];
    const { router } = await renderRoute(
      [
        { path: "/items", Component: Layout },
        { path: "/items", Component: Item },
      ],
      {
        request: "/items",
        loaders: [[ItemLoader, "one"]],
        handles: trail(pending),
      },
    );
    fired = [];
    await router.action({ handles: trail(pending) });
    expect(fired.filter((f) => f.startsWith("breadcrumbs"))).toEqual([]);
    await router.action({ handles: trail(new Promise<string>(() => {})) });
    expect(fired.filter((f) => f.startsWith("breadcrumbs"))).toEqual([
      "breadcrumbs:one",
    ]);
  });
});

describe("renderRoute: useHandle on equal content, client pushes", () => {
  it("a client push that changes nothing a reader collects runs no reader's effect", async () => {
    // The layout's client title sits under the route's server title: Meta
    // keeps the last title, so the collected value does not move.
    function LayoutTitle(): ReactNode {
      const [n, setN] = useState(0);
      usePushHandle(Meta)({ title: `Layout ${n}` });
      return (
        <button data-testid="bump" onClick={() => setN((v) => v + 1)}>
          bump
        </button>
      );
    }
    function PushingLayout(): ReactNode {
      return (
        <>
          <MetaReader />
          <LayoutTitle />
          <Outlet />
        </>
      );
    }
    const { getByTestId } = await renderRoute(
      [
        { path: "/items", Component: PushingLayout },
        { path: "/items", Component: Item },
      ],
      {
        request: "/items",
        loaders: [[ItemLoader, "one"]],
        handles: [[Meta as Handle<unknown, unknown>, [{ title: "Item" }], 1]],
      },
    );
    fired = [];
    await act(async () => fireEvent.click(getByTestId("bump")));
    await act(async () => fireEvent.click(getByTestId("bump")));
    expect(fired).toEqual([]);
  });
});

/**
 * The same rule decides a new value: a URL compares by identity and a date by
 * time, so a selector returning one moves when it changes. One level of
 * own keys (a URL and a date have none) made every two of them equal.
 */
describe("renderRoute: a selector returning a URL or a date", () => {
  it("useSegments selecting the location moves with a navigation", async () => {
    function Location(): ReactNode {
      return (
        <p data-testid="search">{useSegments((s) => s.location).search}</p>
      );
    }
    const { router } = await renderRoute(
      [{ path: "/items", Component: Location }],
      { request: "/items?id=1" },
    );
    await router.navigate("/items?id=2");
    expect(text("search")).toBe("?id=2");
  });

  it("useHandle selecting a date moves when the date does", async () => {
    const Updated = createHandle<Date, Date | undefined>(
      (segments) => segments.flat().at(-1),
      "__test_equal_content_updated__",
    );
    function Stamp(): ReactNode {
      const at = useHandle(Updated, (date) => date);
      return <p data-testid="stamp">{at?.getTime()}</p>;
    }
    const { router } = await renderRoute(
      [{ path: "/items", Component: Stamp }],
      { request: "/items", handles: [[Updated, [new Date(1)]]] },
    );
    expect(text("stamp")).toBe("1");
    await router.action({ handles: [[Updated, [new Date(2)]]] });
    expect(text("stamp")).toBe("2");
  });
});

/** The page fails into this boundary, which shows as the page (`item`). */
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

function BoundaryLayout(): ReactNode {
  return (
    <>
      <FullBreadcrumbs />
      <SelectedBreadcrumb />
      <DefaultCollect />
      <MetaReader />
      <TrailWithPath />
      <Boundary>
        <Suspense fallback={<p data-testid="fallback">loading</p>}>
          <Outlet />
        </Suspense>
      </Boundary>
    </>
  );
}

/**
 * How a held navigation ends: its response stream ends first, a newer held
 * navigation takes over, a newer one is aborted before its response, or the
 * page fails. Each re-delivers content equal to the page on screen (no
 * reader's effect runs) or changes it (each runs once, with the page that
 * commits). A newer urgent navigation over a held one is left out: it commits
 * the held one's values for one commit on its way, which is tracked apart.
 */
describe.each([
  { variant: "with a view transition", vt: true },
  { variant: "without a view transition", vt: false },
])(
  "renderRoute: useHandle on a held navigation's endings ($variant)",
  ({ vt }) => {
    let stub: ReturnType<typeof installViewTransitionStub> | undefined;
    afterEach(() => {
      if (vt) expect(stub!.started()).toBeGreaterThan(0);
      stub?.uninstall();
      stub = undefined;
    });
    const mount = async () => {
      if (vt) stub = installViewTransitionStub();
      const result = await renderRoute(
        [
          { path: "/items", Component: BoundaryLayout },
          { path: "/items", Component: Item, transition: {} },
        ],
        {
          request: "/items?id=1",
          loaders: [[ItemLoader, "one"]],
          handles: seeds("Item"),
        },
      );
      fired = [];
      return result;
    };
    const settle = async (page: { promise: Promise<string> }) => {
      await act(async () => {
        await page.promise.catch(() => {});
        await new Promise((r) => setTimeout(r, 10));
      });
    };

    it.each([
      { content: "equal", label: "Item", expected: [] as string[] },
      { content: "changed", label: "Other", expected: all("two") },
    ])(
      "the response stream ends before the page commits ($content content)",
      async ({ label, expected }) => {
        const { router } = await mount();
        const page = deferred<string>();
        const tail = deferred<void>();
        await router.navigate("/items?id=2", {
          loaders: [[ItemLoader, page.promise]],
          handles: seeds(label),
          streamUntil: tail.promise,
        });
        await act(async () => tail.resolve());
        expect(text("item")).toBe("one");
        expect(fired).toEqual([]);
        page.resolve("two");
        await settle(page);
        await waitFor(() => expect(text("item")).toBe("two"));
        expect(fired).toEqual(expected);
      },
    );

    it.each([
      { content: "equal", label: "Item", expected: [] as string[] },
      { content: "changed", label: "Renamed", expected: all("three") },
    ])(
      "a newer held navigation takes over a held one ($content content to the page on screen)",
      async ({ label, expected }) => {
        const { router } = await mount();
        const two = deferred<string>();
        await router.navigate("/items?id=2", {
          loaders: [[ItemLoader, two.promise]],
          handles: seeds("Other"),
        });
        const three = deferred<string>();
        await router.navigate("/items?id=3", {
          loaders: [[ItemLoader, three.promise]],
          handles: seeds(label),
        });
        expect(text("item")).toBe("one");
        three.resolve("three");
        await settle(three);
        await waitFor(() => expect(text("item")).toBe("three"));
        // The abandoned page's late response is ignored.
        two.resolve("two");
        await settle(two);
        expect(text("item")).toBe("three");
        expect(fired).toEqual(expected);
      },
    );

    it("a navigation a newer one aborts before its response: its values never reach a reader, and equal content after it runs no reader's effect", async () => {
      const { router } = await mount();
      // Its response would arrive a task later; the newer navigation aborts it
      // first, so it commits nothing.
      const aborted = router.navigate("/items?id=2", {
        loaders: [[ItemLoader, "two"]],
        handles: seeds("Other"),
        streamUntil: new Promise(() => {}),
      });
      await router.navigate("/items?id=3", {
        loaders: [[ItemLoader, "three"]],
        handles: seeds("Item"),
      });
      await aborted;
      await waitFor(() => expect(text("item")).toBe("three"));
      expect(fired).toEqual([]);
    });

    it.each([
      { content: "equal", label: "Item", expected: [] as string[] },
      { content: "changed", label: "Other", expected: all("failed") },
    ])(
      "a held page that fails into an error boundary ($content content)",
      async ({ label, expected }) => {
        const { router } = await mount();
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const two = deferred<string>();
          two.promise.catch(() => {});
          await router.navigate("/items?id=2", {
            loaders: [[ItemLoader, two.promise]],
            handles: seeds(label),
          });
          expect(fired).toEqual([]);
          await act(async () => two.reject(new Error("down")));
          await settle(two);
          await waitFor(() => expect(text("item")).toBe("failed"));
          expect(fired).toEqual(expected);
        } finally {
          spy.mockRestore();
        }
      },
    );
  },
);

describe("renderRoute: useHandle across a stale prefetch's revalidation", () => {
  // A click on a prefetch an action made stale commits it at once, then
  // revalidates in the lane a Back to a stale history entry uses
  // (revalidateInBackground). renderRoute models the lane from the click; a
  // Back onto a stale entry and its own revalidation are not modeled.
  it.each([
    { variant: "a held page (transition())", transition: {} },
    { variant: "a page that commits at once", transition: undefined },
  ])(
    "$variant: each reader's effect runs once, with the click's page, and not again on the revalidation",
    async ({ transition }) => {
      const { router } = await renderRoute(
        [
          { path: "/items", Component: Layout },
          { path: "/items", Component: Item, transition },
        ],
        {
          request: "/items?id=1",
          loaders: [[ItemLoader, "one"]],
          handles: seeds("Item"),
        },
      );
      router.prefetch("/items?id=2", { loaders: [[ItemLoader, "two"]] });
      await router.action({ loaders: [[ItemLoader, "fresh"]] });
      fired = [];
      await router.navigate("/items?id=2", { handles: seeds("Other") });
      await waitFor(() => expect(router.revalidations()).toHaveLength(1));
      await waitFor(() => expect(text("item")).toBe("fresh"));
      expect(fired).toEqual(all("two"));
    },
  );
});

describe("renderRoute: a useSegments() full-state reader beside useHandle readers", () => {
  function Segments(): null {
    useLogged("segments", useSegments());
    return null;
  }
  function SegmentsLayout(): ReactNode {
    return (
      <>
        <Segments />
        <FullBreadcrumbs />
        <Suspense fallback={<p data-testid="fallback">loading</p>}>
          <Outlet />
        </Suspense>
      </>
    );
  }
  it.each([
    { variant: "a held page (transition())", transition: {} },
    { variant: "a page that commits at once", transition: undefined },
  ])(
    "$variant: equal re-deliveries run neither effect; a navigation runs each once, with its page",
    async ({ transition }) => {
      const { router } = await renderRoute(
        [
          { path: "/items", Component: SegmentsLayout },
          { path: "/items", Component: Item, transition },
        ],
        {
          request: "/items?id=1",
          loaders: [[ItemLoader, "one"]],
          handles: seeds("Item"),
        },
      );
      fired = [];
      await router.action({
        loaders: [[ItemLoader, "two"]],
        handles: seeds("Item"),
      });
      await router.pushLateHandles(seeds("Item"));
      expect(text("item")).toBe("two");
      expect(fired).toEqual([]);
      await router.navigate("/items?id=3", {
        loaders: [[ItemLoader, "three"]],
        handles: seeds("Other"),
        state: [],
      });
      await waitFor(() => expect(text("item")).toBe("three"));
      expect(fired).toEqual(["segments:three", "breadcrumbs:three"]);
    },
  );
});
