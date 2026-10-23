/**
 * The React tree renderSegments builds, as element types, nesting depth and
 * keys: one shape per `loading` variant (docs/tree-structure.md), and the
 * same shape on every render path. A segment whose wrapper type, depth or key
 * differs between the document (SSR), a navigation, a back/forward restore
 * (forceAwait) and an action re-render remounts on the client and loses its
 * state (useActionState, refs, local state).
 *
 * Runs on the real wrapper components; only `window` is stubbed for the
 * browser paths. The segments are built here, as each path hands them to
 * renderSegments, so this pins renderSegments (and, for the `ssr: false`
 * row, the client's reconcile before it); what the server walks into those
 * segments is pinned by walker-differential.test.ts and
 * stored-source.rsc-test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderSegments } from "../../segment-system.js";
import type { ResolvedSegment } from "../../types.js";
import {
  AuditedOutletProvider,
  OutletProvider,
} from "../../outlet-provider.js";
import {
  AuditedLoaderBoundary,
  AuditedRouteContent,
  LoaderBoundary,
  RouteContentWrapper,
  StreamedLoaderErrorBoundary,
} from "../../route-content-wrapper.js";
import { RootErrorBoundary } from "../../root-error-boundary.js";
import { MountContextProvider } from "../../browser/react/mount-context.js";
import {
  reconcileSegments,
  type ReconcileActor,
} from "../../browser/segment-reconciler.js";

function Layout(): ReactNode {
  return null;
}
function Page(): ReactNode {
  return null;
}
function Spinner(): ReactNode {
  return null;
}

/**
 * Router wrappers by name. Outside a build renderSegments creates the
 * audited variants (suspense-audit.ts); both read as the product name.
 */
const WRAPPERS = new Map<unknown, string>([
  [RootErrorBoundary, "RootErrorBoundary"],
  [OutletProvider, "OutletProvider"],
  [AuditedOutletProvider, "OutletProvider"],
  [LoaderBoundary, "LoaderBoundary"],
  [AuditedLoaderBoundary, "LoaderBoundary"],
  [RouteContentWrapper, "RouteContentWrapper"],
  [AuditedRouteContent, "RouteContentWrapper"],
  [StreamedLoaderErrorBoundary, "StreamedLoaderErrorBoundary"],
  [MountContextProvider, "MountContextProvider"],
  [(React as { ViewTransition?: unknown }).ViewTransition, "ViewTransition"],
  [Layout, "<Layout>"],
  [Page, "<Page>"],
]);

/** Where a wrapper holds the tree below it: outlet content, then children. */
const NESTING_PROPS = ["outletContent", "content", "children"] as const;

/**
 * One line per element: indentation is depth, then the type and its key.
 * Only the props that nest the segment tree are walked (a `loading()`
 * fallback is a prop value, not a level). RouteContentWrapper's content is
 * a promise on the server and on paths that do not await it
 * (segment-boundary-content.ts); its Suspender renders what it resolves
 * to, at the same depth.
 */
async function shape(
  node: unknown,
  depth = 0,
  lines: string[] = [],
): Promise<string[]> {
  if (node instanceof Promise) return shape(await node, depth, lines);
  if (Array.isArray(node)) {
    lines.push(`${"  ".repeat(depth)}[`);
    for (const item of node) await shape(item, depth + 1, lines);
    lines.push(`${"  ".repeat(depth)}]`);
    return lines;
  }
  if (!isValidElement(node)) return lines;
  const name = WRAPPERS.get(node.type) ?? String(node.type);
  const key = node.key === null ? "" : `#${node.key}`;
  lines.push(`${"  ".repeat(depth)}${name}${key}`);
  const props = node.props as Record<string, unknown>;
  for (const prop of NESTING_PROPS) await shape(props[prop], depth + 1, lines);
  return lines;
}

function layout(overrides: Partial<ResolvedSegment> = {}): ResolvedSegment {
  return {
    id: "M0L0",
    namespace: "root",
    type: "layout",
    index: 0,
    component: createElement(Layout),
    params: { id: "1" },
    belongsToRoute: false,
    layoutName: "root",
    ...overrides,
  };
}

function route(overrides: Partial<ResolvedSegment> = {}): ResolvedSegment {
  return {
    id: "M0L0L0R0",
    namespace: "page",
    type: "route",
    index: 0,
    component: createElement(Page),
    params: { id: "1" },
    belongsToRoute: true,
    ...overrides,
  };
}

/** A settled loader of the route, as a navigation or the document emits it. */
function routeLoader(): ResolvedSegment {
  return {
    id: "M0L0L0R0D0.data",
    namespace: "page",
    type: "loader",
    index: 0,
    component: null,
    params: { id: "1" },
    loaderId: "data",
    loaderData: Promise.resolve({ __loaderResult: true, ok: true, data: 1 }),
    belongsToRoute: true,
  };
}

/** An error segment where the route was, as createErrorSegment builds it. */
function errorSegment(): ResolvedSegment {
  return {
    id: "M0L0L0R0",
    namespace: "page",
    type: "error",
    index: 0,
    component: createElement(Page),
    params: { id: "1" },
    error: {
      message: "failed",
      name: "Error",
      segmentId: "M0L0L0R0",
      segmentType: "route",
    },
  };
}

/** A notFound segment, as createNotFoundSegment builds it. */
function notFoundSegment(): ResolvedSegment {
  return {
    id: "M0L0L0R0.notFound",
    namespace: "page",
    type: "notFound",
    index: 0,
    component: createElement(Page),
    params: { id: "1" },
    notFoundInfo: {
      message: "missing",
      segmentId: "M0L0L0R0",
      segmentType: "route",
    },
  };
}

/**
 * The render paths, as each reaches renderSegments: the document's SSR pass
 * (no window), a navigation, a back/forward restore and an action re-render
 * in the browser. `actor` is the reconcile a page that already holds the
 * segments runs before rendering a navigation or an action
 * (segment-reconciler.ts); a back/forward restore renders what it stored.
 */
const PATHS = {
  ssr: { browser: false, options: undefined, actor: undefined },
  navigation: { browser: true, options: undefined, actor: "navigation" },
  backForward: {
    browser: true,
    options: { forceAwait: true },
    actor: undefined,
  },
  action: { browser: true, options: { isAction: true }, actor: "action" },
} as const satisfies Record<
  string,
  { browser: boolean; options: unknown; actor: ReconcileActor | undefined }
>;

type RenderPath = keyof typeof PATHS;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The tree's shape on every render path, built from fresh segment objects. */
async function shapesOnEveryPath(
  build: (path: RenderPath) => ResolvedSegment[],
): Promise<Record<RenderPath, string[]>> {
  const shapes = {} as Record<RenderPath, string[]>;
  for (const path of Object.keys(PATHS) as RenderPath[]) {
    const { browser, options } = PATHS[path];
    if (browser) vi.stubGlobal("window", {});
    try {
      shapes[path] = await shape(await renderSegments(build(path), options));
    } finally {
      vi.unstubAllGlobals();
    }
  }
  return shapes;
}

/** Asserts `expected` on every render path. */
async function expectShape(
  build: (path: RenderPath) => ResolvedSegment[],
  expected: string[],
): Promise<void> {
  const shapes = await shapesOnEveryPath(build);
  expect(shapes).toEqual({
    ssr: expected,
    navigation: expected,
    backForward: expected,
    action: expected,
  });
}

describe("renderSegments tree shape, identical on SSR, navigation, back/forward and action", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
  ])(
    "loading %s: an OutletProvider per segment, no boundary",
    async (_label, loading) => {
      await expectShape(
        () => [layout(), route({ loading })],
        [
          "RootErrorBoundary",
          "  OutletProvider#M0L0",
          "    OutletProvider#M0L0L0R0-id=1",
          "      <Page>",
          "    <Layout>",
        ],
      );
    },
  );

  it("loading undefined with a loader: the loader's error boundary inside the OutletProvider", async () => {
    await expectShape(
      () => [layout(), routeLoader(), route()],
      [
        "RootErrorBoundary",
        "  OutletProvider#M0L0",
        "    OutletProvider#M0L0L0R0-id=1",
        "      StreamedLoaderErrorBoundary",
        "        <Page>",
        "    <Layout>",
      ],
    );
  });

  it("loading false: a LoaderBoundary without RouteContentWrapper", async () => {
    await expectShape(
      () => [layout(), route({ loading: false })],
      [
        "RootErrorBoundary",
        "  OutletProvider#M0L0",
        "    LoaderBoundary#loader-boundary-M0L0L0R0-id=1",
        "      <Page>",
        "    <Layout>",
      ],
    );
  });

  it("loading false with a loader: the loader's error boundary inside the LoaderBoundary", async () => {
    await expectShape(
      () => [layout(), routeLoader(), route({ loading: false })],
      [
        "RootErrorBoundary",
        "  OutletProvider#M0L0",
        "    LoaderBoundary#loader-boundary-M0L0L0R0-id=1",
        "      StreamedLoaderErrorBoundary",
        "        <Page>",
        "    <Layout>",
      ],
    );
  });

  it("loading truthy: LoaderBoundary around RouteContentWrapper", async () => {
    await expectShape(
      () => [layout(), route({ loading: createElement(Spinner) })],
      [
        "RootErrorBoundary",
        "  OutletProvider#M0L0",
        "    LoaderBoundary#loader-boundary-M0L0L0R0-id=1",
        "      RouteContentWrapper#suspense-loading-M0L0L0R0",
        "        <Page>",
        "    <Layout>",
      ],
    );
  });

  it("loading truthy with a loader: LoaderBoundary, the loader's error boundary, then RouteContentWrapper", async () => {
    await expectShape(
      () => [
        layout(),
        routeLoader(),
        route({ loading: createElement(Spinner) }),
      ],
      [
        "RootErrorBoundary",
        "  OutletProvider#M0L0",
        "    LoaderBoundary#loader-boundary-M0L0L0R0-id=1",
        "      StreamedLoaderErrorBoundary",
        "        RouteContentWrapper#suspense-loading-M0L0L0R0",
        "          <Page>",
        "    <Layout>",
      ],
    );
  });

  it("a layout with loading(): its LoaderBoundary carries the route as outlet content", async () => {
    await expectShape(
      () => [layout({ loading: createElement(Spinner) }), route()],
      [
        "RootErrorBoundary",
        "  LoaderBoundary#loader-boundary-M0L0",
        "    OutletProvider#M0L0L0R0-id=1",
        "      <Page>",
        "    RouteContentWrapper#suspense-loading-M0L0",
        "      <Layout>",
      ],
    );
  });

  it("include(): a MountContextProvider around the mounted segment, outside its key", async () => {
    await expectShape(
      () => [layout(), route({ mountPath: "/shop" })],
      [
        "RootErrorBoundary",
        "  OutletProvider#M0L0",
        "    MountContextProvider",
        "      OutletProvider#M0L0L0R0-id=1",
        "        <Page>",
        "    <Layout>",
      ],
    );
  });

  it("transition(): a param-agnostic route key and a ViewTransition around the route content", async () => {
    await expectShape(
      () => [layout(), route({ transition: {} })],
      [
        "RootErrorBoundary",
        "  OutletProvider#M0L0",
        "    OutletProvider#M0L0L0R0",
        "      ViewTransition",
        "        <Page>",
        "    <Layout>",
      ],
    );
  });

  it("clientUrls() group: one key per group mount and the error boundary, whatever loading() says", async () => {
    await expectShape(
      () => [
        layout(),
        route({ clientGroup: "/shop", loading: createElement(Spinner) }),
      ],
      [
        "RootErrorBoundary",
        "  OutletProvider#M0L0",
        "    OutletProvider#cg:/shop",
        "      StreamedLoaderErrorBoundary",
        "        <Page>",
        "    <Layout>",
      ],
    );
  });

  describe("keys under a transition() scope", () => {
    it.each([
      ["an error segment", errorSegment, "M0L0L0R0-id=1"],
      ["a notFound segment", notFoundSegment, "M0L0L0R0.notFound-id=1"],
    ])(
      "%s keeps its params, which a route there drops",
      async (_label, segment, key) => {
        await expectShape(
          () => [layout({ transition: {} }), segment()],
          [
            "RootErrorBoundary",
            "  OutletProvider#M0L0",
            "    ViewTransition",
            `      OutletProvider#${key}`,
            "        <Page>",
            "    <Layout>",
          ],
        );
      },
    );

    it("a route-owned layout drops its params, as its route does", async () => {
      const owned = (): ResolvedSegment =>
        layout({
          id: "M0L0L0",
          namespace: "owned",
          layoutName: "owned",
          belongsToRoute: true,
        });
      await expectShape(
        () => [layout(), owned(), route({ transition: {} })],
        [
          "RootErrorBoundary",
          "  OutletProvider#M0L0",
          "    OutletProvider#M0L0L0",
          "      OutletProvider#M0L0L0R0",
          "        ViewTransition",
          "          <Page>",
          "      <Layout>",
          "    <Layout>",
        ],
      );
      // Outside the scope both keep them.
      await expectShape(
        () => [layout(), owned(), route()],
        [
          "RootErrorBoundary",
          "  OutletProvider#M0L0",
          "    OutletProvider#M0L0L0-id=1",
          "      OutletProvider#M0L0L0R0-id=1",
          "        <Page>",
          "      <Layout>",
          "    <Layout>",
        ],
      );
    });
  });

  it("loading(..., { ssr: false }): the document's null loading, kept by the client's reconcile, on every path", async () => {
    // A document evaluation sets the entry's loading to false
    // (applyDocumentModeLoading), which the walkers emit as `loading: null`
    // (fresh.ts, revalidation.ts); a navigation gets the fallback. A page
    // holding the document's segments keeps its null when a navigation or an
    // action answers with the fallback.
    await expectShape(
      (path) => {
        const held = [layout(), route({ loading: null })];
        const { actor } = PATHS[path];
        if (!actor) return held;
        const answer = [layout(), route({ loading: createElement(Spinner) })];
        return reconcileSegments({
          actor,
          matched: ["M0L0", "M0L0L0R0"],
          diff: ["M0L0L0R0"],
          serverSegments: answer,
          cachedSegments: held,
        }).mainSegments;
      },
      [
        "RootErrorBoundary",
        "  OutletProvider#M0L0",
        "    OutletProvider#M0L0L0R0-id=1",
        "      <Page>",
        "    <Layout>",
      ],
    );
  });
});
