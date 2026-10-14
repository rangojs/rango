// @vitest-environment happy-dom
// A loader that throws while it re-runs in a server action's revalidation
// (dc-t28), or whose settled entry a fully-prefetched click, a back/forward
// restore or a cached re-render commits (forceAwait, dc-t65), throws in place
// at its useLoader read, as on a navigation: the nearest boundary to the read
// catches it, state outside that boundary survives, and a later rerun that
// succeeds brings the reader back. Real React over renderSegments' settled
// client lanes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  Component,
  createElement,
  useEffect,
  useState,
  type ReactNode,
} from "react";
// LoaderRedirect navigates; a marker stands in for it here.
vi.mock("../loader-redirect.js", () => ({
  LoaderRedirect: ({ to }: { to: string }) =>
    createElement("p", { "data-testid": "redirecting" }, to),
}));

import { renderSegments } from "../segment-system.js";
import { useLoader } from "../use-loader.js";
import { Outlet } from "../client.js";
import type { LoaderDefinition, ResolvedSegment } from "../types.js";

const Stock = { $$id: "stock" } as unknown as LoaderDefinition<{ n: number }>;

function Reader() {
  const { data } = useLoader(Stock);
  return <p data-testid="reader">stock:{data.n}</p>;
}

class AppBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <p data-testid="app-boundary">{(this.state.error as Error).message}</p>
      );
    }
    return this.props.children;
  }
}

let routeMounts = 0;
function RouteBody({ appBoundary }: { appBoundary: boolean }) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    routeMounts++;
  }, []);
  return (
    <section>
      <input
        data-testid="field"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      {appBoundary ? (
        <AppBoundary>
          <Reader />
        </AppBoundary>
      ) : (
        <Reader />
      )}
    </section>
  );
}

const failed = (fallback: ReactNode = null) => ({
  __loaderResult: true,
  ok: false,
  error: { message: "stock service unavailable", name: "Error" },
  fallback,
});
const ok = (n: number) => ({ __loaderResult: true, ok: true, data: { n } });
const dslFallback = <p data-testid="dsl-fallback">errorBoundary()</p>;

function segments(opts: {
  entry: unknown;
  loading?: boolean;
  clientGroup?: string;
  appBoundary?: boolean;
  routeId?: string;
}): ResolvedSegment[] {
  const routeId = opts.routeId ?? "L0R0";
  return [
    {
      id: "L0",
      type: "layout",
      namespace: "",
      index: 0,
      component: createElement(
        "div",
        { "data-testid": "layout" },
        createElement(Outlet),
      ),
    } as ResolvedSegment,
    {
      id: routeId,
      type: "route",
      namespace: "",
      index: 0,
      component: createElement(RouteBody, {
        appBoundary: opts.appBoundary ?? true,
      }),
      ...(opts.loading
        ? { loading: createElement("p", { "data-testid": "skeleton" }, "…") }
        : {}),
      ...(opts.clientGroup ? { clientGroup: opts.clientGroup } : {}),
    } as ResolvedSegment,
    {
      id: `${routeId}D0.stock`,
      type: "loader",
      namespace: "",
      index: 0,
      loaderId: "stock",
      loaderData: Promise.resolve(opts.entry),
    } as ResolvedSegment,
  ];
}

let setTree!: (tree: ReactNode) => void;
function Host({ initial }: { initial: ReactNode }) {
  const [tree, set] = useState(initial);
  setTree = set;
  return <>{tree}</>;
}

async function mount(segs: ResolvedSegment[]) {
  const tree = await renderSegments(segs);
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<Host initial={tree} />);
  });
  return result;
}

// Every client lane that settles loader data before its commit.
const LANES = [
  ["action", { isAction: true }],
  ["forceAwait", { forceAwait: true }],
] as const;
let laneOptions: { isAction?: boolean; forceAwait?: boolean } = {};

async function action(segs: ResolvedSegment[]) {
  const tree = await renderSegments(segs, laneOptions);
  await act(async () => setTree(tree));
}

async function type(result: ReturnType<typeof render>, value: string) {
  const field = result.getByTestId("field") as HTMLInputElement;
  const { fireEvent } = await import("@testing-library/react");
  await act(async () => {
    fireEvent.change(field, { target: { value } });
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  routeMounts = 0;
});

describe.each(LANES)(
  "%s lane: a loader that throws throws at its read",
  (_, options) => {
    beforeEach(() => {
      laneOptions = options;
    });

    for (const [lane, opts] of [
      ["urls() route without loading()", {}],
      ["urls() route with loading()", { loading: true }],
      ["clientUrls() group route", { clientGroup: "g" }],
    ] as const) {
      it(`the app's boundary at the read catches it; the route keeps its state (${lane})`, async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const result = await mount(segments({ entry: ok(1), ...opts }));
        expect(result.getByTestId("reader").textContent).toBe("stock:1");
        await type(result, "typed");
        const field = result.getByTestId("field");

        await action(segments({ entry: failed(), ...opts }));
        expect(result.getByTestId("app-boundary").textContent).toBe(
          "stock service unavailable",
        );
        expect(result.getByTestId("field")).toBe(field);
        expect((field as HTMLInputElement).value).toBe("typed");
        expect(result.getByTestId("layout")).toBeTruthy();
        expect(routeMounts).toBe(1);
      });
    }

    it("the app's boundary nearer the read wins over an errorBoundary() fallback, as on a navigation", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await mount(segments({ entry: ok(1) }));
      await action(segments({ entry: failed(dslFallback) }));
      expect(result.getByTestId("app-boundary")).toBeTruthy();
      expect(result.queryByTestId("dsl-fallback")).toBeNull();
    });

    it("with no app boundary, the errorBoundary() fallback replaces the segment, and the layout stays", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await mount(
        segments({ entry: ok(1), appBoundary: false }),
      );
      const layout = result.getByTestId("layout");
      await action(
        segments({ entry: failed(dslFallback), appBoundary: false }),
      );
      expect(result.getByTestId("dsl-fallback")).toBeTruthy();
      expect(result.queryByTestId("reader")).toBeNull();
      expect(result.getByTestId("layout")).toBe(layout);
    });

    it("a later action whose rerun succeeds clears the errorBoundary() fallback", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await mount(
        segments({ entry: ok(1), appBoundary: false }),
      );
      await action(
        segments({ entry: failed(dslFallback), appBoundary: false }),
      );
      expect(result.getByTestId("dsl-fallback")).toBeTruthy();

      await action(segments({ entry: ok(2), appBoundary: false }));
      expect(result.queryByTestId("dsl-fallback")).toBeNull();
      expect(result.getByTestId("reader").textContent).toBe("stock:2");
    });

    it("an errorBoundary() fallback a navigation showed clears after an action whose rerun succeeds", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await mount(
        segments({ entry: failed(dslFallback), appBoundary: false }),
      );
      expect(result.getByTestId("dsl-fallback")).toBeTruthy();

      await action(segments({ entry: ok(3), appBoundary: false }));
      expect(result.queryByTestId("dsl-fallback")).toBeNull();
      expect(result.getByTestId("reader").textContent).toBe("stock:3");
    });

    it("a tree that did not re-run the failed loader keeps its fallback", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const segs = segments({ entry: failed(dslFallback), appBoundary: false });
      const result = await mount(segs);
      // Same loader segment (held): its data is the failure it showed.
      await action([segs[0]!, { ...segs[1]! }, segs[2]!]);
      expect(result.getByTestId("dsl-fallback")).toBeTruthy();
    });

    it("with no boundary at all, the router's root boundary catches it, and the next good action recovers", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await mount(
        segments({ entry: ok(1), appBoundary: false }),
      );
      await action(segments({ entry: failed(), appBoundary: false }));
      expect(result.queryByTestId("reader")).toBeNull();
      await action(segments({ entry: ok(4), appBoundary: false }));
      expect(result.getByTestId("reader").textContent).toBe("stock:4");
    });

    it("a commit onto another route whose entry failed: the app's boundary at the read catches it, and the layout keeps its instance", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await mount(segments({ entry: ok(1) }));
      const layout = result.getByTestId("layout");
      await action(segments({ entry: failed(), routeId: "L0R1" }));
      expect(result.getByTestId("app-boundary").textContent).toBe(
        "stock service unavailable",
      );
      expect(result.getByTestId("layout")).toBe(layout);
    });

    it("a successful action does not remount the route", async () => {
      const result = await mount(segments({ entry: ok(1) }));
      const field = result.getByTestId("field");
      await action(segments({ entry: ok(5) }));
      expect(result.getByTestId("reader").textContent).toBe("stock:5");
      expect(result.getByTestId("field")).toBe(field);
      expect(routeMounts).toBe(1);
    });
  },
);

// A layout with its own loader above a route that reads it: the read
// catches the layout loader's errorBoundary() marker at the route's
// StreamedLoaderErrorBoundary, so that boundary must reset when the layout's
// loader reruns, not only its own.
const Parent = { $$id: "parent" } as unknown as LoaderDefinition<{
  n: number;
}>;
const Own = { $$id: "own" } as unknown as LoaderDefinition<{ n: number }>;

let layoutMounts = 0;
function CountedLayout() {
  useEffect(() => {
    layoutMounts++;
  }, []);
  return createElement(
    "div",
    { "data-testid": "layout" },
    createElement(Outlet),
  );
}
function ParentAndOwnReader() {
  const { data: parent } = useLoader(Parent);
  const { data: own } = useLoader(Own);
  return (
    <p data-testid="reader">
      parent:{parent.n} own:{own.n}
    </p>
  );
}
function OwnReader() {
  const { data } = useLoader(Own);
  return <p data-testid="reader">own:{data.n}</p>;
}

function chain(opts: {
  parent?: unknown;
  own: Promise<unknown>;
  route?: ReactNode;
  loading?: boolean;
}): ResolvedSegment[] {
  const out = [
    {
      id: "L0",
      type: "layout",
      namespace: "",
      index: 0,
      component: createElement(CountedLayout),
    },
  ] as ResolvedSegment[];
  if (opts.parent !== undefined) {
    out.push({
      id: "L0D0.parent",
      type: "loader",
      namespace: "",
      index: 0,
      loaderId: "parent",
      loaderData: Promise.resolve(opts.parent),
    } as ResolvedSegment);
  }
  out.push(
    {
      id: "L0R0",
      type: "route",
      namespace: "",
      index: 0,
      component: opts.route ?? createElement(ParentAndOwnReader),
      ...(opts.loading
        ? { loading: createElement("p", { "data-testid": "skeleton" }, "…") }
        : {}),
    } as ResolvedSegment,
    {
      id: "L0R0D0.own",
      type: "loader",
      namespace: "",
      index: 0,
      loaderId: "own",
      loaderData: opts.own,
    } as ResolvedSegment,
  );
  return out;
}

describe.each(LANES)("%s lane: layouts and ancestor loaders", (_, options) => {
  beforeEach(() => {
    laneOptions = options;
  });
  afterEach(() => {
    layoutMounts = 0;
  });

  for (const loading of [false, true]) {
    it(`a loader redirect() replaces only the route's content; the layout keeps its instance (${loading ? "with" : "without"} loading())`, async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const route = createElement(OwnReader);
      const result = await mount(
        chain({ own: Promise.resolve(ok(1)), route, loading }),
      );
      const layout = result.getByTestId("layout");

      await action(
        chain({
          own: Promise.resolve({
            __loaderResult: true,
            ok: false,
            redirect: { to: "/items" },
            error: { message: "redirect" },
            fallback: null,
          }),
          route,
          loading,
        }),
      );
      expect(result.getByTestId("redirecting").textContent).toBe("/items");
      expect(result.getByTestId("layout")).toBe(layout);
      expect(layoutMounts).toBe(1);
    });
  }

  it("a route's fallback for its layout loader's failure clears when that loader reruns without error (own loader held)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const own = Promise.resolve(ok(1));
    const result = await mount(chain({ parent: ok(1), own }));
    expect(result.getByTestId("reader").textContent).toBe("parent:1 own:1");

    await action(chain({ parent: failed(dslFallback), own }));
    expect(result.getByTestId("dsl-fallback")).toBeTruthy();

    await action(chain({ parent: ok(2), own }));
    expect(result.queryByTestId("dsl-fallback")).toBeNull();
    expect(result.getByTestId("reader").textContent).toBe("parent:2 own:1");
  });

  it("the same fallback, shown by a navigation, clears after an action whose rerun of the layout loader succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const own = Promise.resolve(ok(1));
    const result = await mount(chain({ parent: failed(dslFallback), own }));
    expect(result.getByTestId("dsl-fallback")).toBeTruthy();

    await action(chain({ parent: ok(2), own }));
    expect(result.queryByTestId("dsl-fallback")).toBeNull();
    expect(result.getByTestId("reader").textContent).toBe("parent:2 own:1");
  });
});
