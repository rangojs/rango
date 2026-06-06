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
 *     reference). Use renderServerTree / e2e for those.
 *   - It will NOT catch real Flight serialization errors (non-serializable
 *     props crossing the RSC boundary), loader execution on the server,
 *     middleware, or handler ordering. Those are renderServerTree / renderHandler
 *     / e2e territory.
 *   - Loader data, location state, and handle output are SEEDED directly into
 *     client context (see the `loaders` / `locationState` / `handles` options) —
 *     nothing is executed on the server. This exercises the read path
 *     (useLoader / useLocationState / useHandle from context), not the run path.
 * What it DOES cover: client hooks that read NavigationProvider /
 * OutletContext — useParams, useReverse, useHref, useMount, useNavigation,
 * useRouter, usePathname, useSearchParams, Outlet nesting, useLoader /
 * useFetchLoader (seeded data), useLocationState (seeded), and useHandle (seeded).
 * Basename-mounted apps: pass the `basename` option so useRouter().basename,
 * <Link> prefixing, and useMount/useHref resolve against the mount prefix
 * (without it they resolve at the root "/"). For an include("/shop", ...)
 * subtree, pass the `mount` option so useMount() returns the mounted prefix
 * (the segment chain is wrapped in a MountContext exactly as in production).
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
import { normalizeBasename } from "../router/basename.js";
import type { LoaderDefinition } from "../types.js";
import type { LocationStateDefinition } from "../browser/react/location-state-shared.js";
import type { Handle } from "../handle.js";
import type { ThemeConfig } from "../theme/types.js";
import { resolveThemeConfig } from "../theme/constants.js";

const TEST_ORIGIN = "http://localhost";

/**
 * Seed shape for `options.handle`, matching the handle wire format:
 * `{ [handleName]: { [segmentId]: pushedValues[] } }` (each segment accumulates
 * an array of values pushed for that handle).
 */
export type HandleDataSeed = Record<string, Record<string, unknown[]>>;

// Loaders and location-state defs carry an id (`$$id` / `__rsc_ls_key`) that the
// Vite plugin injects at build time; in a bare test it is "". These helpers
// assign a synthetic stable id (mutating the handle, tracked per-object) so that
// seeding by reference lines up with the read path (useLoader / useLocationState
// both read the id off the handle at call time).
const syntheticIds = new WeakMap<object, string>();
let syntheticIdCounter = 0;

function ensureSyntheticId(
  handle: object,
  field: "$$id" | "__rsc_ls_key",
): string {
  const existing = (handle as Record<string, string>)[field];
  if (existing) return existing;
  let id = syntheticIds.get(handle);
  if (!id) {
    id = `__rango_test_id_${syntheticIdCounter++}`;
    syntheticIds.set(handle, id);
  }
  (handle as Record<string, string>)[field] = id;
  return id;
}

/** One-level clone of a raw handle seed so we don't mutate the caller's object. */
function cloneHandleSeed(seed?: HandleDataSeed): HandleDataSeed {
  const out: HandleDataSeed = {};
  for (const [name, segMap] of Object.entries(seed ?? {})) {
    out[name] = { ...segMap };
  }
  return out;
}

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
   * wrapping it. Only the leaf pattern is matched against the `request` URL to
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
  /**
   * The initial location to render at: a `Request`, or a URL string (absolute or
   * path). Only the URL is read (this is a client render — headers/method are
   * ignored); named `request` for parity with the other primitives. Defaults to
   * the leaf spec's static prefix or "/".
   */
  request?: Request | string;
  /**
   * Loader data to seed into client context, keyed by loader id ($$id). A
   * component calling useLoader(SomeLoader) reads `loaderData[SomeLoader.$$id]`.
   * Seeded values are placed in the route segment's OutletProvider context, so
   * the read path is exercised without executing any loader.
   */
  loaderData?: Record<string, unknown>;
  /**
   * Loaders to seed by REFERENCE — the robust way to test a component that calls
   * `useLoader(loader)`. A real `createLoader()` handle has an empty `$$id` in a
   * bare test (the id is injected by the Vite plugin at build time), so keying
   * `loaderData` by `$$id` collides under `""` and `useLoader` resolves nothing.
   * Passing `[loader, data]` pairs lets renderRoute assign a synthetic stable id
   * and wire `useLoader` to it. Prefer this over `loaderData` for real handles.
   *
   * @example
   * renderRoute([{ path: "/cart", Component: CartBadge }], {
   *   loaders: [[CartLoader, { itemCount: 3, total: 89.97 }]],
   * });
   */
  loaders?: ReadonlyArray<readonly [LoaderDefinition<any>, unknown]>;
  /**
   * Explicit params. Merged over (and overriding) params extracted from the
   * `request` URL. Use this when the URL alone cannot express the params, or to
   * avoid relying on URL parsing.
   */
  params?: Record<string, string>;
  /**
   * Location-state values to seed by REFERENCE, for components that call
   * `useLocationState(StateDef)`. Like loaders, a real `createLocationState()`
   * handle has an empty injected key in a bare test, so pass `[def, value]`
   * pairs; renderRoute assigns a synthetic key and writes it to `history.state`.
   *
   * @example
   * renderRoute([{ path: "/", Component: FlashBanner }], {
   *   locationState: [[FlashMessage, { text: "Saved" }]],
   * });
   */
  locationState?: ReadonlyArray<
    readonly [LocationStateDefinition<any, any>, unknown]
  >;
  /**
   * Handles to seed by REFERENCE, for components that read handle output via
   * `useHandle(SomeHandle)` (e.g. a client `Breadcrumbs` trail). Each entry is
   * `[handle, pushedValues[]]` — the values a route's handlers would have pushed;
   * renderRoute attaches them to the leaf route segment under the handle's id.
   * Built-in handles (Breadcrumbs/Meta) have stable ids and work directly.
   *
   * Handle data is accumulated GLOBALLY on the event controller, not scoped per
   * segment like loaders — so ANY component in the chain reads the seeded values,
   * a LAYOUT (e.g. a DetailLayout/ActionToolbar reading a handle) just as much as
   * the leaf route. Most handle usage is server-side (`ctx.use(...)`) and is
   * better covered by `renderToFlightString`/e2e; this seeds the client read path
   * only.
   *
   * @example
   * renderRoute([{ path: "/p", Component: BreadcrumbTrail }], {
   *   handles: [[Breadcrumbs, [{ label: "Home", href: "/" }, { label: "P", href: "/p" }]]],
   * });
   */
  handles?: ReadonlyArray<readonly [Handle<any, any>, unknown[]]>;
  /**
   * Advanced: raw handle data in wire format
   * `{ [handleId]: { [segmentId]: pushedValues[] } }`. Prefer `handles` (which
   * computes the segment id for you). Merged with `handles`.
   */
  handle?: HandleDataSeed;
  /**
   * Route name -> pattern map. Informational for parity with the server test
   * context; client useReverse takes its map directly as an argument, so this
   * is not consumed by the client hooks.
   */
  routeMap?: Record<string, string>;
  /**
   * Router basename (the `createRouter({ basename })` value). Wired into
   * NavigationProvider so `useRouter().basename`, `<Link>` href prefixing, and
   * `useMount`/`useHref` resolve against the mounted prefix instead of the root.
   * Normalized exactly like createRouter (leading slash forced, trailing
   * stripped, bare "/" -> undefined). Defaults to undefined (root mount).
   */
  basename?: string;
  /**
   * include() mount prefix, to model an `include("/shop", ...)` subtree so a
   * component (route OR layout in the chain) calling `useMount()` returns the
   * mounted prefix instead of "/". Wraps the segment chain in a MountContext
   * exactly as `renderSegments` does in production (a segment whose `mountPath`
   * is set is wrapped in a MountContextProvider). Normalized like a path prefix
   * (leading slash forced, trailing stripped, bare "/" -> root). Defaults to "/".
   *
   * @example
   * renderRoute([{ path: "/c/wine", Component: ProductPage }], { mount: "/shop" });
   * // useMount() inside ProductPage returns "/shop"
   */
  mount?: string;
  /**
   * Theme config in the `createRouter({ theme })` shape (resolved internally) to
   * wrap the tree in a ThemeProvider. Defaults to no provider. Note: a component
   * that calls `useTheme()` REQUIRES a provider — it throws "used outside
   * ThemeProvider" without one — so pass a config (e.g. `true`) to test such a
   * component.
   */
  theme?: ThemeConfig | true;
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
  mount?: string,
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
    // Model an include() mount: every component segment in the chain shares the
    // same prefix, so renderSegments wraps each in a MountContextProvider and
    // useMount() resolves the mounted prefix (production sets mountPath on every
    // segment of an included subtree). Must be applied identically at both
    // buildSegments call sites or segment-structure-assert flags a remount.
    if (mount) node.mountPath = mount;
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
 *   { request: "/products/1" },
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
  const requestUrl =
    options.request instanceof Request ? options.request.url : options.request;
  const initialUrl = requestUrl ?? staticPrefix(leaf.path) ?? "/";
  const url = new URL(initialUrl, TEST_ORIGIN);

  // Seed loader data: explicit-id entries from `loaderData`, plus by-reference
  // entries from `loaders` (assigning synthetic ids to real handles whose `$$id`
  // is empty in a bare test).
  const loaderData: Record<string, unknown> = { ...(options.loaderData ?? {}) };
  for (const [loader, data] of options.loaders ?? []) {
    loaderData[ensureSyntheticId(loader as object, "$$id")] = data;
  }

  // Seed location state into history.state so useLocationState(def) resolves.
  // Keyed defs read history.state[def.__rsc_ls_key]; assign a synthetic key when
  // the injected one is empty (bare test). RESET history.state to only this
  // call's seeds (not a merge) so a previous render's seeded state does not leak
  // into a later render in the same DOM environment.
  if (typeof window !== "undefined") {
    const stateObj: Record<string, unknown> = {};
    for (const [def, value] of options.locationState ?? []) {
      stateObj[ensureSyntheticId(def as object, "__rsc_ls_key")] = value;
    }
    // No URL arg: useLocationState reads history.state (not the URL), and passing
    // a TEST_ORIGIN URL would trip the DOM env's same-origin check.
    window.history.replaceState(stateObj, "");
  }

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
  // Normalize the include() mount prefix once and apply it at BOTH buildSegments
  // call sites (initial + navigate) so mountPath is consistent across renders.
  const mount = normalizeBasename(options.mount);
  const initialSegments = buildSegments(
    routes,
    initialMatch.params,
    loaderData,
    mount,
  );
  const store = createNavigationStore({
    initialLocation: { href: url.href },
    initialSegmentIds: initialSegments.map((s) => s.id),
    initialHistoryKey: historyKey,
    initialSegments,
    crossTabSync: false,
  });
  // Seed handle data: raw `handle` entries plus by-reference `handles` attached
  // to the leaf route segment under each handle's id (so useHandle(handle)
  // resolves the pushed values).
  const leafRouteSegmentId =
    [...initialSegments].reverse().find((s) => s.type === "route")?.id ??
    initialSegments[initialSegments.length - 1]?.id;
  const handleSeed: HandleDataSeed = cloneHandleSeed(options.handle);
  for (const [handle, values] of options.handles ?? []) {
    if (leafRouteSegmentId === undefined) continue;
    // createHandle always has a non-empty $$id (the Vite plugin injects one, and
    // createHandle assigns a runtime fallback otherwise) with its REAL collect
    // registered — so seeding under handle.$$id makes useHandle(handle) run the
    // handle's actual collect/accumulator (custom collects included), not just a
    // default flatten.
    const id = (handle as unknown as { $$id: string }).$$id;
    (handleSeed[id] ??= {})[leafRouteSegmentId] = values;
  }

  const eventController = createEventController({ initialLocation: url });
  eventController.setParams(initialMatch.params);
  eventController.setHandleData(
    handleSeed,
    initialSegments.map((s) => s.id),
  );

  // Client-only navigation: re-resolve against the in-memory routes and emit a
  // re-render. No server fetch — only routes passed to renderRoute exist. The
  // store update is flushed inside act() so React commits before callers
  // assert, mirroring how a real navigation lands a single payload swap.
  const navigate = async (target: string): Promise<void> => {
    const nextUrl = new URL(target, TEST_ORIGIN);
    const match = resolve(nextUrl.pathname);
    const segments = buildSegments(routes, match.params, loaderData, mount);
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
      basename={normalizeBasename(options.basename)}
      themeConfig={
        options.theme === undefined ? null : resolveThemeConfig(options.theme)
      }
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
