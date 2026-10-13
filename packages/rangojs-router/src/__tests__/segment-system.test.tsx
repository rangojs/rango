import { withOptimisticCommitNone } from "../browser/optimistic-commit.js";
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

// segment-system creates the audited variants outside a build
// (suspense-audit.ts): the same sentinel stands for both.
vi.mock("../outlet-provider.js", () => ({
  OutletProvider: MockOutletProvider,
  AuditedOutletProvider: MockOutletProvider,
}));

vi.mock("../browser/react/mount-context.js", () => ({
  MountContextProvider: MockMountContextProvider,
}));

vi.mock("../route-content-wrapper.js", () => ({
  RouteContentWrapper: MockRouteContentWrapper,
  AuditedRouteContent: MockRouteContentWrapper,
  LoaderBoundary: MockLoaderBoundary,
  AuditedLoaderBoundary: MockLoaderBoundary,
  StreamedLoaderErrorBoundary: MockStreamedLoaderErrorBoundary,
}));

vi.mock("../root-error-boundary.js", () => ({
  RootErrorBoundary: MockRootErrorBoundary,
}));

import { foldInterceptLoaders, renderSegments } from "../segment-system";
import { Defer } from "../browser/defer";
import { LoaderRedirect } from "../loader-redirect";
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
  key: string | null;
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

  return {
    type: el.type,
    typeName,
    key: el.key,
    props: el.props || {},
    children,
  };
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

      it("keys clientUrls() group routes by the group and gives them one wrapper shape", async () => {
        // Two routes of one group: different ids, params, and loading()
        // presence — same React key (group) and same wrapper chain, so an
        // in-group navigation reconciles instead of remounting.
        const findOutletElement = (node: ReactNode): ReactElement | null => {
          if (!node || typeof node !== "object") return null;
          const el = node as ReactElement;
          if (el.type === MockOutletProvider) return el;
          const props = el.props as Record<string, unknown>;
          for (const child of [
            props.children,
            props.content,
            props.outletContent,
          ]) {
            const found = findOutletElement(child as ReactNode);
            if (found) return found;
          }
          return null;
        };
        const withLoading = seg({
          id: "R0",
          type: "route",
          clientGroup: "/shop",
          params: { id: "1" },
          loading: createElement("p", null, "Loading"),
        });
        const plain = seg({ id: "R1", type: "route", clientGroup: "/shop" });

        for (const segment of [withLoading, plain]) {
          const result = await renderSegments([segment]);
          const tree = toTreeNode(result);
          expect(collectByType(tree, MockLoaderBoundary)).toHaveLength(0);
          expect(collectByType(tree, MockRouteContentWrapper)).toHaveLength(0);
          expect(
            collectByType(tree, MockStreamedLoaderErrorBoundary),
          ).toHaveLength(1);
          expect(findOutletElement(result)?.key).toBe("cg:/shop");
        }
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

      it("resolves a settled { ssr: false } redirect() to LoaderRedirect and replaces the whole page", async () => {
        // Document lane: the flagged result is settled before the tree is
        // built, and a read-site throw would land in the Fizz shell. The
        // redirect carrier replaces every segment (an ancestor reading the
        // loader would otherwise still throw); no OutletProvider renders.
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.flagged",
            type: "loader",
            loaderId: "flagged-loader",
            awaitBeforeFlush: true,
            loaderData: Promise.resolve({
              __loaderResult: true,
              ok: false,
              redirect: { to: "/login", state: { flash: "hi" } },
              error: { message: "Loader redirected to /login", name: "Error" },
              fallback: null,
            }),
          }),
        ];

        const tree = toTreeNode(await renderSegments(segments));
        const redirects = collectByType(tree, LoaderRedirect);
        expect(redirects).toHaveLength(1);
        expect(redirects[0].props).toEqual({
          to: "/login",
          state: { flash: "hi" },
        });
        expect(collectByType(tree, MockOutletProvider)).toHaveLength(0);
      });

      it("resolves a settled { ssr: false } notFound() to its fallback at the owning segment", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.flagged",
            type: "loader",
            loaderId: "flagged-loader",
            awaitBeforeFlush: true,
            loaderData: Promise.resolve({
              __loaderResult: true,
              ok: false,
              notFound: true,
              error: { message: "gone", name: "DataNotFoundError" },
              fallback: "not-found-ui",
            }),
          }),
        ];

        const tree = toTreeNode(await renderSegments(segments));
        const outlets = collectByType(tree, MockOutletProvider);
        expect(outlets).toHaveLength(1);
        expect(outlets[0].props.children).toBe("not-found-ui");
        expect(collectByType(tree, LoaderRedirect)).toHaveLength(0);
      });

      it("resolves a settled { ssr: false } redirect() through the LoaderBoundary branch too", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", loading: "Loading..." }),
          seg({
            id: "R0D0.flagged",
            type: "loader",
            loaderId: "flagged-loader",
            awaitBeforeFlush: true,
            loaderData: Promise.resolve({
              __loaderResult: true,
              ok: false,
              redirect: { to: "/login" },
              error: { message: "Loader redirected to /login", name: "Error" },
              fallback: null,
            }),
          }),
        ];

        const tree = toTreeNode(await renderSegments(segments));
        expect(collectByType(tree, LoaderRedirect)).toHaveLength(1);
        expect(collectByType(tree, MockLoaderBoundary)).toHaveLength(0);
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

      // The action lane awaits every loader before the commit, as
      // forceAwait does, but hands each settled entry to its read site
      // (buildLoaderStreams) instead of decoding the set in the build: a
      // loader that threw on its rerun throws in place at its useLoader read,
      // and the action resolves (dc-t28).
      it("hands settled per-loader streams to the loading() boundary when isAction is true", async () => {
        const loadingSkeleton = createElement("div", null, "Loading...");
        const entry = { __loaderResult: true, ok: true, data: { count: 5 } };

        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route", loading: loadingSkeleton }),
          seg({
            id: "R0D0.data",
            type: "loader",
            loaderId: "test",
            loaderData: Promise.resolve(entry),
          }),
        ];

        const result = await renderSegments(segments, { isAction: true });
        const tree = toTreeNode(result);
        const boundaries = collectByType(tree, MockLoaderBoundary);

        expect(boundaries).toHaveLength(1);
        expect(boundaries[0].props.loaderStreams).toEqual({ test: entry });
      });

      for (const loading of [
        undefined,
        createElement("div", null, "Loading..."),
      ]) {
        const lane = loading ? "with loading()" : "without loading()";
        it(`leaves a loader error to its read site, its errorBoundary() fallback riding the throw (${lane})`, async () => {
          const errorFallback = createElement("div", null, "Error occurred");
          const failed = {
            __loaderResult: true,
            ok: false,
            error: { message: "stock service unavailable" },
            fallback: errorFallback,
          };
          const loaderData = Promise.resolve(failed);
          const segments: ResolvedSegment[] = [
            seg({ id: "R0", type: "route", loading }),
            seg({
              id: "R0D0.stock",
              type: "loader",
              loaderId: "stock",
              loaderData,
            }),
          ];

          const tree = toTreeNode(
            await renderSegments(segments, { isAction: true }),
          );
          const [boundary] = collectByType(
            tree,
            MockStreamedLoaderErrorBoundary,
          );
          expect(boundary).toBeDefined();
          expect(boundary!.props.reset).toEqual(["R0", loaderData]);
          const holder = loading
            ? collectByType(tree, MockLoaderBoundary)[0]!
            : collectByType(tree, MockOutletProvider)[0]!;
          expect(holder.props.children).not.toBe(errorFallback);
          let thrown: unknown;
          try {
            decodeLoaderEntry(holder.props.loaderStreams.stock);
          } catch (e) {
            thrown = e;
          }
          expect((thrown as Error).message).toBe("stock service unavailable");
          expect((thrown as any)[LOADER_ERROR_FALLBACK]).toBe(errorFallback);
        });
      }

      it("does not reject the build for a loader error with no boundary when isAction is true", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.stock",
            type: "loader",
            loaderId: "stock",
            loaderData: Promise.resolve({
              __loaderResult: true,
              ok: false,
              error: { message: "stock service unavailable" },
              fallback: null,
            }),
          }),
        ];
        await expect(
          renderSegments(segments, { isAction: true }),
        ).resolves.toBeDefined();
      });

      it("still places a notFound() signal at build time when isAction is true", async () => {
        const notFoundUi = createElement("div", null, "Not found");
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.item",
            type: "loader",
            loaderId: "item",
            loaderData: Promise.resolve({
              __loaderResult: true,
              ok: false,
              notFound: true,
              error: { message: "gone" },
              fallback: notFoundUi,
            }),
          }),
        ];
        const tree = toTreeNode(
          await renderSegments(segments, { isAction: true }),
        );
        expect(collectByType(tree, MockOutletProvider)[0]!.props.children).toBe(
          notFoundUi,
        );
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

      // An intercept's loaders are loader segments of its slot
      // (router/intercept-resolution.ts); folded back onto the slot, the
      // page under the modal keeps its element tree (foldInterceptLoaders).
      const modalSegments = (
        loaderData: unknown[],
        loading?: ReactNode,
      ): ResolvedSegment[] => [
        seg({
          id: "L0.@modal",
          namespace: "intercept:item",
          type: "parallel",
          slot: "@modal",
          loading,
        }),
        ...loaderData.map((data, i) =>
          seg({
            id: `L0.@modalD${i}.loader${i}`,
            namespace: "intercept:item",
            type: "loader",
            loaderId: `loader${i}`,
            loaderData: data,
          }),
        ),
      ];
      const page = (): ResolvedSegment[] => [
        seg({ id: "L0", type: "layout" }),
        seg({ id: "L0R0", type: "route" }),
      ];
      const layoutOf = (result: ReactNode) =>
        collectByType(toTreeNode(result), MockOutletProvider).find(
          (o) => o.props.segment.id === "L0",
        )!;
      /** Element types from the root down to the layout's outlet. */
      const chainTo = (result: ReactNode, id: string): unknown[] => {
        const path: unknown[] = [];
        const walk = (node: TreeNode | null): boolean => {
          if (!node) return false;
          path.push(node.type);
          if (node.props.segment?.id === id) return true;
          if (node.children.some(walk)) return true;
          path.pop();
          return false;
        };
        walk(toTreeNode(result));
        return path;
      };

      it("folds intercept loader segments onto their slot, not the parent's loader group", async () => {
        const result = await renderSegments(page(), {
          interceptSegments: modalSegments([{ a: 1 }, { b: 2 }]),
        });
        const layout = layoutOf(result);
        expect(layout.props.loaderStreams).toBeUndefined();
        expect(
          findAll(toTreeNode(result), MockStreamedLoaderErrorBoundary),
        ).toEqual([]);
        const [slot] = layout.props.parallel;
        expect(slot.loaderIds).toEqual(["loader0", "loader1"]);
        // No loading(): settled before the commit, as the server's await was.
        expect(slot.loaderDataPromise).toEqual([{ a: 1 }, { b: 2 }]);
      });

      it("keeps the element types along the source layout's chain with the modal open", async () => {
        const closed = await renderSegments(page());
        const open = await renderSegments(page(), {
          interceptSegments: modalSegments([Promise.resolve({ a: 1 })]),
        });
        expect(chainTo(open, "L0R0")).toEqual(chainTo(closed, "L0R0"));
      });

      it("hands a slot with loading() one memoized aggregate while it is pending", async () => {
        const pending = new Promise(() => {});
        const loaders = modalSegments([pending], "loading");
        const first = layoutOf(
          await renderSegments(page(), { interceptSegments: loaders }),
        );
        const second = layoutOf(
          await renderSegments(page(), {
            interceptSegments: loaders.map((s) => ({ ...s })),
          }),
        );
        const slot = first.props.parallel[0];
        expect(slot.loaderDataPromise).toBeInstanceOf(Promise);
        expect(second.props.parallel[0].loaderDataPromise).toBe(
          slot.loaderDataPromise,
        );
        // A new slot object: the one in the entry is never written.
        expect(loaders[0]).not.toHaveProperty("loaderIds");
      });

      it("does not settle a slot whose loaders hold a deferred one", async () => {
        const hole = new Defer<unknown>();
        const segments = modalSegments([{ a: 1 }, hole]);
        segments[2] = { ...segments[2]!, deferred: true };
        const layout = layoutOf(
          await renderSegments(page(), {
            interceptSegments: segments,
            forceAwait: true,
          }),
        );
        expect(layout.props.parallel[0].loaderDataPromise).toBeInstanceOf(
          Promise,
        );
      });

      it("folds a slot restored unsplit from the history cache (back/forward)", async () => {
        const result = await renderSegments(
          [...page(), ...modalSegments([{ a: 1 }])],
          { forceAwait: true },
        );
        const layout = layoutOf(result);
        expect(layout.props.loaderStreams).toBeUndefined();
        expect(layout.props.parallel[0].loaderIds).toEqual(["loader0"]);
        expect(layout.props.parallel[0].loaderDataPromise).toEqual([{ a: 1 }]);
      });

      it("hands back a list with nothing to fold as it is, synchronously", () => {
        const plain = [
          ...page(),
          seg({ id: "L0D0.x", type: "loader", loaderId: "x" }),
        ];
        expect(foldInterceptLoaders(plain, true)).toBe(plain);
      });

      it("attaches an intercept slot loader whose slot name contains an uppercase 'D'", async () => {
        // Regression: parent extraction used segment.id.split("D")[0], which cut
        // the loader id at the first bare 'D'. For an intercept slot loader
        // `${parent}.${slotName}D${i}.${loaderId}`, a slot name containing an
        // uppercase 'D' (e.g. @Detail) cut inside the slot name, so the loader
        // matched no parent and its data was silently dropped.
        const interceptSegments: ResolvedSegment[] = [
          seg({ id: "L0.@Detail", type: "parallel", slot: "@Detail" }),
          seg({
            id: "L0.@DetailD0.detail-data",
            type: "loader",
            loaderId: "detail-loader",
            loaderData: { detail: true },
          }),
        ];

        const result = await renderSegments(page(), { interceptSegments });
        const [slot] = layoutOf(result).props.parallel;
        expect(slot.loaderIds).toEqual(["detail-loader"]);
        expect(slot.loaderDataPromise).toEqual([{ detail: true }]);
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
          expect(findVTIn(layoutOutlet.props.content)?.props.default).toEqual(
            withOptimisticCommitNone("fade"),
          );
          expect(findVTIn(layoutOutlet.props.children)).toBeNull();
        } finally {
          vi.doUnmock("react");
          vi.resetModules();
        }
      });

      it("a transition({ when }) gated-off commit keeps the same ViewTransition element with every class none (#995)", async () => {
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
          const when = () => false;
          const route = seg({
            id: "L0R0",
            type: "route",
            transition: { default: "fade", name: "hero", when } as any,
          });

          const held = findFirst(
            toTreeNode(await renderSegmentsFresh([route])),
            MockViewTransition,
          );
          const gated = findFirst(
            toTreeNode(
              await renderSegmentsFresh([route], { transitionGatedOff: true }),
            ),
            MockViewTransition,
          );

          // Same element type either way: the decision never remounts.
          expect(held?.type).toBe(MockViewTransition);
          expect(gated?.type).toBe(MockViewTransition);
          expect(held?.props.when).toBeUndefined();
          expect(gated?.props.name).toBe("hero");
          // Every class resolves to "none" for every transition type.
          for (const phase of ["enter", "exit", "update", "share", "default"]) {
            const value = gated?.props[phase];
            const classes =
              typeof value === "string" ? [value] : Object.values(value);
            expect(new Set(classes), phase).toEqual(new Set(["none"]));
          }
          expect(gated?.props.when).toBeUndefined();
          expect(gated?.props.viewTransition).toBeUndefined();
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
          expect(
            findVTIn(normalInnerOutlet.props.content)?.props.default,
          ).toEqual(withOptimisticCommitNone("outer-fade"));

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
          ).toEqual(withOptimisticCommitNone("outer-fade"));
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
          ).toEqual(withOptimisticCommitNone("outer-fade"));
          expect(
            findVTIn(afterAction.inner.props.content)?.props.default,
          ).toEqual(withOptimisticCommitNone("outer-fade"));

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
          expect(findVTIn(routeOutlet.props.children)?.props.default).toEqual(
            withOptimisticCommitNone("fade"),
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
      it("folds a slot-prefixed loader onto its slot, not the parent's loader list", async () => {
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

        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        expect(layoutOutlet.props.loaderStreams).toBeUndefined();
        expect(layoutOutlet.props.parallel[0].loaderIds).toEqual([
          "sidebar-loader",
        ]);
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

      it("does not attach loaderStreams to a parallel slot — mixed flagged/unflagged stays on the aggregate promise", async () => {
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

        // Streams would skip use(aggregate) and bake the slot handler
        // (PPR3 live-lane hole). The pending sibling keeps the aggregate
        // a Promise so LoaderBoundary still suspends.
        expect(parallel.loaderStreams).toBeUndefined();
        expect(parallel.awaitedLoaderIds).toBeUndefined();
        expect(parallel.loaderDataPromise).toBeInstanceOf(Promise);
      });

      it("settles an all-flagged parallel slot into a decoded aggregate (no streams)", async () => {
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
          seg({ id: "L0R0", type: "route" }),
        ];

        const result = await renderSegments(segments);
        const tree = toTreeNode(result);
        const outlets = collectByType(tree, MockOutletProvider);
        const layoutOutlet = outlets.find((o) => o.props.segment.id === "L0")!;
        const parallel = layoutOutlet.props.parallel[0] as ResolvedSegment;

        expect(parallel.loaderStreams).toBeUndefined();
        expect(Array.isArray(parallel.loaderDataPromise)).toBe(true);
        expect(parallel.loaderDataPromise).toEqual([
          { ok: true, data: "settled" },
        ]);
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

        // The first aggregate is a promise; once settled, later renders get
        // its array.
        expect(firstPromise).toBeInstanceOf(Promise);
        expect(secondPromise).toBe(await firstPromise);
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
        expect(secondBoundary.props.loaderDataPromise).toBe(await firstPromise);
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
        // The browser hands the node itself, not a promise React has not read.
        expect(firstContent).toBe(component);

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

    // prefetch: false (docs/design/prefetch-false.md). A deferred segment's
    // value is a hole: a defer the browser resolves when the fill request
    // lands (browser/partial-update.ts armHoles). The tree build must never
    // wait for one: the fill is only merged once the build has returned.
    describe("deferred segments (prefetch: false)", () => {
      const hole = () => new Defer<never>();
      const fallback = createElement("div", null, "Loading...");

      /** Fails instead of hanging when the build waits on a hole. */
      function built(tree: Promise<ReactNode>): Promise<ReactNode> {
        return Promise.race([
          tree,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("renderSegments waited on a hole")),
              200,
            ),
          ),
        ]);
      }

      it.each([{ forceAwait: true }, { isAction: true }])(
        "settles the other loaders and leaves the hole to the read site under loading() (%o)",
        async (options) => {
          const reviews = hole();
          const segments: ResolvedSegment[] = [
            seg({ id: "R0", type: "route", loading: fallback }),
            seg({
              id: "R0D0.price",
              type: "loader",
              loaderId: "price",
              loaderData: Promise.resolve({ price: 12 }),
            }),
            seg({
              id: "R0D1.reviews",
              type: "loader",
              loaderId: "reviews",
              loaderData: reviews,
              deferred: true,
            }),
          ];

          const tree = toTreeNode(
            await built(renderSegments(segments, options)),
          );
          const boundary = collectByType(tree, MockLoaderBoundary)[0];
          expect(boundary.props.loaderStreams).toEqual({
            price: { price: 12 },
            reviews,
          });
          expect(boundary.props.loaderStreams.reviews).toBe(reviews);
          expect(boundary.props.loaderIds).toEqual(["price", "reviews"]);
          expect(
            collectByType(tree, MockStreamedLoaderErrorBoundary),
          ).toHaveLength(1);
        },
      );

      it("settles the other loaders and leaves the hole to the read site without loading()", async () => {
        const reviews = hole();
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.price",
            type: "loader",
            loaderId: "price",
            loaderData: Promise.resolve({ price: 12 }),
          }),
          seg({
            id: "R0D1.reviews",
            type: "loader",
            loaderId: "reviews",
            loaderData: reviews,
            deferred: true,
          }),
        ];

        const tree = toTreeNode(
          await built(renderSegments(segments, { forceAwait: true })),
        );
        const outlet = collectByType(tree, MockOutletProvider)[0];
        expect(outlet.props.loaderData).toBeUndefined();
        expect(outlet.props.loaderStreams).toEqual({
          price: { price: 12 },
          reviews,
        });
      });

      it("leaves a settled sibling's unhandled error to the read site", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "R0", type: "route" }),
          seg({
            id: "R0D0.price",
            type: "loader",
            loaderId: "price",
            loaderData: Promise.resolve({
              __loaderResult: true,
              ok: false,
              error: { message: "boom", name: "Error" },
              fallback: null,
            }),
          }),
          seg({
            id: "R0D1.reviews",
            type: "loader",
            loaderId: "reviews",
            loaderData: hole(),
            deferred: true,
          }),
        ];

        // The aggregate lane this replaces throws while the tree is built.
        const tree = toTreeNode(
          await built(renderSegments(segments, { forceAwait: true })),
        );
        const outlet = collectByType(tree, MockOutletProvider)[0];
        expect(() =>
          decodeLoaderEntry(outlet.props.loaderStreams.price),
        ).toThrow("boom");

        // As the plain click's streaming lane does with the same error: the
        // tree is built and the read site throws it.
        const plain = toTreeNode(
          await built(renderSegments(segments.slice(0, 2))),
        );
        const price = await collectByType(plain, MockOutletProvider)[0].props
          .loaderStreams.price;
        expect(() => decodeLoaderEntry(price)).toThrow("boom");

        // The aggregate lane: with no deferred loader in the set.
        await expect(
          renderSegments(segments.slice(0, 2), { forceAwait: true }),
        ).rejects.toThrow("boom");
      });

      it.each([{ forceAwait: true }, { isAction: true }, {}])(
        "passes a deferred unit's hole to its fallback boundary unawaited (%o)",
        async (options) => {
          const content = hole();
          const segments: ResolvedSegment[] = [
            seg({
              id: "R0",
              type: "route",
              component: content as unknown as ReactNode,
              loading: fallback,
              deferred: true,
            }),
          ];

          const tree = toTreeNode(
            await built(renderSegments(segments, options)),
          );
          const wrapper = collectByType(tree, MockRouteContentWrapper)[0];
          expect(wrapper.props.content).toBe(content);
          expect(wrapper.props.fallback).toBe(fallback);
        },
      );

      it("does not wait on a deferred unit that has no fallback to show", async () => {
        const segments: ResolvedSegment[] = [
          seg({
            id: "R0",
            type: "route",
            component: hole() as unknown as ReactNode,
            deferred: true,
          }),
        ];

        await built(renderSegments(segments, { forceAwait: true }));
      });

      // No Suspender of the router's reads a hole with no loading(): React
      // reads the node itself, so the filled page's node later takes the
      // same place (browser/defer.ts asStream). A placeholder's hole is
      // pending; the place a failed fill hands its defer again (fillHoles)
      // holds it fulfilled.
      const contentOf = async (segment: ResolvedSegment) => {
        const tree = toTreeNode(await built(renderSegments([segment])));
        // Wrapped: an async function would adopt a promise it returns.
        return [collectByType(tree, MockOutletProvider)[0].props.children];
      };

      it("hands React a placeholder's hole with no loading() as its promise", async () => {
        const hole = new Defer<ReactNode>();
        const [content] = await contentOf(
          seg({
            id: "R0",
            type: "route",
            component: hole as unknown as ReactNode,
            deferred: true,
          }),
        );
        expect(content).toBe(hole.promise);
      });

      it("hands React a fulfilled hole with no loading() as its value", async () => {
        const node = createElement("p", null, "page");
        const hole = new Defer<ReactNode>();
        hole.resolve(node);
        const [content] = await contentOf(
          seg({
            id: "R0",
            type: "error",
            component: hole as unknown as ReactNode,
          }),
        );
        expect(content).toBe(node);
      });

      it("does not settle a slot's aggregate that holds a hole", async () => {
        const segments: ResolvedSegment[] = [
          seg({ id: "L0", type: "layout" }),
          seg({
            id: "L0.@side",
            type: "parallel",
            slot: "@side",
            namespace: "side",
            loading: fallback,
          }),
          seg({
            id: "L0D0.side",
            type: "loader",
            namespace: "side",
            loaderId: "side",
            loaderData: hole(),
            deferred: true,
          }),
          seg({ id: "L0R0", type: "route" }),
        ];

        const tree = toTreeNode(
          await built(renderSegments(segments, { forceAwait: true })),
        );
        const layout = collectByType(tree, MockOutletProvider).find(
          (o) => o.props.segment.id === "L0",
        )!;
        expect(layout.props.parallel[0].loaderDataPromise).toBeInstanceOf(
          Promise,
        );
      });

      // The click builds the page's tree once, from the prefetched segments
      // and one placeholder per segment whose work did not run, and the
      // fill only resolves what that tree reads (browser/partial-update.ts
      // fillHoles). So the tree has to be the one a plain click's payload
      // builds: the same router elements, with the same keys, around every
      // segment. What differs is what the boundaries are handed.
      it("builds a plain click's wrapper chain from the skeleton: the same elements and keys around every segment", async () => {
        // A flagged layout with a loader, a slot with no loading() and one
        // with its own and a loader, a route with loading(), transition()
        // and a loader, and an orphan layout of the route.
        const page = (filled: boolean): ResolvedSegment[] => {
          const value = <T,>(known: T): T =>
            filled ? known : (hole() as unknown as T);
          const flag = filled ? {} : { deferred: true as const };
          const loader = (id: string, loaderId: string, namespace: string) =>
            seg({
              id,
              type: "loader",
              namespace,
              loaderId,
              component: null,
              loaderData: value(Promise.resolve({ ok: true, data: loaderId })),
              ...flag,
            });
          const node = (id: string) =>
            value(createElement("div", null, id) as ReactNode);
          return [
            seg({ id: "L0", type: "layout" }),
            loader("L0L1D0.section", "section", "section"),
            seg({
              id: "L0L1",
              type: "layout",
              namespace: "section",
              loading: fallback,
              component: node("L0L1"),
              ...flag,
            }),
            seg({
              id: "L0L1.@side",
              type: "parallel",
              slot: "@side",
              namespace: "side",
              component: node("side"),
              ...flag,
            }),
            seg({
              id: "L0L1.@panel",
              type: "parallel",
              slot: "@panel",
              namespace: "panel",
              loading: fallback,
              component: node("panel"),
              ...flag,
            }),
            loader("L0L1D0.panel", "panel", "panel"),
            loader("L0L1R0D0.page", "page", "page"),
            seg({
              id: "L0L1R0L0",
              type: "layout",
              namespace: "orphan",
              belongsToRoute: true,
              component: node("orphan"),
              ...flag,
            }),
            seg({
              id: "L0L1R0",
              type: "route",
              namespace: "page",
              loading: fallback,
              transition: {},
              params: { id: "1" },
              component: node("page"),
              ...flag,
            }),
          ];
        };

        // Every element the router places, in tree order: its type, its key,
        // the segment it is for and the slots it carries. A segment's own
        // content (host elements here) is not part of the chain, and a
        // boundary's content is what the fill resolves.
        const chain = (node: TreeNode | null): unknown[] => {
          if (!node) return [];
          const below =
            node.typeName === "MockRouteContentWrapper"
              ? []
              : node.children.flatMap(chain);
          if (typeof node.type === "string") return below;
          return [
            [
              node.typeName,
              node.key,
              node.props.segment?.id ?? node.props.segmentId ?? null,
              (node.props.parallel ?? []).map((p: ResolvedSegment) => [
                p.id,
                p.loaderIds ?? null,
              ]),
            ],
            ...below,
          ];
        };

        // The click commits on the forceAwait lane (its payload was
        // prefetched), a plain click on the streams lane.
        const click = chain(
          toTreeNode(
            await built(renderSegments(page(false), { forceAwait: true })),
          ),
        );
        const plain = chain(toTreeNode(await renderSegments(page(true))));
        expect(click).toEqual(plain);
        // The fixture reaches every wrapper the chain is made of.
        const types = new Set(click.map((entry) => (entry as unknown[])[0]));
        for (const wrapper of [
          "MockRootErrorBoundary",
          "MockOutletProvider",
          "MockLoaderBoundary",
          "MockRouteContentWrapper",
          "MockStreamedLoaderErrorBoundary",
        ]) {
          expect(types, wrapper).toContain(wrapper);
        }
      });
    });
  });
});
