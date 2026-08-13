// @vitest-environment happy-dom
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
function MockStreamedLoaderErrorBoundary(props: any) {
  return props.children;
}
function MockMountContextProvider(props: any) {
  return props.children;
}
function MockRootErrorBoundary(props: any) {
  return props.children;
}

vi.mock("../outlet-provider.js", () => ({
  OutletProvider: MockOutletProvider,
}));

vi.mock("../browser/react/mount-context.js", () => ({
  MountContextProvider: MockMountContextProvider,
}));

vi.mock("../route-content-wrapper.js", () => ({
  RouteContentWrapper: MockRouteContentWrapper,
  LoaderBoundary: MockLoaderBoundary,
  StreamedLoaderErrorBoundary: MockStreamedLoaderErrorBoundary,
}));

vi.mock("../root-error-boundary.js", () => ({
  RootErrorBoundary: MockRootErrorBoundary,
}));

import { renderSegments } from "../segment-system";
import {
  decodeLoaderEntry,
  LOADER_ERROR_FALLBACK,
} from "../decode-loader-results";

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

      it("streams per-loader entries through OutletProvider.loaderStreams when loaders exist but no loading", async () => {
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
        // Streaming lanes no longer block the tree build: the UNDECODED
        // per-loader entry rides loaderStreams and useLoader decodes (and
        // suspends, when pending) at the read site.
        const outlets = collectByType(tree, MockOutletProvider);
        expect(outlets).toHaveLength(1);
        expect(outlets[0].props.loaderData).toBeUndefined();
        expect(outlets[0].props.loaderStreams).toEqual({
          "my-loader": { value: 42 },
        });
      });

      it("delivers { ssr: false } loaders as SETTLED values in loaderStreams; unflagged siblings keep the promise", async () => {
        // The SSR-completeness contract must hold by construction, not by the
        // read site's use() winning a Flight-chunk scheduling race: a flagged
        // segment's stream entry is the awaited result (decoded synchronously
        // at the read site), the sibling stays a pending promise, and the
        // flagged id rides awaitedLoaderIds for the dev diagnostic.
        const pendingSibling = new Promise(() => {});
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.flagged",
            type: "loader",
            loaderId: "flagged-loader",
            awaitBeforeFlush: true,
            loaderData: Promise.resolve({ ok: true, data: "settled" }),
          }),
          seg({
            id: "R0D1.plain",
            type: "loader",
            loaderId: "plain-loader",
            loaderData: pendingSibling,
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);

        const outlets = collectByType(tree, MockOutletProvider);
        expect(outlets).toHaveLength(1);
        const streams = outlets[0].props.loaderStreams;
        expect(streams["flagged-loader"]).toEqual({
          ok: true,
          data: "settled",
        });
        expect(streams["flagged-loader"]).not.toBeInstanceOf(Promise);
        expect(streams["plain-loader"]).toBe(pendingSibling);
        expect(outlets[0].props.awaitedLoaderIds).toEqual(["flagged-loader"]);
      });

      it("delivers { ssr: false } loaders as SETTLED values through the LoaderBoundary streams too", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", loading: "Loading..." }),
          seg({
            id: "R0D0.flagged",
            type: "loader",
            loaderId: "flagged-loader",
            awaitBeforeFlush: true,
            loaderData: Promise.resolve({ ok: true, data: "settled" }),
          }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);

        const boundaries = collectByType(tree, MockLoaderBoundary);
        expect(boundaries).toHaveLength(1);
        expect(boundaries[0].props.loaderStreams["flagged-loader"]).toEqual({
          ok: true,
          data: "settled",
        });
        expect(boundaries[0].props.awaitedLoaderIds).toEqual([
          "flagged-loader",
        ]);
      });

      it("awaits and decodes loader data on forceAwait lanes (no loading)", async () => {
        // popstate / stale-revalidation / fully-prefetched commits must stay
        // whole: the awaited lane still provides DECODED loaderData and no
        // stream channel, so nothing suspends at the read site.
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.data",
            type: "loader",
            loaderId: "my-loader",
            loaderData: { value: 42 },
          }),
        ];

        const result = await renderSegments(segments, { forceAwait: true });
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);
        expect(outlets).toHaveLength(1);
        expect(outlets[0].props.loaderStreams).toBeUndefined();
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

      it("uses a param-agnostic key for a route in a transition scope, param-bearing otherwise", async () => {
        // transition() opt-in: a route in a transition scope drops the param
        // from its key so a same-route param change reconciles (holds content)
        // instead of remounting. Without transition() the key keeps the param
        // (the default: remount on param change). This pins the contract that
        // segment-system.tsx's inTransitionScope derivation encodes.
        const inScope = await renderSegments([
          seg({ id: "R0", type: "route", params: { id: "1" }, transition: {} }),
        ]);
        const notInScope = await renderSegments([
          seg({ id: "R0", type: "route", params: { id: "1" } }),
        ]);

        // result is the RootErrorBoundary wrapper; its child is the route's
        // OutletProvider, whose React key is the computed segment key.
        expect((inScope as any).props.children.key).toBe("R0");
        expect((notInScope as any).props.children.key).toBe("R0-id=1");
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

        // Layout L0 gets the loader stream (parent of "L0D0.products" is "L0")
        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        expect(layoutOutlet.props.loaderStreams).toEqual({
          "products-loader": { products: ["a", "b"] },
        });
      });

      it("streams the LoaderDataResult success wrapper undecoded; the read site unwraps it", async () => {
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

        // The wrapper crosses the stream channel intact; decodeLoaderEntry
        // (useLoader's read-site decode) unwraps it.
        const entry = outlets[0].props.loaderStreams["my-loader"];
        expect(entry).toEqual({
          __loaderResult: true,
          ok: true,
          data: { value: 42 },
        });
        expect(decodeLoaderEntry(entry)).toEqual({ value: 42 });
      });

      it("streams an error entry; the thrown error carries the boundary fallback for StreamedLoaderErrorBoundary", async () => {
        // Read-site error routing: the build no longer swaps children for the
        // errorBoundary() fallback — the undecoded error entry streams to the
        // read site, decodeLoaderEntry throws with the fallback riding the
        // error via LOADER_ERROR_FALLBACK, and the router-owned
        // StreamedLoaderErrorBoundary (wrapped around every loader-bearing
        // segment's children) renders it.
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

        // Children are NOT replaced at build time; the boundary wrapper is in
        // place and the error entry rides the stream.
        expect(outlets[0].props.children).not.toBe(errorFallback);
        expect(
          collectByType(tree, MockStreamedLoaderErrorBoundary),
        ).toHaveLength(1);
        const entry = outlets[0].props.loaderStreams["my-loader"];
        let thrown: unknown;
        try {
          decodeLoaderEntry(entry);
        } catch (e) {
          thrown = e;
        }
        expect((thrown as Error).message).toBe("Failed");
        expect((thrown as any)[LOADER_ERROR_FALLBACK]).toBe(errorFallback);
      });

      it("no longer rejects the tree build for a loader error; the error surfaces at the read site", async () => {
        // Error TIMING moved: the build used to await + throw here. Streaming
        // lanes complete the build and the reconstructed error (name/stack/
        // code preserved) throws from decodeLoaderEntry during render.
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

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);
        const entry = outlets[0].props.loaderStreams["my-loader"];
        expect(() => decodeLoaderEntry(entry)).toThrow("Loader failed");
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
        expect(layoutOutlet.props.loaderStreams).toEqual({
          "modal-loader": { modal: true },
        });
      });

      it("attaches an intercept slot loader whose slot name contains an uppercase 'D'", async () => {
        // Regression: parent extraction used segment.id.split("D")[0], which cut
        // the loader id at the first bare 'D'. For an intercept slot loader
        // `${parent}.${slotName}D${i}.${loaderId}`, a slot name containing an
        // uppercase 'D' (e.g. @Detail) cut inside the slot name, so the loader
        // matched no parent and its data was silently dropped.
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "L0R0", type: "route" }),
        ];

        const interceptSegments: ResolvedSegment[] = [
          seg({ id: "L0.@Detail", type: "parallel", slot: "@Detail" }),
          seg({
            id: "L0.@DetailD0.detail-data",
            type: "loader",
            loaderId: "detail-loader",
            loaderData: { detail: true },
          }),
        ];

        const result = await renderSegments(segments, { interceptSegments });
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);

        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        expect(layoutOutlet.props.loaderStreams).toEqual({
          "detail-loader": { detail: true },
        });
      });

      it("wraps a layout's outlet content with ViewTransition, not the layout component itself", async () => {
        // The VT wrap must sit between the layout and the inner route segment,
        // not above the layout component. Otherwise sibling parallel slots
        // (e.g. <ParallelOutlet name="@modal" />) count as subtree updates of
        // the layout VT and React's commit walker fires startViewTransition on
        // intercept commits, hoisting view-transition-named elements above the
        // modal overlay.
        //
        // segment-system captures React.ViewTransition eagerly at module load,
        // so mock the react module and re-import the module fresh so the
        // top-level const is re-evaluated.
        function MockViewTransition(props: any) {
          return props.children;
        }
        const actualReact = await vi.importActual<any>("react");
        vi.doMock("react", () => ({
          ...actualReact,
          ViewTransition: MockViewTransition,
          default: { ...actualReact, ViewTransition: MockViewTransition },
        }));
        vi.resetModules();
        try {
          const { renderSegments: renderSegmentsFresh } =
            await import("../segment-system");

          const layout = seg({
            id: "L0",
            type: "layout",
            transition: { default: "fade" } as any,
          });
          const route = seg({ id: "L0R0", type: "route" });

          const result = await renderSegmentsFresh([layout, route]);
          const tree = toTreeNode(result);
          const layoutOutlet = collectByType(tree, MockOutletProvider).find(
            (o) => o.props.segment.id === "L0",
          )!;

          const findVTIn = (n: ReactNode) =>
            findFirst(toTreeNode(n), MockViewTransition);

          // VT lives in the layout's `content` channel (what <Outlet /> renders),
          // not its `children` channel (the layout component itself).
          expect(findVTIn(layoutOutlet.props.content)).not.toBeNull();
          expect(findVTIn(layoutOutlet.props.content)?.props.default).toBe(
            "fade",
          );
          expect(findVTIn(layoutOutlet.props.children)).toBeNull();
        } finally {
          vi.doUnmock("react");
          vi.resetModules();
        }
      });

      it("pushes ancestor layout ViewTransition into descendant default outlet content", async () => {
        function MockViewTransition(props: any) {
          return props.children;
        }
        const actualReact = await vi.importActual<any>("react");
        vi.doMock("react", () => ({
          ...actualReact,
          ViewTransition: MockViewTransition,
          default: { ...actualReact, ViewTransition: MockViewTransition },
        }));
        vi.resetModules();
        try {
          const { renderSegments: renderSegmentsFresh } =
            await import("../segment-system");

          const outer = seg({
            id: "L0",
            type: "layout",
            transition: { default: "outer-fade" } as any,
          });
          const inner = seg({ id: "L0L0", type: "layout" });
          const route = seg({ id: "L0L0R0", type: "route" });
          const interceptSegments: ResolvedSegment[] = [
            seg({
              id: "L0L0.@modal",
              type: "parallel",
              slot: "@modal",
            }),
          ];

          const normalResult = await renderSegmentsFresh([outer, inner, route]);
          const normalOuterOutlet = collectByType(
            toTreeNode(normalResult),
            MockOutletProvider,
          ).find((o) => o.props.segment.id === "L0")!;
          const normalInnerOutlet = collectByType(
            toTreeNode(normalResult),
            MockOutletProvider,
          ).find((o) => o.props.segment.id === "L0L0")!;
          const findVTIn = (n: ReactNode) =>
            findFirst(toTreeNode(n), MockViewTransition);

          expect(toTreeNode(normalOuterOutlet.props.content)?.type).toBe(
            MockOutletProvider,
          );
          expect(findVTIn(normalInnerOutlet.props.content)?.props.default).toBe(
            "outer-fade",
          );

          const interceptResult = await renderSegmentsFresh(
            [outer, inner, route],
            { interceptSegments },
          );
          const interceptOuterOutlet = collectByType(
            toTreeNode(interceptResult),
            MockOutletProvider,
          ).find((o) => o.props.segment.id === "L0")!;
          const interceptInnerOutlet = collectByType(
            toTreeNode(interceptResult),
            MockOutletProvider,
          ).find((o) => o.props.segment.id === "L0L0")!;

          expect(toTreeNode(interceptOuterOutlet.props.content)?.type).toBe(
            MockOutletProvider,
          );
          expect(
            findVTIn(interceptInnerOutlet.props.content)?.props.default,
          ).toBe("outer-fade");
        } finally {
          vi.doUnmock("react");
          vi.resetModules();
        }
      });

      it("retains the same default outlet and intercept slot shape during modal actions", async () => {
        function MockViewTransition(props: any) {
          return props.children;
        }
        const actualReact = await vi.importActual<any>("react");
        vi.doMock("react", () => ({
          ...actualReact,
          ViewTransition: MockViewTransition,
          default: { ...actualReact, ViewTransition: MockViewTransition },
        }));
        vi.resetModules();
        try {
          const { renderSegments: renderSegmentsFresh } =
            await import("../segment-system");

          const outer = seg({
            id: "L0",
            type: "layout",
            transition: { default: "outer-fade" } as any,
          });
          const inner = seg({ id: "L0L0", type: "layout" });
          const route = seg({ id: "L0L0R0", type: "route" });
          const interceptSegments: ResolvedSegment[] = [
            seg({
              id: "L0L0.@modal",
              namespace: "intercept:modal",
              type: "parallel",
              slot: "@modal",
              layout: createElement("div", null, "modal-layout"),
              component: createElement("form", null, "modal-action"),
            }),
          ];

          const render = async (isAction: boolean) => {
            const result = await renderSegmentsFresh([outer, inner, route], {
              isAction,
              interceptSegments,
            });
            const outlets = collectByType(
              toTreeNode(result),
              MockOutletProvider,
            );
            return {
              outer: outlets.find((o) => o.props.segment.id === "L0")!,
              inner: outlets.find((o) => o.props.segment.id === "L0L0")!,
            };
          };

          const beforeAction = await render(false);
          const afterAction = await render(true);
          const findVTIn = (n: ReactNode) =>
            findFirst(toTreeNode(n), MockViewTransition);

          expect(toTreeNode(beforeAction.outer.props.content)?.type).toBe(
            MockOutletProvider,
          );
          expect(toTreeNode(afterAction.outer.props.content)?.type).toBe(
            MockOutletProvider,
          );

          expect(
            findVTIn(beforeAction.inner.props.content)?.props.default,
          ).toBe("outer-fade");
          expect(findVTIn(afterAction.inner.props.content)?.props.default).toBe(
            "outer-fade",
          );

          expect(beforeAction.inner.props.parallel).toHaveLength(1);
          expect(afterAction.inner.props.parallel).toHaveLength(1);
          expect(beforeAction.inner.props.parallel[0].slot).toBe("@modal");
          expect(afterAction.inner.props.parallel[0].slot).toBe("@modal");
          expect(beforeAction.inner.props.parallel[0].layout).toBeDefined();
          expect(afterAction.inner.props.parallel[0].layout).toBeDefined();
          expect(findVTIn(beforeAction.inner.props.parallel[0].component)).toBe(
            null,
          );
          expect(findVTIn(afterAction.inner.props.parallel[0].component)).toBe(
            null,
          );
        } finally {
          vi.doUnmock("react");
          vi.resetModules();
        }
      });

      it("wraps a leaf route's component itself when the route has a transition", async () => {
        // Routes have no <Outlet /> or parallel slots, so the wrap stays
        // around the route's own component.
        function MockViewTransition(props: any) {
          return props.children;
        }
        const actualReact = await vi.importActual<any>("react");
        vi.doMock("react", () => ({
          ...actualReact,
          ViewTransition: MockViewTransition,
          default: { ...actualReact, ViewTransition: MockViewTransition },
        }));
        vi.resetModules();
        try {
          const { renderSegments: renderSegmentsFresh } =
            await import("../segment-system");

          const route = seg({
            id: "R0",
            type: "route",
            transition: { default: "fade" } as any,
          });

          const result = await renderSegmentsFresh([route]);
          const tree = toTreeNode(result);
          const routeOutlet = collectByType(tree, MockOutletProvider).find(
            (o) => o.props.segment.id === "R0",
          )!;

          const findVTIn = (n: ReactNode) =>
            findFirst(toTreeNode(n), MockViewTransition);

          // Route has no outlet content; the VT wraps nodeContent (children).
          expect(findVTIn(routeOutlet.props.children)).not.toBeNull();
          expect(findVTIn(routeOutlet.props.children)?.props.default).toBe(
            "fade",
          );
        } finally {
          vi.doUnmock("react");
          vi.resetModules();
        }
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
        // which is a child of L0, so it gets included in L0's loader streams
        expect(layoutOutlet.props.loaderStreams).toBeDefined();
      });

      it("reconstructs missing parallel loader markers for layout-owned parallels", async () => {
        const loadingSkeleton = createElement("div", null, "Loading sidebar");
        const loaderPromise = Promise.resolve({ sidebar: true });
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0.@sidebar",
            namespace: "parallel.sidebar",
            type: "parallel",
            slot: "@sidebar",
            loading: loadingSkeleton,
          }),
          seg({
            id: "L0D0.sidebar-data",
            namespace: "parallel.sidebar",
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
            namespace: "parallel.sidebar",
            type: "parallel",
            slot: "@sidebar",
            loading: loadingSkeleton,
          }),
          seg({
            id: "R0D0.sidebar-data",
            namespace: "parallel.sidebar",
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

      it("keeps parallel-owned loaders isolated per parallel definition", async () => {
        const sidebarLoading = createElement("div", null, "Loading sidebar");
        const modalLoading = createElement("div", null, "Loading modal");
        const sidebarLoaderPromise = Promise.resolve({ sidebar: true });
        const modalLoaderPromise = Promise.resolve({ modal: true });
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0.@sidebar",
            namespace: "parallel.sidebar",
            type: "parallel",
            slot: "@sidebar",
            loading: sidebarLoading,
          }),
          seg({
            id: "L0.@modal",
            namespace: "parallel.modal",
            type: "parallel",
            slot: "@modal",
            loading: modalLoading,
          }),
          seg({
            id: "L0D0.sidebar-data",
            namespace: "parallel.sidebar",
            type: "loader",
            loaderId: "sidebar-loader",
            loaderData: sidebarLoaderPromise,
          }),
          seg({
            id: "L0D1.modal-data",
            namespace: "parallel.modal",
            type: "loader",
            loaderId: "modal-loader",
            loaderData: modalLoaderPromise,
          }),
          seg({ id: "L0R0", type: "route" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);
        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        const sidebarParallel = layoutOutlet.props.parallel.find(
          (p: ResolvedSegment) => p.slot === "@sidebar",
        ) as ResolvedSegment;
        const modalParallel = layoutOutlet.props.parallel.find(
          (p: ResolvedSegment) => p.slot === "@modal",
        ) as ResolvedSegment;

        expect(sidebarParallel.loaderIds).toEqual(["sidebar-loader"]);
        expect(modalParallel.loaderIds).toEqual(["modal-loader"]);
        expect(sidebarParallel.loaderDataPromise).toBeInstanceOf(Promise);
        expect(modalParallel.loaderDataPromise).toBeInstanceOf(Promise);
        expect(sidebarParallel.loaderDataPromise).not.toBe(
          modalParallel.loaderDataPromise,
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
            namespace: "parallel.sidebar",
            type: "parallel",
            slot: "@sidebar",
            loading: loadingSkeleton,
          }),
          seg({
            id: "L0D0.sidebar-data",
            namespace: "parallel.sidebar",
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

      it("delivers a flagged parallel-owned loader as a settled stream; unflagged sibling stays a promise", async () => {
        const pendingSibling = new Promise(() => {});
        const loadingSkeleton = createElement("div", null, "Loading sidebar");
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0.@sidebar",
            namespace: "parallel.sidebar",
            type: "parallel",
            slot: "@sidebar",
            loading: loadingSkeleton,
          }),
          seg({
            id: "L0D0.flagged",
            namespace: "parallel.sidebar",
            type: "loader",
            loaderId: "flagged-loader",
            awaitBeforeFlush: true,
            loaderData: Promise.resolve({ ok: true, data: "settled" }),
          }),
          seg({
            id: "L0D1.plain",
            namespace: "parallel.sidebar",
            type: "loader",
            loaderId: "plain-loader",
            loaderData: pendingSibling,
          }),
          seg({ id: "L0R0", type: "route" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);
        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        const parallel = layoutOutlet.props.parallel[0] as ResolvedSegment;

        expect(parallel.loaderStreams!["flagged-loader"]).toEqual({
          ok: true,
          data: "settled",
        });
        expect(parallel.loaderStreams!["flagged-loader"]).not.toBeInstanceOf(
          Promise,
        );
        expect(parallel.loaderStreams!["plain-loader"]).toBe(pendingSibling);
        expect(parallel.awaitedLoaderIds).toEqual(["flagged-loader"]);
      });

      it.each([{ isAction: true }, { forceAwait: true }])(
        "clears stale parallel loaderStreams when %j so the aggregate is used",
        async (opts) => {
          const loadingSkeleton = createElement("div", null, "Loading cart");
          const segments: ResolvedSegment[] = [
            seg({ id: "L0", type: "layout" }),
            seg({
              id: "L0.@cart",
              namespace: "parallel.cart",
              type: "parallel",
              slot: "@cart",
              loading: loadingSkeleton,
              loaderStreams: {
                "cart-loader": { ok: true, data: { count: 0 } },
              },
              awaitedLoaderIds: ["cart-loader"],
            }),
            seg({
              id: "L0D0.cart",
              namespace: "parallel.cart",
              type: "loader",
              loaderId: "cart-loader",
              loaderData: Promise.resolve({ ok: true, data: { count: 1 } }),
            }),
            seg({ id: "L0R0", type: "route" }),
          ];

          const result = await renderSegments(segments, opts);
          const tree = toTreeNode(result);
          const outlets = collectByType(tree, MockOutletProvider);
          const layoutOutlet = outlets.find(
            (o) => o.props.segment.id === "L0",
          )!;
          const slot = layoutOutlet.props.parallel[0] as ResolvedSegment;

          expect(slot.loaderStreams).toBeUndefined();
          expect(slot.awaitedLoaderIds).toBeUndefined();
          expect(Array.isArray(slot.loaderDataPromise)).toBe(true);
        },
      );
    });

    describe("layout/route loader memoization", () => {
      // Regression guard for the intercept-flicker bug: reopening/closing an
      // intercept re-renders the background route, and a fresh Promise.all
      // would re-suspend LoaderBoundary and briefly commit the loading
      // skeleton even when the underlying loader data is already resolved.
      it("reuses the aggregate loaderDataPromise across rerenders when loader sources are unchanged", async () => {
        const loadingSkeleton = createElement("div", null, "Loading route");
        const loaderData = Promise.resolve({ foo: "bar" });
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0R0",
            type: "route",
            loading: loadingSkeleton,
          }),
          seg({
            id: "L0R0D0.data",
            type: "loader",
            loaderId: "route-loader",
            loaderData,
          }),
        ];

        const firstResult = await renderSegments(segments);
        const firstBoundary = collectByType(
          toTreeNode(firstResult),
          MockLoaderBoundary,
        ).find((b) => b.props.segment.id === "L0R0")!;
        const firstPromise = firstBoundary.props.loaderDataPromise;

        const secondResult = await renderSegments(segments);
        const secondBoundary = collectByType(
          toTreeNode(secondResult),
          MockLoaderBoundary,
        ).find((b) => b.props.segment.id === "L0R0")!;
        const secondPromise = secondBoundary.props.loaderDataPromise;

        expect(firstPromise).toBeInstanceOf(Promise);
        expect(secondPromise).toBe(firstPromise);
      });

      it("creates a new aggregate loaderDataPromise when a loader.loaderData ref changes", async () => {
        const loadingSkeleton = createElement("div", null, "Loading route");
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0R0",
            type: "route",
            loading: loadingSkeleton,
          }),
          seg({
            id: "L0R0D0.data",
            type: "loader",
            loaderId: "route-loader",
            loaderData: Promise.resolve({ foo: 1 }),
          }),
        ];

        const firstResult = await renderSegments(segments);
        const firstBoundary = collectByType(
          toTreeNode(firstResult),
          MockLoaderBoundary,
        ).find((b) => b.props.segment.id === "L0R0")!;
        const firstPromise = firstBoundary.props.loaderDataPromise;

        segments[2] = {
          ...segments[2],
          loaderData: Promise.resolve({ foo: 2 }),
        };

        const secondResult = await renderSegments(segments);
        const secondBoundary = collectByType(
          toTreeNode(secondResult),
          MockLoaderBoundary,
        ).find((b) => b.props.segment.id === "L0R0")!;
        const secondPromise = secondBoundary.props.loaderDataPromise;

        expect(firstPromise).toBeInstanceOf(Promise);
        expect(secondPromise).not.toBe(firstPromise);
      });

      // Regression guard: reconcileSegments produces fresh segment refs on
      // many paths (in-diff spread, mergeSegmentLoaders). Memoization now
      // lives in a module-level WeakMap keyed on loaderData/component refs
      // (not on the segment), so it survives reconcile inherently — this
      // integration test proves the render → reconcile → render path keeps
      // the aggregate Promise stable end to end.
      it("preserves the memoized loader promise across a reconcile that spreads the segment", async () => {
        const { reconcileSegments } =
          await import("../browser/segment-reconciler");
        const loadingSkeleton = createElement("div", null, "Loading route");
        const loaderData = Promise.resolve({ foo: "bar" });
        const initial: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0R0",
            type: "route",
            loading: loadingSkeleton,
          }),
          seg({
            id: "L0R0D0.data",
            type: "loader",
            loaderId: "route-loader",
            loaderData,
          }),
        ];

        const firstResult = await renderSegments(initial);
        const firstBoundary = collectByType(
          toTreeNode(firstResult),
          MockLoaderBoundary,
        ).find((b) => b.props.segment.id === "L0R0")!;
        const firstPromise = firstBoundary.props.loaderDataPromise;
        expect(firstPromise).toBeInstanceOf(Promise);

        // Simulate navigation where the server returns a fresh copy of L0R0
        // in the diff (common for intercept/parallel updates). The reconciler
        // produces a new segment ref; memoization must survive.
        const freshRouteSeg = seg({
          id: "L0R0",
          type: "route",
          loading: loadingSkeleton,
        });
        const reconciled = reconcileSegments({
          actor: "navigation",
          matched: ["L0", "L0R0", "L0R0D0.data"],
          diff: ["L0R0"],
          serverSegments: [freshRouteSeg],
          cachedSegments: initial,
        });

        const mergedRoute = reconciled.mainSegments.find(
          (s) => s.id === "L0R0",
        )!;
        expect(mergedRoute).not.toBe(initial[1]);

        const secondResult = await renderSegments(reconciled.mainSegments);
        const secondBoundary = collectByType(
          toTreeNode(secondResult),
          MockLoaderBoundary,
        ).find((b) => b.props.segment.id === "L0R0")!;
        expect(secondBoundary.props.loaderDataPromise).toBe(firstPromise);
      });

      it("keeps the cached segment ref when reconciling cached-only entries with truthy loading", async () => {
        const { reconcileSegments } =
          await import("../browser/segment-reconciler");
        const loadingSkeleton = createElement("div", null, "Loading route");
        const component = createElement("div", null, "route-body");
        const initial: ResolvedSegment[] = [
          seg({
            id: "R0",
            type: "route",
            component,
            loading: loadingSkeleton,
          }),
        ];

        const firstResult = await renderSegments(initial);
        const firstWrapper = collectByType(
          toTreeNode(firstResult),
          MockRouteContentWrapper,
        )[0];
        const firstContent = firstWrapper.props.content;
        expect(firstContent).toBeInstanceOf(Promise);

        // Cached-only entries stay as-is: renderSegments must stay in the
        // LoaderBoundary branch across partial updates (e.g., opening an
        // intercept) or React unmounts the whole chain beneath the outlet.
        const reconciled = reconcileSegments({
          actor: "navigation",
          matched: ["R0"],
          diff: [],
          serverSegments: [],
          cachedSegments: initial,
        });

        const mergedRoute = reconciled.mainSegments[0];
        expect(mergedRoute).toBe(initial[0]);
        expect(mergedRoute.loading).toBe(loadingSkeleton);

        const secondResult = await renderSegments(reconciled.mainSegments);
        const secondWrapper = collectByType(
          toTreeNode(secondResult),
          MockRouteContentWrapper,
        )[0];
        expect(secondWrapper.props.content).toBe(firstContent);
      });
    });
  });
});
