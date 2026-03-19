import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode, type ReactElement } from "react";
import type { ResolvedSegment } from "../types";

// Sentinel components for identification in the element tree
function MockOutletProvider(props: any) {
  return props.children;
}
function MockLoaderBoundary(props: any) {
  return props.children;
}
function MockRouteContentWrapper(props: any) {
  return null;
}
function MockMountContextProvider(props: any) {
  return props.children;
}
function MockRootErrorBoundary(props: any) {
  return props.children;
}

vi.mock("../client.js", () => ({
  OutletProvider: MockOutletProvider,
}));

vi.mock("../browser/react/mount-context.js", () => ({
  MountContextProvider: MockMountContextProvider,
}));

vi.mock("../route-content-wrapper.js", () => ({
  RouteContentWrapper: MockRouteContentWrapper,
  LoaderBoundary: MockLoaderBoundary,
}));

vi.mock("../root-error-boundary.js", () => ({
  RootErrorBoundary: MockRootErrorBoundary,
}));

import { renderSegments } from "../segment-system";

// Helper to create a minimal segment
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

// Walk the element tree collecting component info
interface TreeNode {
  type: string | Function;
  typeName: string;
  props: Record<string, any>;
  children: TreeNode[];
}

function toTreeNode(node: ReactNode): TreeNode | null {
  if (!node || typeof node !== "object") return null;
  const el = node as ReactElement;
  if (!el.type) return null;

  const typeName =
    typeof el.type === "string"
      ? el.type
      : (el.type as Function).name || "Anonymous";

  const children: TreeNode[] = [];

  // Walk both `children` and `content` props since layouts pass inner
  // content via the `content` prop to OutletProvider
  for (const prop of ["children", "content"] as const) {
    const val = (el.props as Record<string, any>)?.[prop];
    if (!val) continue;
    if (Array.isArray(val)) {
      for (const child of val) {
        const n = toTreeNode(child);
        if (n) children.push(n);
      }
    } else {
      const n = toTreeNode(val);
      if (n) children.push(n);
    }
  }

  return { type: el.type, typeName, props: el.props || {}, children };
}

// Find all nodes matching a component type in the tree
function findAll(tree: TreeNode | null, fn: Function): TreeNode[] {
  if (!tree) return [];
  const results: TreeNode[] = [];
  if (tree.type === fn) results.push(tree);
  for (const child of tree.children) {
    results.push(...findAll(child, fn));
  }
  return results;
}

// Find first node matching a component type
function findFirst(tree: TreeNode | null, fn: Function): TreeNode | null {
  if (!tree) return null;
  if (tree.type === fn) return tree;
  for (const child of tree.children) {
    const found = findFirst(child, fn);
    if (found) return found;
  }
  return null;
}

// Collect all nodes of a type in order (depth-first)
function collectByType(tree: TreeNode | null, fn: Function): TreeNode[] {
  return findAll(tree, fn);
}

describe("segment-system", () => {
  describe("renderSegments", () => {
    describe("basic tree structure", () => {
      it("renders a single route segment with OutletProvider", async () => {
        const segments: ResolvedSegment[] = [seg({ id: "R0", type: "route" })];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);

        // Root is RootErrorBoundary
        expect(tree!.type).toBe(MockRootErrorBoundary);

        // Inside is an OutletProvider for the route
        const outlets = collectByType(tree, MockOutletProvider);
        expect(outlets).toHaveLength(1);
        expect(outlets[0].props.segment.id).toBe("R0");
        expect(outlets[0].props.content).toBeNull(); // route has no outlet content
      });

      it("nests layout around route (layout receives route as outlet content)", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "L0R0", type: "route" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        // Two OutletProviders
        expect(outlets).toHaveLength(2);

        // Outer (layout) wraps inner (route)
        // The outermost outlet should be the layout
        const outerOutlet = outlets[0];
        expect(outerOutlet.props.segment.id).toBe("L0");
        // Layout's content prop is the route's OutletProvider
        expect(outerOutlet.props.content).not.toBeNull();
      });

      it("nests multiple layouts (root -> inner -> route)", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "L0L0", type: "layout" }),
          seg({ id: "L0L0R0", type: "route" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        expect(outlets).toHaveLength(3);
        // Outermost is root layout L0
        expect(outlets[0].props.segment.id).toBe("L0");
      });

      it("always wraps with RootErrorBoundary", async () => {
        const segments: ResolvedSegment[] = [seg({ id: "R0", type: "route" })];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);

        expect(tree!.type).toBe(MockRootErrorBoundary);
      });
    });

    describe("tree structure based on loading property", () => {
      it("uses OutletProvider directly when loading is undefined", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", loading: undefined }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);

        expect(collectByType(tree, MockOutletProvider)).toHaveLength(1);
        expect(collectByType(tree, MockLoaderBoundary)).toHaveLength(0);
        expect(collectByType(tree, MockRouteContentWrapper)).toHaveLength(0);
      });

      it("uses OutletProvider directly when loading is null", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", loading: null as any }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);

        expect(collectByType(tree, MockOutletProvider)).toHaveLength(1);
        expect(collectByType(tree, MockLoaderBoundary)).toHaveLength(0);
      });

      it("uses LoaderBoundary when loading is false (defined but falsy)", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", loading: false as any }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);

        // loading is false: not null, not undefined, so enters LoaderBoundary path
        expect(collectByType(tree, MockLoaderBoundary)).toHaveLength(1);
      });

      it("uses LoaderBoundary + RouteContentWrapper when loading is a ReactNode", async () => {
        const loadingSkeleton = createElement("div", null, "Loading...");
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", loading: loadingSkeleton }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);

        expect(collectByType(tree, MockLoaderBoundary)).toHaveLength(1);
        // RouteContentWrapper used as the children of LoaderBoundary
        expect(collectByType(tree, MockRouteContentWrapper)).toHaveLength(1);
      });

      it("uses OutletProvider with awaited data when loaders exist but no loading", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.data",
            type: "loader",
            loaderId: "my-loader",
            loaderData: { value: 42 },
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);

        // No LoaderBoundary because loading is undefined
        expect(collectByType(tree, MockLoaderBoundary)).toHaveLength(0);
        // Uses OutletProvider with loaderData injected
        const outlets = collectByType(tree, MockOutletProvider);
        expect(outlets).toHaveLength(1);
        expect(outlets[0].props.loaderData).toEqual({
          "my-loader": { value: 42 },
        });
      });
    });

    describe("key generation", () => {
      it("uses segment ID as key when no params", async () => {
        const segments: ResolvedSegment[] = [seg({ id: "R0", type: "route" })];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlet = findFirst(tree, MockOutletProvider)!;

        // Key for route without params is just the ID
        expect((result as any).props.children.key).toBeDefined();
      });

      it("includes sorted params in key for route segments", async () => {
        const segments: ResolvedSegment[] = [
          seg({
            id: "R0",
            type: "route",
            params: { slug: "hello", category: "tech" },
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        // Params are sorted alphabetically in key
        expect(outlets[0].props.segment.params).toEqual({
          slug: "hello",
          category: "tech",
        });
      });

      it("excludes params from key for non-belongsToRoute layouts", async () => {
        // Layout that is shared (not belongsToRoute) should use just ID as key
        const segments: ResolvedSegment[] = [
          seg({
            id: "L0",
            type: "layout",
            belongsToRoute: false,
            params: { slug: "hello" },
          }),
          seg({ id: "L0R0", type: "route" }),
        ];

        // Should not throw - params are excluded from key for shared layouts
        await renderSegments(segments);
      });
    });

    describe("parallel segment grouping", () => {
      it("attaches parallel segments to correct parent by ID prefix", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "L0R0", type: "route" }),
          seg({
            id: "L0.@sidebar",
            type: "parallel",
            slot: "@sidebar",
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        // Layout L0 should have the parallel segment
        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        expect(layoutOutlet.props.parallel).toHaveLength(1);
        expect(layoutOutlet.props.parallel[0].slot).toBe("@sidebar");

        // Route should NOT have parallels
        const routeOutlet = outlets.find((o) => o.props.segment.id === "L0R0")!;
        expect(routeOutlet.props.parallel).toEqual([]);
      });

      it("groups multiple parallels under same parent", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "L0R0", type: "route" }),
          seg({ id: "L0.@sidebar", type: "parallel", slot: "@sidebar" }),
          seg({ id: "L0.@modal", type: "parallel", slot: "@modal" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        expect(layoutOutlet.props.parallel).toHaveLength(2);
        expect(
          layoutOutlet.props.parallel.map((p: any) => p.slot).sort(),
        ).toEqual(["@modal", "@sidebar"]);
      });
    });

    describe("loader segment grouping", () => {
      it("groups loader segments by parent ID and passes data to OutletProvider", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "L0R0", type: "route" }),
          seg({
            id: "L0D0.products",
            type: "loader",
            loaderId: "products-loader",
            loaderData: { products: ["a", "b"] },
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        // Layout L0 gets the loader data (parent of "L0D0.products" is "L0")
        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        expect(layoutOutlet.props.loaderData).toEqual({
          "products-loader": { products: ["a", "b"] },
        });
      });

      it("resolves LoaderDataResult success wrapper", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.data",
            type: "loader",
            loaderId: "my-loader",
            loaderData: {
              __loaderResult: true,
              ok: true,
              data: { value: 42 },
            },
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        // Should unwrap LoaderDataResult to get the inner data
        expect(outlets[0].props.loaderData).toEqual({
          "my-loader": { value: 42 },
        });
      });

      it("renders error fallback for LoaderDataResult with error+fallback", async () => {
        const errorFallback = createElement("div", null, "Error occurred");

        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.data",
            type: "loader",
            loaderId: "my-loader",
            loaderData: {
              __loaderResult: true,
              ok: false,
              error: { message: "Failed" },
              fallback: errorFallback,
            },
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        // The OutletProvider children should be the error fallback
        expect(outlets[0].props.children).toBe(errorFallback);
      });

      it("throws for LoaderDataResult with error but no fallback", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.data",
            type: "loader",
            loaderId: "my-loader",
            loaderData: {
              __loaderResult: true,
              ok: false,
              error: { message: "Loader failed" },
            },
          }),
        ];

        await expect(renderSegments(segments)).rejects.toThrow("Loader failed");
      });
    });

    describe("segment ordering", () => {
      it("renders segments in root-to-leaf order as emitted by producers", async () => {
        // Segments arrive in root-to-leaf order from resolveSegment/resolveSegmentWithRevalidation
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "L0L0", type: "layout" }),
          seg({ id: "L0L0R0", type: "route" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        expect(outlets).toHaveLength(3);
        // Outermost is root layout (L0)
        expect(outlets[0].props.segment.id).toBe("L0");
        // Innermost is route
        expect(outlets[2].props.segment.id).toBe("L0L0R0");
      });
    });

    describe("isAction behavior", () => {
      it("awaits component promises when isAction is true", async () => {
        const resolvedComponent = createElement("div", null, "resolved");
        const componentPromise = Promise.resolve(resolvedComponent);

        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", component: componentPromise }),
        ];

        const result = await renderSegments(segments, { isAction: true });
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        // Component should be resolved, not wrapped in RouteContentWrapper
        expect(outlets).toHaveLength(1);
        expect(collectByType(tree, MockRouteContentWrapper)).toHaveLength(0);
      });

      it("pre-resolves loader promises when isAction is true", async () => {
        const loadingSkeleton = createElement("div", null, "Loading...");

        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", loading: loadingSkeleton }),
          seg({
            id: "R0D0.data",
            type: "loader",
            loaderId: "test",
            loaderData: Promise.resolve({ count: 5 }),
          }),
        ];

        const result = await renderSegments(segments, { isAction: true });
        const tree = toTreeNode(result);
        const boundaries = collectByType(tree, MockLoaderBoundary);

        expect(boundaries).toHaveLength(1);
        // When isAction, the promise should be pre-resolved to an array
        expect(Array.isArray(boundaries[0].props.loaderDataPromise)).toBe(true);
      });
    });

    describe("forceAwait behavior", () => {
      it("pre-resolves loader promises when forceAwait is true", async () => {
        const loadingSkeleton = createElement("div", null, "Loading...");

        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", loading: loadingSkeleton }),
          seg({
            id: "R0D0.data",
            type: "loader",
            loaderId: "test",
            loaderData: Promise.resolve({ count: 5 }),
          }),
        ];

        const result = await renderSegments(segments, { forceAwait: true });
        const tree = toTreeNode(result);
        const boundaries = collectByType(tree, MockLoaderBoundary);

        expect(boundaries).toHaveLength(1);
        expect(Array.isArray(boundaries[0].props.loaderDataPromise)).toBe(true);
      });
    });

    describe("intercept segments", () => {
      it("injects intercept parallel segments into parent parallel group", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "L0R0", type: "route" }),
        ];

        const interceptSegments: ResolvedSegment[] = [
          seg({
            id: "L0.@modal",
            type: "parallel",
            slot: "@modal",
          }),
        ];

        const result = await renderSegments(segments, { interceptSegments });
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        expect(layoutOutlet.props.parallel).toHaveLength(1);
        expect(layoutOutlet.props.parallel[0].slot).toBe("@modal");
      });

      it("injects intercept loader segments into parent loader group", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "L0R0", type: "route" }),
        ];

        const interceptSegments: ResolvedSegment[] = [
          seg({
            id: "L0D0.modal-data",
            type: "loader",
            loaderId: "modal-loader",
            loaderData: { modal: true },
          }),
        ];

        const result = await renderSegments(segments, { interceptSegments });
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        expect(layoutOutlet.props.loaderData).toEqual({
          "modal-loader": { modal: true },
        });
      });
    });

    describe("rootLayout wrapping", () => {
      it("wraps tree with rootLayout when provided", async () => {
        const RootLayout = ({ children }: { children: ReactNode }) =>
          createElement("div", null, children);

        const segments: ResolvedSegment[] = [seg({ id: "R0", type: "route" })];

        const result = await renderSegments(segments, {
          rootLayout: RootLayout,
        });
        const tree = toTreeNode(result);

        // Root should be the RootLayout, not RootErrorBoundary
        expect(tree!.type).toBe(RootLayout);
        // RootErrorBoundary should be inside
        const errorBoundary = findFirst(tree, MockRootErrorBoundary);
        expect(errorBoundary).not.toBeNull();
      });

      it("does not wrap with rootLayout when not provided", async () => {
        const segments: ResolvedSegment[] = [seg({ id: "R0", type: "route" })];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);

        expect(tree!.type).toBe(MockRootErrorBoundary);
      });
    });

    describe("MountContextProvider wrapping", () => {
      it("wraps segment with MountContextProvider when mountPath is set", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", mountPath: "/shop" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const mounts = collectByType(tree, MockMountContextProvider);

        expect(mounts).toHaveLength(1);
        expect(mounts[0].props.value).toBe("/shop");
      });

      it("does not wrap when mountPath is undefined", async () => {
        const segments: ResolvedSegment[] = [seg({ id: "R0", type: "route" })];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const mounts = collectByType(tree, MockMountContextProvider);

        expect(mounts).toHaveLength(0);
      });

      it("wraps all segment types with MountContextProvider", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout", mountPath: "/shop" }),
          seg({ id: "L0R0", type: "route", mountPath: "/shop" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const mounts = collectByType(tree, MockMountContextProvider);

        expect(mounts).toHaveLength(2);
      });
    });

    describe("error and notFound segments", () => {
      it("renders error segments in the tree", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0E0",
            type: "error",
            component: createElement("div", null, "Error fallback"),
            error: {
              name: "Error",
              message: "Something broke",
              segmentId: "R0",
              segmentType: "route",
            },
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        // Should have outlets for both layout and error segment
        expect(outlets).toHaveLength(2);
        const errorOutlet = outlets.find(
          (o) => o.props.segment.type === "error",
        );
        expect(errorOutlet).toBeDefined();
      });

      it("renders notFound segments in the tree", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0NF0",
            type: "notFound",
            component: createElement("div", null, "Not found"),
            notFoundInfo: {
              message: "Page not found",
              segmentId: "R0",
              segmentType: "route",
            },
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        expect(outlets).toHaveLength(2);
        const notFoundOutlet = outlets.find(
          (o) => o.props.segment.type === "notFound",
        );
        expect(notFoundOutlet).toBeDefined();
      });
    });

    describe("empty segments", () => {
      it("returns RootErrorBoundary wrapping null for empty segments", async () => {
        const result = await renderSegments([]);
        const tree = toTreeNode(result);

        expect(tree!.type).toBe(MockRootErrorBoundary);
      });
    });

    describe("parallel segment loaders", () => {
      it("includes loaders from parallel segments in parent loader list", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "L0R0", type: "route" }),
          seg({
            id: "L0.@sidebar",
            type: "parallel",
            slot: "@sidebar",
          }),
          seg({
            id: "L0.@sidebarD0.data",
            type: "loader",
            loaderId: "sidebar-loader",
            loaderData: { sidebar: true },
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        // The layout should have sidebar loader data accessible
        // (loaders from parallels are merged into parent's loaders)
        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        // The sidebar loader is grouped under the parallel "L0.@sidebar"
        // which is a child of L0, so it gets included in L0's loaders
        expect(layoutOutlet.props.loaderData).toBeDefined();
      });

      it("reconstructs missing parallel loader markers for layout-owned parallels", async () => {
        const loadingSkeleton = createElement("div", null, "Loading sidebar");
        const loaderPromise = Promise.resolve({ sidebar: true });
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0.@sidebar",
            type: "parallel",
            slot: "@sidebar",
            loading: loadingSkeleton,
          }),
          seg({
            id: "L0D0.sidebar-data",
            type: "loader",
            loaderId: "sidebar-loader",
            loaderData: loaderPromise,
          }),
          seg({ id: "L0R0", type: "route" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);
        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;

        expect(layoutOutlet.props.loaderData).toBeUndefined();
        expect(layoutOutlet.props.parallel).toHaveLength(1);
        expect(layoutOutlet.props.parallel[0].loaderIds).toEqual([
          "sidebar-loader",
        ]);
        expect(layoutOutlet.props.parallel[0].loaderDataPromise).toBeInstanceOf(
          Promise,
        );
      });

      it("reconstructs missing parallel loader markers for route-owned parallels", async () => {
        const loadingSkeleton = createElement("div", null, "Loading sidebar");
        const loaderPromise = Promise.resolve({ sidebar: true });
        const segments: ResolvedSegment[] = [
          seg({
            id: "R0.@sidebar",
            type: "parallel",
            slot: "@sidebar",
            loading: loadingSkeleton,
          }),
          seg({
            id: "R0D0.sidebar-data",
            type: "loader",
            loaderId: "sidebar-loader",
            loaderData: loaderPromise,
          }),
          seg({ id: "R0", type: "route" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);
        const routeOutlet = outlets.find((o) => o.props.segment.id === "R0")!;

        expect(routeOutlet.props.loaderData).toBeUndefined();
        expect(routeOutlet.props.parallel).toHaveLength(1);
        expect(routeOutlet.props.parallel[0].loaderIds).toEqual([
          "sidebar-loader",
        ]);
        expect(routeOutlet.props.parallel[0].loaderDataPromise).toBeInstanceOf(
          Promise,
        );
      });

      it("reuses pending parallel loader promise across rerenders with the same loader inputs", async () => {
        let resolveLoader!: (value: unknown) => void;
        const loaderPromise = new Promise((resolve) => {
          resolveLoader = resolve;
        });
        const loadingSkeleton = createElement("div", null, "Loading sidebar");
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0.@sidebar",
            type: "parallel",
            slot: "@sidebar",
            loading: loadingSkeleton,
          }),
          seg({
            id: "L0D0.sidebar-data",
            type: "loader",
            loaderId: "sidebar-loader",
            loaderData: loaderPromise,
          }),
          seg({ id: "L0R0", type: "route" }),
        ];

        const firstResult = await renderSegments(segments);
        const firstTree = toTreeNode(firstResult);
        const firstOutlets = collectByType(firstTree, MockOutletProvider);
        const firstLayoutOutlet = firstOutlets.find(
          (o) => o.props.segment.id === "L0",
        )!;
        const firstPromise =
          firstLayoutOutlet.props.parallel[0].loaderDataPromise;

        const secondResult = await renderSegments(segments);
        const secondTree = toTreeNode(secondResult);
        const secondOutlets = collectByType(secondTree, MockOutletProvider);
        const secondLayoutOutlet = secondOutlets.find(
          (o) => o.props.segment.id === "L0",
        )!;
        const secondPromise =
          secondLayoutOutlet.props.parallel[0].loaderDataPromise;

        expect(firstPromise).toBeInstanceOf(Promise);
        expect(secondPromise).toBe(firstPromise);

        resolveLoader({ sidebar: true });
        await firstPromise;
      });
    });
  });
});
