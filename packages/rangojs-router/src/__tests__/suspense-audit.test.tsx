// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  type RenderResult,
} from "@testing-library/react";
import {
  createElement,
  startTransition,
  StrictMode,
  use,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { Outlet } from "../client.js";
import { AuditedRouteContent } from "../route-content-wrapper.js";
import { renderSegments } from "../segment-system.js";
import type { SuspenseAuditReport } from "../suspense-audit.js";
import {
  auditHandover,
  auditSegmentElement,
  auditTreeCause,
  auditTreeUpdate,
  createBoundaryAudit,
  finishTreeAudit,
  forgetSuspenseAudit,
  setSuspenseAuditStreamProbe,
  startTreeAudit,
  type TreeUpdateCause,
} from "../suspense-audit.js";
import { renderRoute } from "../testing/render-route.js";
import type { ResolvedSegment } from "../types.js";

/**
 * The dev-only suspense audit (suspense-audit.ts), against real React: each
 * invariant fires on the hand-over it names and on nothing else, with
 * StrictMode on and off. docs/internal/suspense-contract.md.
 *
 * act() commits a fallback and its retry in one scope (no 300 ms throttle),
 * so a fallback is counted by its mount, not read off the DOM.
 */

function audit(): SuspenseAuditReport {
  return (window as unknown as { __rangoSuspenseAudit: SuspenseAuditReport })
    .__rangoSuspenseAudit;
}

function counters(): Record<string, number> {
  const { swaps, untracked, idleFallbacks, resuspended, remounts, drifts } =
    audit();
  return { swaps, untracked, idleFallbacks, resuspended, remounts, drifts };
}

const ZERO = {
  swaps: 0,
  untracked: 0,
  idleFallbacks: 0,
  resuspended: 0,
  remounts: 0,
  drifts: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// The audit judges a fallback, a mount and an unread promise two microtasks
// after the commit.
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let fallbacks = 0;
function Fallback(): ReactNode {
  useLayoutEffect(() => {
    fallbacks += 1;
  }, []);
  return <p data-testid="fallback">fallback</p>;
}

// Hands React a tree the way the store's subscriber does: the emitter names
// its cause, the subscriber counts the update, then React renders it.
let setState!: (tree: ReactNode) => void;
function setTree(tree: ReactNode): void {
  auditTreeCause("navigation");
  auditTreeUpdate(tree);
  setState(tree);
}
let streaming = false;
setSuspenseAuditStreamProbe(() => streaming);
function Harness({ initial }: { initial: ReactNode }) {
  const [tree, set] = useState(initial);
  setState = set;
  return tree;
}

// The route boundary as segment-system creates it outside a build.
function boundary(content: Promise<ReactNode> | ReactNode): ReactNode {
  return (
    <AuditedRouteContent
      content={content}
      fallback={<Fallback />}
      segmentId="S"
    />
  );
}

function seg(
  overrides: Partial<ResolvedSegment> & {
    id: string;
    type: ResolvedSegment["type"];
  },
): ResolvedSegment {
  return {
    namespace: "",
    index: 0,
    component: createElement("div", null, `component-${overrides.id}`),
    ...overrides,
  };
}

function Layout(): ReactNode {
  return (
    <div data-testid="layout">
      <Outlet />
    </div>
  );
}

let errors: ReturnType<typeof vi.spyOn>;
const logged = (): string[] =>
  errors.mock.calls.map((call: unknown[]) => String(call[0]));
const audited = (): string[] =>
  logged().filter((text) => text.startsWith("[rango][suspense]"));

beforeEach(() => {
  fallbacks = 0;
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  streaming = false;
  window.history.replaceState(null, "", "/audit");
});

afterEach(async () => {
  cleanup();
  await settle();
  forgetSuspenseAudit();
  errors.mockRestore();
});

describe("suspense audit, segments after hand-over (I7)", () => {
  // One renderSegments call, by hand: the segment objects it is built from,
  // and the root it returns. `emit` hands that root to React.
  function build(segments: object[], emit = false): object {
    const tree = startTreeAudit();
    auditSegmentElement(tree, "L0", "layout", "L0", null, false, [], segments);
    const root = {};
    finishTreeAudit(tree, root);
    if (emit) {
      auditTreeCause("navigation");
      auditTreeUpdate(root);
    }
    return root;
  }

  it("reports a field of a handed segment written before the next tree is built, and the write still happens", () => {
    const segment: Record<string, unknown> = { id: "L0", loading: null };
    // The first tree is the document's: React holds it from hydration.
    build([segment]);
    segment.loading = "skeleton";
    expect(audit().mutations).toBe(0);
    build([segment]);
    expect(segment.loading).toBe("skeleton");
    expect(audit().mutations).toBe(1);
    expect(audited()).toEqual([
      expect.stringContaining(
        "I7 mutated at segment:L0: loading was written after the tree holding this segment was handed to React",
      ),
    ]);
  });

  it("stays silent for a segment of a tree React was never handed", () => {
    build([{ id: "L0" }]);
    const next: Record<string, unknown> = { id: "L0", loading: null };
    build([next]);
    next.loading = "set before the update reached React";
    const root = build([next]);
    expect(audit().mutations).toBe(0);
    auditTreeCause("navigation");
    auditTreeUpdate(root);
    next.loading = "set after";
    build([next]);
    expect(audit().mutations).toBe(1);
  });

  it("renderSegments rewrites a parallel slot's loader fields in place when it re-renders the slot (main)", async () => {
    const slot = seg({
      id: "L0.@side",
      namespace: "parallel.side",
      type: "parallel",
      slot: "@side",
      loading: <Fallback />,
    });
    const segments = (): ResolvedSegment[] => [
      seg({ id: "L0", type: "layout", component: <Layout /> }),
      slot,
      seg({
        id: "L0D0.side-data",
        namespace: "parallel.side",
        type: "loader",
        loaderId: "side-loader",
        loaderData: { side: true },
      }),
      seg({ id: "L0R0", type: "route" }),
    ];
    const first = await renderSegments(segments());
    await act(async () => {
      render(<Harness initial={first} />);
    });
    expect(audit().mutations).toBe(0);
    const tree = await renderSegments(segments(), { isAction: true });
    await act(async () => startTransition(() => setTree(tree)));
    expect(audited()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("I7 mutated at segment:L0.@side: loaderIds"),
        expect.stringContaining(
          "I7 mutated at segment:L0.@side: loaderDataPromise",
        ),
      ]),
    );
  });
});

describe("suspense audit, the tree React holds (I4, I5, I7)", () => {
  const layout = (loading?: ReactNode) =>
    seg({ id: "L0", type: "layout", component: <Layout />, loading });
  const route = seg({ id: "R0", type: "route" });

  it("a tree that never reaches React, an aborted navigation's, is not the one the next tree is compared with", async () => {
    await renderSegments([layout(), route]);
    // Built, then dropped: its navigation was superseded before the commit.
    await renderSegments([layout(<Fallback />), route], { forceAwait: true });
    const next = await renderSegments([layout(), route]);
    auditTreeCause("navigation");
    auditTreeUpdate(next);
    expect(counters()).toEqual(ZERO);
    expect(audited()).toEqual([]);
  });

  it("a tree handed as a promise, as HMR does, is held once React has read it", async () => {
    await renderSegments([layout(), route]);
    const slot = (): ResolvedSegment =>
      seg({
        id: "L0.@side",
        namespace: "parallel.side",
        type: "parallel",
        slot: "@side",
        loading: <Fallback />,
      });
    const hmrSlot = slot();
    const segments = (): ResolvedSegment[] => [
      layout(),
      hmrSlot,
      seg({
        id: "L0D0.side-data",
        namespace: "parallel.side",
        type: "loader",
        loaderId: "side-loader",
        loaderData: { side: true },
      }),
      seg({ id: "L0R0", type: "route" }),
    ];
    // Still building when it is emitted: forceAwait awaits each content.
    const pending = renderSegments(segments(), { forceAwait: true });
    auditTreeCause("hmr");
    auditTreeUpdate(pending);
    const tree = await pending;
    // What React's use() leaves on a promise it has read.
    Object.assign(pending, { status: "fulfilled", value: tree });
    await renderSegments(segments(), { isAction: true });
    expect(audited()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("I7 mutated at segment:L0.@side: loaderIds"),
      ]),
    );
  });
});

describe("suspense audit, what it must not do", () => {
  it("leaves a rejected promise it is handed unhandled, as a build does", async () => {
    // Vitest's own listener fails the run on an unhandled rejection.
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    const unhandled: unknown[] = [];
    const listener = (_reason: unknown, promise: unknown): void => {
      unhandled.push(promise);
    };
    process.on("unhandledRejection", listener);
    const handed = Promise.reject(new Error("loader failed"));
    try {
      const rec = createBoundaryAudit("content:X", "X");
      rec.mountId = 1;
      rec.revealed = true;
      auditHandover(rec, deferred<ReactNode>().promise);
      auditHandover(rec, handed);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toContain(handed);
    } finally {
      process.off("unhandledRejection", listener);
      for (const restore of saved) process.on("unhandledRejection", restore);
    }
  });
});

describe("suspense audit, tree updates (I6)", () => {
  it("counts a tree update under the cause its emitter named", () => {
    auditTreeCause("action");
    auditTreeUpdate();
    auditTreeCause("navigation");
    auditTreeUpdate();
    auditTreeCause("navigation");
    auditTreeUpdate();
    expect(audit().treeUpdates).toEqual({ action: 1, navigation: 2 });
    expect(audit().uncaused).toBe(0);
    expect(audited()).toEqual([]);
  });

  it("reports a tree update whose emitter named no cause", () => {
    auditTreeUpdate();
    expect(audit().treeUpdates).toEqual({ none: 1 });
    expect(audit().uncaused).toBe(1);
    expect(audited()).toEqual([
      expect.stringContaining("I6 uncaused at tree: React was handed a tree"),
    ]);
  });

  it("reports a cause that is not one of the six", () => {
    auditTreeCause("loader-refetch" as TreeUpdateCause);
    auditTreeUpdate();
    expect(audit().uncaused).toBe(1);
    expect(audited()).toEqual([
      expect.stringContaining('"loader-refetch" is not a cause'),
    ]);
  });

  it("a cause does not outlive its task: an emit after an await names it again", async () => {
    auditTreeCause("stale-revalidation");
    await Promise.resolve();
    auditTreeUpdate();
    expect(audit().treeUpdates).toEqual({ none: 1 });
    expect(audit().uncaused).toBe(1);
  });

  it("renderRoute navigate() is one navigation update", async () => {
    const Page = (): ReactNode => <p data-testid="page">page</p>;
    const view = await renderRoute([{ path: "/items/:id", Component: Page }], {
      request: "/items/1",
    });
    expect(audit()?.treeUpdates ?? {}).toEqual({});
    await view.router.navigate("/items/2");
    await settle();
    expect(audit().treeUpdates).toEqual({ navigation: 1 });
    expect(audit().uncaused).toBe(0);
  });
});

for (const strict of [false, true]) {
  // An async act(): render()'s own is not awaited, and React drops the work
  // of a tree that suspends inside it.
  const mount = async (initial: ReactNode): Promise<RenderResult> => {
    let view!: RenderResult;
    await act(async () => {
      view = render(
        strict ? (
          <StrictMode>
            <Harness initial={initial} />
          </StrictMode>
        ) : (
          <Harness initial={initial} />
        ),
      );
    });
    await settle();
    return view;
  };

  describe(`suspense audit, StrictMode ${strict ? "on" : "off"}`, () => {
    it("stays silent on a streaming navigation: a new boundary waits behind its fallback, then reveals", async () => {
      const content = deferred<ReactNode>();
      const view = await mount(boundary(content.promise));
      expect(view.queryByTestId("fallback")).not.toBeNull();

      await act(async () => content.resolve(<p data-testid="content">a</p>));
      await settle();
      expect(view.queryByTestId("content")).not.toBeNull();
      expect(counters()).toEqual(ZERO);
      expect(logged()).toEqual([]);
      expect(audit().mounts["content:S"]).toBe(1);
    });

    it("stays silent when content on screen is handed the node itself", async () => {
      const view = await mount(boundary(<p data-testid="content">a</p>));
      await act(async () => setTree(boundary(<p data-testid="content">b</p>)));
      await settle();
      expect(view.getByTestId("content").textContent).toBe("b");
      expect(fallbacks).toBe(0);
      expect(counters()).toEqual(ZERO);
      expect(logged()).toEqual([]);
    });

    it("I1: a boundary on screen is handed another pending thenable for the same URL", async () => {
      const first = deferred<ReactNode>();
      const second = deferred<ReactNode>();
      await mount(boundary(first.promise));
      await act(async () => setTree(boundary(second.promise)));
      await settle();
      expect(counters()).toEqual({ ...ZERO, swaps: 1 });
      expect(audited()).toEqual([
        expect.stringContaining("I1 swap at content:S"),
      ]);
    });

    it("I1 is silent for another URL: a navigation hands new data", async () => {
      const first = deferred<ReactNode>();
      const second = deferred<ReactNode>();
      await mount(boundary(first.promise));
      window.history.pushState(null, "", "/audit/next");
      await act(async () => setTree(boundary(second.promise)));
      await settle();
      expect(counters()).toEqual(ZERO);
    });

    it("I1 is silent when the replacement is already settled", async () => {
      const first = deferred<ReactNode>();
      // A fulfilled Flight chunk: React reads it without waiting.
      const chunk = Object.assign(Promise.resolve(null), {
        status: "fulfilled",
        value: <p data-testid="content">a</p>,
      });
      const view = await mount(boundary(first.promise));
      await act(async () => setTree(boundary(chunk)));
      await settle();
      expect(view.queryByTestId("content")).not.toBeNull();
      expect(counters()).toEqual(ZERO);
    });

    it("I2 and I3: content on screen is handed a settled promise React has not read, in a render that cannot wait", async () => {
      const view = await mount(boundary(<p data-testid="content">a</p>));
      const unread = Promise.resolve(<p data-testid="content">b</p>);
      await unread;
      await act(async () => setTree(boundary(unread)));
      await settle();
      // React suspended on a value that was there, and showed the fallback.
      expect(fallbacks).toBeGreaterThan(0);
      expect(view.getByTestId("content").textContent).toBe("b");
      expect(counters()).toEqual({ ...ZERO, untracked: 1, resuspended: 1 });
      expect(audited()).toEqual([
        expect.stringContaining("I2 untracked at content:S"),
        expect.stringContaining(
          "I3 resuspended at content:S: the fallback replaced content on screen with nothing pending",
        ),
      ]);
    });

    it("I2 alone when a transition holds the page: nothing flashes, the hazard is reported", async () => {
      const view = await mount(boundary(<p data-testid="content">a</p>));
      const unread = Promise.resolve(<p data-testid="content">b</p>);
      await unread;
      await act(async () => startTransition(() => setTree(boundary(unread))));
      await settle();
      expect(fallbacks).toBe(0);
      expect(view.getByTestId("content").textContent).toBe("b");
      expect(counters()).toEqual({ ...ZERO, untracked: 1 });
    });

    it("I3: a boundary new to the page shows its fallback with nothing pending", async () => {
      const unread = Promise.resolve(<p data-testid="content">a</p>);
      await unread;
      await mount(null);
      await act(async () => setTree(boundary(unread)));
      await settle();
      expect(fallbacks).toBeGreaterThan(0);
      expect(counters()).toEqual({ ...ZERO, idleFallbacks: 1 });
      expect(audited()).toEqual([
        expect.stringContaining("I3 idle-fallback at content:S"),
      ]);
    });

    it("I3 is silent, and counts the fallback unattributed, when the app's own content suspends inside the route's boundary", async () => {
      const app = deferred<string>();
      function AppSuspends(): ReactNode {
        return <p data-testid="content">{use(app.promise)}</p>;
      }
      await mount(null);
      await act(async () => setTree(boundary(<AppSuspends />)));
      await settle();
      expect(fallbacks).toBeGreaterThan(0);
      expect(counters()).toEqual(ZERO);
      expect(audited()).toEqual([]);
      expect(audit().unattributedFallbacks).toBeGreaterThan(0);
      await act(async () => app.resolve("app"));
      await settle();
    });

    it("I3 is silent when a client reference is still loading under a large list prop", async () => {
      const never = new Promise<never>(() => {});
      // A Flight client reference whose module is still loading.
      const reference = {
        $$typeof: Symbol.for("react.lazy"),
        _payload: { status: "blocked" },
        _init: () => {
          throw never;
        },
      };
      const element = createElement(reference as never, {
        items: Array.from({ length: 500 }, (_, i) => i),
      });
      // A fulfilled Flight chunk: React reads it without waiting.
      const chunk = Object.assign(Promise.resolve(element), {
        status: "fulfilled",
        value: element,
      });
      await mount(null);
      await act(async () => setTree(boundary(chunk)));
      await settle();
      expect(fallbacks).toBeGreaterThan(0);
      expect(counters()).toEqual(ZERO);
      expect(audited()).toEqual([]);
    });

    it("I3 is silent while the payload streams, and counts a fallback over content on screen whose data is pending", async () => {
      const view = await mount(boundary(<p data-testid="content">a</p>));
      const next = deferred<ReactNode>();
      await act(async () => setTree(boundary(next.promise)));
      await settle();
      // The urgent commit transition({ when }) gated off makes (#995).
      expect(view.queryByTestId("fallback")).not.toBeNull();
      expect(counters()).toEqual(ZERO);
      expect(audit().shownWhilePending).toBe(1);
      expect(audited()).toEqual([]);

      streaming = true;
      const unread = Promise.resolve(<p data-testid="content">b</p>);
      await unread;
      window.history.pushState(null, "", "/audit/next");
      await act(async () => setTree(boundary(unread)));
      await settle();
      expect(counters().idleFallbacks).toBe(0);
      expect(audited().filter((text) => text.includes(" I3 "))).toEqual([]);
    });

    it("I4 and I5: a segment that keeps its key and changes its wrapper chain is remounted", async () => {
      const route = seg({ id: "R0", type: "route" });
      const layout = (loading?: ReactNode) =>
        seg({ id: "L0", type: "layout", component: <Layout />, loading });
      const view = await mount(await renderSegments([layout(), route]));
      expect(view.getByTestId("layout").textContent).toBe("component-R0");
      expect(counters()).toEqual(ZERO);

      // The same layout under the same key, inside a loading() boundary this
      // time. Awaited, so the new boundary has nothing to wait for.
      const drifted = await renderSegments([layout(<Fallback />), route], {
        forceAwait: true,
      });
      await act(async () => setTree(drifted));
      await settle();
      expect(fallbacks).toBe(0);
      expect(counters()).toEqual({ ...ZERO, drifts: 1, remounts: 1 });
      expect(audited()).toEqual([
        expect.stringContaining(
          "I5 drift at outlet:L0: wrapper chain link 0 changed from OutletProvider#L0 to LoaderBoundary#loader-boundary-L0",
        ),
        expect.stringContaining("I4 remount at outlet:L0"),
      ]);
      expect(audit().mounts["outlet:L0"]).toBe(2);
    });

    it("I5 alone for a link below the segment's outlet: the content under it is what remounts", async () => {
      const layout = seg({ id: "L0", type: "layout", component: <Layout /> });
      const route = seg({ id: "R0", type: "route" });
      await mount(await renderSegments([layout, route]));

      // A loader on the route puts the loader error boundary into its chain.
      const drifted = await renderSegments(
        [
          layout,
          route,
          seg({
            id: "R0D0.data",
            type: "loader",
            loaderId: "data",
            loaderData: { value: 1 },
          }),
        ],
        { forceAwait: true },
      );
      await act(async () => setTree(drifted));
      await settle();
      expect(counters()).toEqual({ ...ZERO, drifts: 1 });
      expect(audited()).toEqual([
        expect.stringContaining(
          "I5 drift at outlet:R0: wrapper chain link 1 changed from nothing to StreamedLoaderErrorBoundary",
        ),
      ]);
    });

    it("I4 and I5 are silent for the documented remounts: a param change, an error segment", async () => {
      const layout = seg({ id: "L0", type: "layout", component: <Layout /> });
      const route = (id: string) =>
        seg({ id: "R0", type: "route", params: { id } });
      await mount(await renderSegments([layout, route("1")]));

      const second = await renderSegments([layout, route("2")]);
      await act(async () => setTree(second));
      await settle();
      const failed = await renderSegments([
        layout,
        seg({ id: "R0", type: "error", params: { id: "2" } }),
      ]);
      await act(async () => setTree(failed));
      await settle();
      expect(counters()).toEqual(ZERO);
      expect(audited()).toEqual([]);
      expect(audit().mounts["outlet:L0"]).toBe(1);
      // The new key remounts the route; the error segment takes its place
      // under that key.
      expect(audit().mounts["outlet:R0"]).toBe(2);
    });

    it("renderSegments builds one wrapper chain on the plain, awaited and action lanes", async () => {
      const segments = (): ResolvedSegment[] => [
        seg({
          id: "L0",
          type: "layout",
          component: <Layout />,
          loading: <Fallback />,
        }),
        seg({ id: "R0", type: "route", loading: <Fallback /> }),
      ];
      await mount(await renderSegments(segments()));
      for (const options of [{ forceAwait: true }, { isAction: true }, {}]) {
        const tree = await renderSegments(segments(), options);
        await act(async () => startTransition(() => setTree(tree)));
        await settle();
      }
      expect(counters().drifts).toBe(0);
      expect(counters().remounts).toBe(0);
      expect(audit().mounts["outlet:L0"]).toBe(1);
      expect(audit().mounts["outlet:R0"]).toBe(1);
    });

    // The plain lane hands the boundaries their settled values
    // (getBoundaryContent, getMemoizedLoaderPromise), not promises React has
    // not read (#1079, fixed by #1080).
    it("an awaited render, then an urgent render of the same boundaries, commits no fallback", async () => {
      const component = <p data-testid="content">a</p>;
      const segments = (): ResolvedSegment[] => [
        seg({
          id: "L0",
          type: "layout",
          component: <Layout />,
          loading: <Fallback />,
        }),
        seg({ id: "R0", type: "route", component, loading: <Fallback /> }),
      ];
      const awaited = await renderSegments(segments(), { forceAwait: true });
      const view = await mount(awaited);
      expect(view.getByTestId("content").textContent).toBe("a");
      expect(fallbacks).toBe(0);

      const plain = await renderSegments(segments());
      await act(async () => setTree(plain));
      await settle();
      expect(view.getByTestId("content").textContent).toBe("a");
      expect(fallbacks).toBe(0);
      expect(counters()).toEqual(ZERO);
      expect(logged()).toEqual([]);
    });
  });
}
