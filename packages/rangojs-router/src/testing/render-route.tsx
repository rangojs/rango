/**
 * renderRoute — a React-Testing-Library-style helper for unit-testing CLIENT
 * components that read @rangojs/router client context (useParams, useReverse,
 * Outlet, useNavigation, useLoader).
 *
 * Peer of React Router's createRoutesStub and Expo Router's renderRouter. It
 * mounts the router's NavigationProvider plus a synthetic segment tree so that
 * a component under test sees real router context, without spinning up a
 * server, a Vite build, or a real Flight round-trip.
 *
 * FIDELITY CONTRACT — read before relying on this helper:
 * This renders the CLIENT tree ONLY. The segment tree is built synthetically
 * from the `routes` you pass; there is no server render and no Flight
 * (de)serialization. Consequences:
 *   - It will NOT catch server/client boundary reference-identity remount bugs
 *     (a server-serialized component reference differing from the client
 *     reference). Use renderServer / e2e for those.
 *   - It will NOT catch real Flight serialization errors (non-serializable
 *     props crossing the RSC boundary), loader execution on the server,
 *     middleware, or handler ordering. Those are renderServer / e2e territory.
 *   - Loader data is SEEDED directly into client context (see `loaderData`
 *     option) — loaders are never executed. This exercises the read path
 *     (useLoader / useFetchLoader from context), not the run path.
 * What it DOES cover: client hooks that read NavigationProvider /
 * OutletContext — useParams, useReverse, useHref, useMount, useNavigation,
 * useRouter, usePathname, useSearchParams, Outlet nesting, and useLoader /
 * useFetchLoader reading seeded context data.
 */

import type { ReactNode, ComponentType } from "react";
import type { RenderResult } from "@testing-library/react";
import { renderSegments } from "../segment-system.js";
import {
  createNavigationStore,
  generateHistoryKey,
} from "../browser/navigation-store.js";
import { createEventController } from "../browser/event-controller.js";
import type { NavigationStore, NavigationBridge } from "../browser/types.js";
import type { EventController } from "../browser/event-controller.js";
import type { ResolvedSegment, RscMetadata } from "../browser/types.js";
import { NavigationProvider } from "../browser/react/NavigationProvider.js";
import { compilePattern } from "../router/pattern-matching.js";

const TEST_ORIGIN = "http://localhost";

/**
 * One node of the route definition passed to renderRoute. The array models a
 * single matched route plus its optional layout chain — element order is
 * outermost layout first, the leaf route last (the same root-to-leaf order the
 * real matcher produces).
 */
export interface RenderRouteSpec {
  /**
   * The route pattern this node matches, e.g. "/products/:productId". The LAST
   * spec in the array is treated as the leaf route; earlier specs are layouts
   * wrapping it. Only the leaf pattern is matched against `initialUrl` to
   * extract params; layout patterns are informational.
   */
  path: string;
  /** The component rendered for this node (the leaf route or a layout body). */
  Component: ComponentType;
  /**
   * Optional layout component. When set on the LEAF spec it wraps the route in
   * its own layout segment (useful for a route that owns a layout). Prefer
   * expressing layouts as their own array entries instead.
   */
  layout?: ComponentType;
  /**
   * Loader ids ($$id) whose seeded data (from `options.loaderData`) should be
   * attached to THIS node's segment so useLoader/useFetchLoader resolve it from
   * context. When omitted, every key in `options.loaderData` is attached to the
   * leaf route segment.
   */
  loaderIds?: string[];
  /** Optional route name (informational; not used for matching). */
  name?: string;
}

/**
 * Options for renderRoute.
 */
export interface RenderRouteOptions {
  /** Initial URL to render at. Defaults to the leaf spec's static prefix or "/". */
  initialUrl?: string;
  /**
   * Loader data to seed into client context, keyed by loader id ($$id). A
   * component calling useLoader(SomeLoader) reads `loaderData[SomeLoader.$$id]`.
   * Seeded values are placed in the route segment's OutletProvider context, so
   * the read path is exercised without executing any loader.
   */
  loaderData?: Record<string, unknown>;
  /**
   * Explicit params. Merged over (and overriding) params extracted from
   * `initialUrl`. Use this when the URL alone cannot express the params, or to
   * avoid relying on URL parsing.
   */
  params?: Record<string, string>;
  /** Reserved for future handle-data seeding. Currently informational. */
  handle?: unknown;
  /**
   * Route name -> pattern map. Informational for parity with the server test
   * context; client useReverse takes its map directly as an argument, so this
   * is not consumed by the client hooks.
   */
  routeMap?: Record<string, string>;
}

/**
 * Imperative handle returned alongside the RTL result.
 */
export interface TestRouterHandle {
  /**
   * Navigate to a new URL. Re-resolves the URL against the supplied `routes`,
   * updates params + location, and re-renders the segment tree. This is a
   * client-only navigation: no server fetch occurs, so only the components in
   * `routes` can be reached.
   */
  navigate(url: string): Promise<void>;
  /** The current committed pathname. */
  pathname(): string;
  /** The current committed params. */
  params(): Record<string, string>;
  /** The underlying navigation store (advanced use). */
  store: NavigationStore;
  /** The underlying event controller (advanced use). */
  eventController: EventController;
}

/** Result of renderRoute: RTL's render result plus the router handle. */
export type RenderRouteResult = RenderResult & { router: TestRouterHandle };

interface ResolvedMatch {
  params: Record<string, string>;
  pathname: string;
}

/**
 * Match a pathname against the leaf spec's pattern and extract params.
 * Returns null when the pattern does not match (params then fall back to the
 * caller-provided `options.params`).
 */
function matchLeaf(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const compiled = compilePattern(pattern);
  const match = compiled.regex.exec(pathname);
  if (!match) return null;
  const params: Record<string, string> = {};
  compiled.paramNames.forEach((name, index) => {
    const value = match[index + 1];
    if (value !== undefined) {
      params[name] = decodeURIComponent(value);
    }
  });
  return params;
}

/** Derive a usable initial pathname from a leaf pattern when none is given. */
function staticPrefix(pattern: string): string {
  const out: string[] = [];
  for (const part of pattern.split("/")) {
    if (part === "") continue;
    if (part.startsWith(":") || part === "*") break;
    out.push(part);
  }
  return "/" + out.join("/");
}

/**
 * Build the synthetic ResolvedSegment[] for a matched route. Produces, in
 * root-to-leaf order: one layout segment per non-leaf spec, then the leaf route
 * segment, plus a loader segment for each seeded loader id attached to the
 * owning spec. Segment ids follow the real convention (L0, L0L1, ..., the leaf
 * route as L0...R{n}; loaders as {parentId}D{i}.{loaderId}).
 */
function buildSegments(
  routes: RenderRouteSpec[],
  params: Record<string, string>,
  loaderData: Record<string, unknown>,
): ResolvedSegment[] {
  const segments: ResolvedSegment[] = [];
  const leafIndex = routes.length - 1;
  let idPath = "";

  const seededIds = Object.keys(loaderData);
  const explicitlyOwned = new Set<string>();
  for (const spec of routes) {
    for (const id of spec.loaderIds ?? []) explicitlyOwned.add(id);
  }

  routes.forEach((spec, i) => {
    const isLeaf = i === leafIndex;
    const tag = isLeaf ? `R${i}` : `L${i}`;
    idPath = idPath + tag;
    const segmentId = idPath;

    const Component = spec.Component;
    const node: ResolvedSegment = {
      id: segmentId,
      namespace: "",
      type: isLeaf ? "route" : "layout",
      index: i,
      component: <Component />,
      params,
      belongsToRoute: true,
    };
    // A leaf-owned layout component wraps the route via its own layout element.
    if (isLeaf && spec.layout) {
      const Layout = spec.layout;
      node.layout = <Layout />;
    }
    segments.push(node);

    // Determine which seeded loader ids this spec owns.
    const ownedIds = spec.loaderIds
      ? spec.loaderIds.filter((id) => id in loaderData)
      : isLeaf
        ? seededIds.filter((id) => !explicitlyOwned.has(id))
        : [];

    ownedIds.forEach((loaderId, li) => {
      segments.push({
        id: `${segmentId}D${li}.${loaderId}`,
        namespace: "",
        type: "loader",
        index: li,
        component: null,
        loaderId,
        loaderData: loaderData[loaderId],
        params,
      });
    });
  });

  return segments;
}

/**
 * Render a CLIENT component (and its layout chain) inside the router's
 * NavigationProvider for unit testing. Exported from `@rangojs/router/testing/dom`
 * (its own entry, kept out of the main `@rangojs/router/testing` barrel so that
 * barrel never references React/@testing-library/react). Async so the heavy
 * @testing-library/react dependency is loaded only at call time.
 *
 * @example
 * ```tsx
 * // @vitest-environment happy-dom
 * import { renderRoute } from "@rangojs/router/testing/dom";
 *
 * function Product() {
 *   const { productId } = useParams<{ productId: string }>();
 *   const reverse = useReverse({ product: "/products/:productId" });
 *   return <a href={reverse("product", { productId: "2" })}>{productId}</a>;
 * }
 *
 * const { getByText, router } = await renderRoute(
 *   [{ path: "/products/:productId", Component: Product }],
 *   { initialUrl: "/products/1" },
 * );
 * ```
 */
export async function renderRoute(
  routes: RenderRouteSpec[],
  options: RenderRouteOptions = {},
): Promise<RenderRouteResult> {
  if (routes.length === 0) {
    throw new Error("renderRoute: `routes` must contain at least one entry");
  }

  const { render, act } = await import("@testing-library/react");

  const leaf = routes[routes.length - 1];
  const initialUrl = options.initialUrl ?? staticPrefix(leaf.path) ?? "/";
  const url = new URL(initialUrl, TEST_ORIGIN);

  const loaderData = options.loaderData ?? {};

  // Resolve params: URL-extracted params first, explicit params override.
  const resolve = (pathname: string): ResolvedMatch => {
    const matched = matchLeaf(leaf.path, pathname) ?? {};
    return {
      params: { ...matched, ...(options.params ?? {}) },
      pathname,
    };
  };
  const initialMatch = resolve(url.pathname);

  // Reuse the real browser primitives so context shape matches production.
  const historyKey = generateHistoryKey(url.href);
  const initialSegments = buildSegments(
    routes,
    initialMatch.params,
    loaderData,
  );
  const store = createNavigationStore({
    initialLocation: { href: url.href },
    initialSegmentIds: initialSegments.map((s) => s.id),
    initialHistoryKey: historyKey,
    initialSegments,
    crossTabSync: false,
  });
  const eventController = createEventController({ initialLocation: url });
  eventController.setParams(initialMatch.params);
  eventController.setHandleData(
    {},
    initialSegments.map((s) => s.id),
  );

  // Client-only navigation: re-resolve against the in-memory routes and emit a
  // re-render. No server fetch — only routes passed to renderRoute exist. The
  // store update is flushed inside act() so React commits before callers
  // assert, mirroring how a real navigation lands a single payload swap.
  const navigate = async (target: string): Promise<void> => {
    const nextUrl = new URL(target, TEST_ORIGIN);
    const match = resolve(nextUrl.pathname);
    const segments = buildSegments(routes, match.params, loaderData);
    const metadata = makeMetadata(nextUrl.pathname, segments, match.params);
    const root = await renderSegments(segments);
    eventController.setLocation(nextUrl);
    eventController.setParams(match.params);
    store.setCurrentUrl(nextUrl.href);
    store.setSegmentIds(segments.map((s) => s.id));
    await act(async () => {
      store.emitUpdate({ root, metadata });
    });
  };

  const bridge: NavigationBridge = {
    navigate: (target) => navigate(target),
    refresh: () => navigate(url.pathname + url.search),
    handlePopstate: async () => {},
    registerLinkInterception: () => () => {},
    getVersion: () => undefined,
    updateVersion: () => {},
    updateAppShell: () => {},
  };

  const initialMetadata = makeMetadata(
    url.pathname,
    initialSegments,
    initialMatch.params,
  );
  const initialTree = await renderSegments(initialSegments);

  const result = render(
    <NavigationProvider
      store={store}
      eventController={eventController}
      initialPayload={{ root: initialTree, metadata: initialMetadata }}
      bridge={bridge}
      themeConfig={null}
    />,
  );

  const router: TestRouterHandle = {
    navigate,
    pathname: () => new URL(eventController.getLocation().href).pathname,
    params: () => eventController.getParams(),
    store,
    eventController,
  };

  return Object.assign(result, { router });
}

/** Minimal RscMetadata for client-side re-renders (no server-only fields). */
function makeMetadata(
  pathname: string,
  segments: ResolvedSegment[],
  params: Record<string, string>,
): RscMetadata {
  return {
    pathname,
    segments,
    params,
    matched: segments.map((s) => s.id),
    isPartial: false,
  };
}
