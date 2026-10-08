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
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { Outlet } from "../client.js";
import { RouteContentWrapper } from "../route-content-wrapper.js";
import { renderSegments } from "../segment-system.js";
import type { SuspenseAuditReport } from "../suspense-audit.js";
import {
  auditTreeCause,
  auditTreeUpdate,
  forgetSuspenseAudit,
  setSuspenseAuditStreamProbe,
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

let setTree!: (tree: ReactNode) => void;
function Harness({ initial }: { initial: ReactNode }) {
  const [tree, set] = useState(initial);
  setTree = set;
  return tree;
}

function boundary(content: Promise<ReactNode> | ReactNode): ReactNode {
  return (
    <RouteContentWrapper
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
  setSuspenseAuditStreamProbe(() => false);
  window.history.replaceState(null, "", "/audit");
});

afterEach(async () => {
  cleanup();
  await settle();
  forgetSuspenseAudit();
  errors.mockRestore();
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

      setSuspenseAuditStreamProbe(() => true);
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

    // #1079. Red on main: the plain lane hands the boundary
    // getMemoizedContentPromise's and getMemoizedLoaderPromise's promises,
    // settled and never read. Passes once it hands the values themselves.
    it.fails("an awaited render, then an urgent render of the same boundaries, commits no fallback", async () => {
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
