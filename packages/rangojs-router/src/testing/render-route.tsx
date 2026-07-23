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
 *   - navigate() commits synchronously, so it does NOT drive the navigation
 *     lifecycle: useNavigation().state, useLinkStatus().pending, and
 *     useAction().state stay "idle". Assert pending/loading/submitting transition
 *     states with renderServerTree / e2e instead (navigate() warns once if used).
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

import { useEffect, type ReactNode, type ComponentType } from "react";
import type { RenderResult } from "@testing-library/react";
import { renderSegments } from "../segment-system.js";
import {
  createNavigationStore,
  generateHistoryKey,
} from "../browser/navigation-store.js";
import { createEventController } from "../browser/event-controller.js";
import { resolveDeferredHandleValues } from "../handles/deferred-resolution.js";
import type { NavigationStore, NavigationBridge } from "../browser/types.js";
import type { EventController } from "../browser/event-controller.js";
import type { ResolvedSegment, RscMetadata } from "../browser/types.js";
import { NavigationProvider } from "../browser/react/NavigationProvider.js";
import {
  compilePattern,
  buildParamsFromMatch,
} from "../router/pattern-matching.js";
import { normalizeBasename } from "../router/basename.js";
import type { LoaderDefinition } from "../types.js";
import type { LocationStateDefinition } from "../browser/react/location-state-shared.js";
import type { Handle } from "../handle.js";
import type { ThemeConfig } from "../theme/types.js";
import { resolveThemeConfig } from "../theme/constants.js";
import { isUnderTestRunner } from "../runtime-env.js";
import { setupNavigationBridgeDelegatedPrefetch } from "../browser/navigation-bridge.js";
import { resetAdaptiveStrategyForTesting } from "../browser/prefetch/default-strategy.js";
import { resetPrefetchObserverForTesting } from "../browser/prefetch/observer.js";
import type { PrefetchStrategy } from "../router/prefetch-default.js";

const TEST_ORIGIN = "http://localhost";
let activePrefetchRegistrations = 0;
let pendingPrefetchReset: object | undefined;

/**
 * Seed shape for `options.handle`, matching the handle wire format:
 * `{ [handleName]: { [segmentId]: pushedValues[] } }` (each segment accumulates
 * an array of values pushed for that handle).
 */
export type HandleDataSeed = Record<string, Record<string, unknown[]>>;

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

function cloneHandleSeed(seed?: HandleDataSeed): HandleDataSeed {
  const out: HandleDataSeed = {};
  for (const [name, segMap] of Object.entries(seed ?? {})) {
    out[name] = { ...segMap };
  }
  return out;
}

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
   * NOTE: when a real handle has no `$$id`, renderRoute MUTATES it to assign a
   * synthetic stable id (so repeat renders key consistently). This is a side
   * effect on your input object; a handle reused across tests keeps that id.
   *
   * @example
   * // useLoader returns an ENVELOPE — destructure `data`, it is not the bare value.
   * function CartBadge() {
   *   const { data } = useLoader(CartLoader); // NOT `useLoader(CartLoader).itemCount`
   *   return <span>{data.itemCount}</span>;
   * }
   * renderRoute([{ path: "/cart", Component: CartBadge }], {
   *   loaders: [[CartLoader, { itemCount: 3, total: 89.97 }]],
   * });
   */
  loaders?: ReadonlyArray<readonly [LoaderDefinition<any>, unknown]>;
  /**
   * Explicit params. Merged over (and overriding) params extracted from the
   * `request` URL. Use this when the URL alone cannot express the params, or to
   * avoid relying on URL parsing. Supplying params also OPTS OUT of the
   * request/leaf match check: a `request` whose pathname does not resolve the
   * leaf is normally rejected under the test runner, but passing params here
   * tells renderRoute the request is intentionally not the param source.
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
   * An explicitly-passed `request` must match the leaf `path` directly (paths are
   * include-RELATIVE; the mount does NOT rewrite the request) — pass the relative
   * path, not the mount-prefixed one, or renderRoute throws rather than silently
   * rendering empty params.
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
  /**
   * CSP nonce to seed via NonceContext, so a component calling `useNonce()`
   * (e.g. an analytics/GTM head-script component) sees this value — mirroring
   * what the SSR renderer provides per request. Defaults to undefined (the
   * browser default), matching production client behavior.
   *
   * @example
   * const { getByTestId } = await renderRoute(
   *   [{ path: "/", Component: NonceProbe }],
   *   { nonce: "test-nonce" },
   * );
   * expect(getByTestId("nonce").textContent).toBe("test-nonce");
   */
  nonce?: string;
  /**
   * Router default prefetch strategy scoped to this rendered tree. This mirrors
   * `createRouter({ defaultPrefetch })` for Links and eligible plain anchors
   * inside `basename`. `data-prefetch="false"`/`"none"` opts out; `"true"`
   * allows an application route with a common static-resource suffix but does
   * not override a `"none"` default.
   */
  defaultPrefetch?: PrefetchStrategy;
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

function DelegatedPrefetchRegistration({
  bridge,
}: {
  bridge: NavigationBridge;
}): null {
  useEffect(() => {
    const unregister = bridge.registerDelegatedPrefetch();
    pendingPrefetchReset = undefined;
    activePrefetchRegistrations++;
    return () => {
      try {
        unregister();
      } finally {
        activePrefetchRegistrations--;
        if (activePrefetchRegistrations === 0) {
          const reset = {};
          pendingPrefetchReset = reset;
          queueMicrotask(() => {
            if (
              pendingPrefetchReset !== reset ||
              activePrefetchRegistrations !== 0
            ) {
              return;
            }
            pendingPrefetchReset = undefined;
            resetPrefetchObserverForTesting();
            resetAdaptiveStrategyForTesting();
          });
        }
      }
    };
  }, [bridge]);
  return null;
}

function matchLeaf(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const compiled = compilePattern(pattern);
  const match = compiled.regex.exec(pathname);
  if (!match) return null;
  // Reuse the production param builder so the harness matches the real matcher
  // exactly (named catch-all "" binding, decoding) instead of forking it.
  return buildParamsFromMatch(match, compiled.paramNames, compiled.catchAll);
}

function staticPrefix(pattern: string): string {
  const out: string[] = [];
  for (const part of pattern.split("/")) {
    if (part === "") continue;
    if (part.startsWith(":") || part === "*") break;
    out.push(part);
  }
  return "/" + out.join("/");
}

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
    if (mount) node.mountPath = mount;
    if (isLeaf && spec.layout) {
      const Layout = spec.layout;
      node.layout = <Layout />;
    }
    segments.push(node);

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

export async function renderRoute(
  routes: RenderRouteSpec[],
  options: RenderRouteOptions = {},
): Promise<RenderRouteResult> {
  if (routes.length === 0) {
    throw new Error("renderRoute: `routes` must contain at least one entry");
  }
  if ("initialUrl" in options) {
    throw new Error(
      "renderRoute: the `initialUrl` option was renamed to `request`. " +
        "Pass { request: <Request | url> } instead.",
    );
  }

  const { render, act } = await import("@testing-library/react");

  const leaf = routes[routes.length - 1];
  const requestUrl =
    options.request instanceof Request ? options.request.url : options.request;
  const initialUrl = requestUrl ?? staticPrefix(leaf.path) ?? "/";
  const url = new URL(initialUrl, TEST_ORIGIN);

  const loaderData: Record<string, unknown> = { ...(options.loaderData ?? {}) };
  for (const [loader, data] of options.loaders ?? []) {
    loaderData[ensureSyntheticId(loader as object, "$$id")] = data;
  }

  if (typeof window !== "undefined") {
    const stateObj: Record<string, unknown> = {};
    for (const [def, value] of options.locationState ?? []) {
      stateObj[ensureSyntheticId(def as object, "__rsc_ls_key")] = value;
    }
    window.history.replaceState(stateObj, "");
  }

  const resolve = (pathname: string): ResolvedMatch => {
    const matched = matchLeaf(leaf.path, pathname) ?? {};
    return {
      params: { ...matched, ...(options.params ?? {}) },
      pathname,
    };
  };
  const initialMatch = resolve(url.pathname);

  const historyKey = generateHistoryKey(url.href);
  const mount = normalizeBasename(options.mount);
  const basename = normalizeBasename(options.basename);
  // Fail loud on a request that cannot resolve the leaf route (a typo, or the
  // mount-prefixed-vs-relative confusion) instead of silently rendering empty
  // params (matchLeaf -> null -> {}). renderRoute paths are include-RELATIVE and
  // resolve() matches the request against the leaf as-is, so the request must be
  // the relative form — a mount does NOT rewrite it. Only checked when `request`
  // was passed explicitly (a defaulted request is staticPrefix of the leaf and
  // always matches). Skipped when explicit `params` are supplied: those are
  // merged over the URL-extracted params in resolve(), so the request is
  // intentionally not the param source and an empty matchLeaf is not the trap.
  // Gated on the test runner so it can never affect production.
  if (
    options.request !== undefined &&
    Object.keys(options.params ?? {}).length === 0 &&
    isUnderTestRunner() &&
    matchLeaf(leaf.path, url.pathname) === null
  ) {
    throw new Error(
      `renderRoute: request "${url.pathname}" does not match the leaf route ` +
        `"${leaf.path}"${mount ? ` (mount "${mount}")` : ""}. renderRoute paths ` +
        `are include-RELATIVE: pass a request that matches "${leaf.path}" ` +
        `(e.g. "${staticPrefix(leaf.path)}"). A mount does NOT auto-rewrite the ` +
        `request — pass the relative path, not the mount-prefixed one. If the ` +
        `request URL intentionally does not carry the params, pass them ` +
        `explicitly via the \`params\` option to bypass this check.`,
    );
  }
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
  const leafRouteSegmentId =
    [...initialSegments].reverse().find((s) => s.type === "route")?.id ??
    initialSegments[initialSegments.length - 1]?.id;
  const handleSeed: HandleDataSeed = cloneHandleSeed(options.handle);
  for (const [handle, values] of options.handles ?? []) {
    if (leafRouteSegmentId === undefined) continue;
    const id = (handle as unknown as { $$id: string }).$$id;
    (handleSeed[id] ??= {})[leafRouteSegmentId] = values;
  }

  const eventController = createEventController({ initialLocation: url });
  eventController.setParams(initialMatch.params);
  // Resolve-by-default: resolve any deferred (Promise) seeded handle values
  // before applying, so the seeded handles reach collect/useHandle resolved —
  // matching what the server/client do in a real app.
  const resolvedSeed = await resolveDeferredHandleValues(handleSeed);
  eventController.setHandleData(
    resolvedSeed,
    initialSegments.map((s) => s.id),
  );

  let warnedNavLifecycle = false;
  const navigate = async (target: string): Promise<void> => {
    // renderRoute commits navigations synchronously (no server fetch, no Flight
    // stream), so it never drives the navigation lifecycle. The transition state
    // useNavigation()/useLinkStatus()/useAction() read stays "idle" — asserting a
    // pending/loading/submitting state here proves nothing. Warn once (per render)
    // under the test runner so that false-confidence trap is loud, not silent.
    if (isUnderTestRunner() && !warnedNavLifecycle) {
      warnedNavLifecycle = true;
      console.warn(
        "renderRoute: navigate()/useRouter().push commit synchronously and do " +
          "NOT drive the navigation lifecycle. useNavigation().state, " +
          'useLinkStatus().pending, and useAction().state stay "idle" here. ' +
          "Assert params/pathname/content after navigate(); use renderServerTree " +
          "or e2e to assert pending/loading/submitting transition states.",
      );
    }
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

  let prefetchRoot: HTMLElement | undefined;
  const bridge: NavigationBridge = {
    navigate: (target) => navigate(target),
    refresh: () => navigate(url.pathname + url.search),
    handlePopstate: async () => {},
    registerLinkInterception: () => () => {},
    registerDelegatedPrefetch: () =>
      setupNavigationBridgeDelegatedPrefetch(
        store,
        eventController,
        () => undefined,
        {
          defaultPrefetch: options.defaultPrefetch,
          root: prefetchRoot,
          basename,
        },
      ),
    getVersion: () => undefined,
    updateVersion: () => {},
  };

  const initialMetadata = {
    ...makeMetadata(url.pathname, initialSegments, initialMatch.params),
    defaultPrefetch: options.defaultPrefetch,
  };
  const initialTree = await renderSegments(initialSegments);

  // Wrap render in an awaited async act so a tree that suspends (async loaders,
  // loading states, deferred handle entries that arrive as a Promise) settles its
  // Suspense within act — otherwise React orphans the resolution ("a component
  // suspended inside an act scope, but the act call was not awaited") and the
  // resolved content never reaches the asserted DOM.
  let result!: Awaited<ReturnType<typeof render>>;
  const container = document.body.appendChild(document.createElement("div"));
  prefetchRoot = container;
  await act(async () => {
    result = render(
      <>
        <NavigationProvider
          store={store}
          eventController={eventController}
          initialPayload={{ root: initialTree, metadata: initialMetadata }}
          bridge={bridge}
          basename={basename}
          themeConfig={
            options.theme === undefined
              ? null
              : resolveThemeConfig(options.theme)
          }
          nonce={options.nonce}
        />
        <DelegatedPrefetchRegistration bridge={bridge} />
      </>,
      { baseElement: document.body, container },
    );
  });

  const router: TestRouterHandle = {
    navigate,
    pathname: () => new URL(eventController.getLocation().href).pathname,
    params: () => eventController.getParams(),
    store,
    eventController,
  };

  return Object.assign(result, { router });
}

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
