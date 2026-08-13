import * as React from "react";
import { createElement, type ReactNode, type ComponentType } from "react";
import { OutletProvider } from "./outlet-provider.js";
import { MountContextProvider } from "./browser/react/mount-context.js";
import type { ResolvedSegment, RootLayoutProps } from "./types.js";
import { decodeLoaderResults } from "./decode-loader-results.js";
import { invariant } from "./errors.js";
import {
  RouteContentWrapper,
  LoaderBoundary,
  StreamedLoaderErrorBoundary,
} from "./route-content-wrapper.js";
import { RootErrorBoundary } from "./root-error-boundary.js";
import { INTERNAL_RANGO_DEBUG } from "./internal-debug.js";
import { getMemoizedContentPromise } from "./segment-content-promise.js";
import {
  buildLoaderPromise,
  getMemoizedLoaderPromise,
} from "./segment-loader-promise.js";

/**
 * Debug log for the segment tree build, gated on the baked flag. Runs on BOTH
 * sides now, environment-tagged: `[Browser][segments]` lines up with the
 * `[Browser][boot]` sequence around hydrateRoot; `[Server][segments]` exposes
 * the SSR/RSC tree-build stalls (blocking loader awaits during fizz are what
 * dominate MISS TTFB) that used to be invisible because the logs were
 * window-gated. Server lines have no request correlation — segment-system is
 * shared client code and cannot import request-context (node:async_hooks
 * would enter the browser bundle) — so on a busy server, correlate by
 * timestamp + segment ids.
 */
function segDebugLog(msg: string, details?: Record<string, unknown>): void {
  if (!INTERNAL_RANGO_DEBUG) return;
  const env = typeof window === "object" ? "[Browser]" : "[Server]";
  const prefix = `${env}[segments] ${msg} @ ${Math.round(performance.now())}ms`;
  if (details) {
    console.log(prefix, details);
    return;
  }
  console.log(prefix);
}

// ViewTransition is only available in React experimental.
// Access via namespace import to avoid compile-time errors on stable React.
const ReactViewTransition: any =
  "ViewTransition" in React ? (React as any).ViewTransition : null;

// A loading skeleton is renderable only when it is a real ReactNode value.
// `false` is treated as "not renderable" here. This is the three-term gate;
// the distinct two-term gate at the LoaderBoundary site deliberately treats
// `false` as "create a boundary without a RouteContentWrapper"
// (tree-structure.md), so it must NOT use this helper.
function isRenderableLoading(loading: ReactNode): boolean {
  return loading !== undefined && loading !== null && loading !== false;
}

// Exported for unit testing the no-parallel fast path (D6); internal otherwise.
export function restoreParallelLoaderMarkers(
  segments: ResolvedSegment[],
): ResolvedSegment[] {
  // Parallel-loading markers only exist when a parallel segment is present, so
  // a list with no parallel slot has nothing to restore. Skip the Map alloc and
  // full scan in that (common) case — this runs on every render.
  if (!segments.some((s) => s.type === "parallel")) return segments;

  const parallelLoadingByNamespace = new Map<string, ReactNode>();
  let nextSegments: ResolvedSegment[] | null = null;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (segment.type === "parallel") {
      if (segment.namespace && isRenderableLoading(segment.loading)) {
        parallelLoadingByNamespace.set(segment.namespace, segment.loading);
      }
      continue;
    }

    if (segment.type !== "loader" || segment.parallelLoading !== undefined) {
      continue;
    }

    const parallelLoading = segment.namespace
      ? parallelLoadingByNamespace.get(segment.namespace)
      : undefined;
    if (parallelLoading === undefined) {
      continue;
    }

    if (!nextSegments) {
      nextSegments = segments.slice();
    }
    nextSegments[i] = { ...segment, parallelLoading };
  }

  return nextSegments ?? segments;
}

/**
 * Options for renderSegments
 */
export interface RenderSegmentsOptions {
  /**
   * If true, this render is for a server action response.
   * In browser during actions, we await component promises to prevent
   * UI flickering/suspense during optimistic updates.
   */
  isAction?: boolean;

  /**
   * If true, force awaiting all loaders instead of streaming with Suspense.
   * Used for popstate (back/forward) navigation where we want instant rendering
   * from cache without showing loading skeletons.
   */
  forceAwait?: boolean;

  /** Seeded descendant client-route pending state for testing. */
  outletPending?: boolean;

  /**
   * Intercept segments to inject into the tree.
   * These are parallel segments from intercept routes that need to be
   * associated with their parent layout's named outlet.
   *
   * Passed separately for explicit handling - makes the flow clearer
   * and easier to debug than relying on ID pattern matching.
   */
  interceptSegments?: ResolvedSegment[];

  /**
   * Root layout component that wraps the entire application.
   * When provided, wraps both route content and the error boundary,
   * preventing the app shell from unmounting during errors (avoids FOUC).
   */
  rootLayout?: ComponentType<RootLayoutProps>;
}

function createViewTransitionBoundary(
  transition: NonNullable<ResolvedSegment["transition"]>,
  children: ReactNode,
): ReactNode {
  // `viewTransition` is a router-specific flag (boundary opt-out), not a React
  // <ViewTransition> prop — strip it so it never reaches React.
  const { viewTransition: _viewTransition, ...vtProps } = transition;
  return createElement(ReactViewTransition, {
    ...vtProps,
    children,
  });
}

function wrapDefaultOutletContent(
  content: ReactNode,
  transition: NonNullable<ResolvedSegment["transition"]>,
): ReactNode {
  if (!React.isValidElement(content)) {
    return createViewTransitionBoundary(transition, content);
  }

  const props = content.props as any;

  if (content.type === MountContextProvider) {
    return React.cloneElement(content, {
      children: wrapDefaultOutletContent(props.children, transition),
    } as any);
  }

  if (content.type === OutletProvider && props.segment?.type === "layout") {
    return React.cloneElement(content, {
      content: wrapDefaultOutletContent(props.content, transition),
    } as any);
  }

  if (content.type === LoaderBoundary && props.segment?.type === "layout") {
    return React.cloneElement(content, {
      outletContent: wrapDefaultOutletContent(props.outletContent, transition),
    } as any);
  }

  return createViewTransitionBoundary(transition, content);
}

/**
 * Per-loader stream map for read-site suspension. { ssr: false } loaders were
 * awaited before flush (fresh.ts), so deliver the SETTLED result, not the
 * settled promise: the read site decodes synchronously instead of use()ing a
 * Flight chunk whose fulfilled-at-read-time status is a scheduling race the
 * SSR-completeness contract must not depend on. Unflagged siblings keep the
 * promise (deliberate streaming). Flagged ids are collected as input for the
 * dev SSR-suspension diagnostic (ssr-suspension-warning.ts).
 */
async function buildLoaderStreams(loaders: ResolvedSegment[]): Promise<{
  streams: Record<string, unknown>;
  awaitedIds: string[] | undefined;
}> {
  const streams: Record<string, unknown> = {};
  let awaitedIds: string[] | undefined;
  for (const l of loaders) {
    streams[l.loaderId!] = l.awaitBeforeFlush
      ? await l.loaderData
      : l.loaderData;
    if (l.awaitBeforeFlush) (awaitedIds ??= []).push(l.loaderId!);
  }
  return { streams, awaitedIds };
}

/**
 * Render segments into a React tree with proper layout nesting
 *
 * Layouts nest using OutletProvider; a layout receives the inner content via
 * its `<Outlet />`. Parallel segments do NOT render as inline Fragment siblings
 * — they flow through OutletContext.parallel and are resolved where a layout
 * places `<ParallelOutlet name="@sidebar" />` (or `<Outlet name="@sidebar" />`).
 *
 * The result is always wrapped in RootErrorBoundary so unhandled errors never
 * blank the screen. When `options.rootLayout` is provided it wraps the error
 * boundary at the OUTERMOST level (so the app shell survives errors).
 *
 * Error segments are treated like route segments - they render their fallback
 * component in place of the failed segment. When an error occurs in a handler,
 * loader, or middleware, the router creates an error segment with the nearest
 * error boundary's fallback component.
 *
 * NotFound segments are similar to error segments but are triggered by
 * DataNotFoundError (thrown via notFound()). They render the nearest
 * notFoundBoundary's fallback component.
 *
 * @param segments - Array of resolved segments to render
 * @returns Promise resolving to the ReactNode tree (the function is async)
 *
 * @example
 * ```typescript
 * const segments = [
 *   { id: 'L0.0', type: 'layout', component: <BlogLayout /> },
 *   { id: 'L0R1', type: 'route', component: <BlogPost /> },
 *   { id: 'L0R1.@sidebar', type: 'parallel', component: <Sidebar />, slot: '@sidebar' }
 * ];
 *
 * // BlogLayout renders <Outlet /> for the route and
 * // <ParallelOutlet name="@sidebar" /> for the parallel slot.
 * const tree = await renderSegments(segments, { rootLayout: RootLayout });
 * // Results in (outermost first):
 * // <RootLayout>
 * //   <RootErrorBoundary>
 * //     <OutletProvider segment={BlogLayout} parallel={[Sidebar]}>
 * //       <BlogPost />
 * //     </OutletProvider>
 * //   </RootErrorBoundary>
 * // </RootLayout>
 *
 * // For server actions, pass isAction to await components:
 * const tree = await renderSegments(segments, { isAction: true });
 * ```
 */
export async function renderSegments(
  segments: ResolvedSegment[],
  options?: RenderSegmentsOptions,
): Promise<ReactNode> {
  const {
    isAction,
    interceptSegments,
    forceAwait,
    outletPending = false,
    rootLayout: RootLayout,
  } = options || {};

  const segDebug = INTERNAL_RANGO_DEBUG;
  const segDebugStart = segDebug ? performance.now() : 0;
  if (segDebug) {
    segDebugLog("renderSegments start", {
      segments: segments.map((s) => `${s.id}:${s.type}`),
      isAction: !!isAction,
      forceAwait: !!forceAwait,
      intercepts: interceptSegments?.length ?? 0,
    });
  }

  const temporalLazyRefs: Promise<any>[] = [];
  const normalizedSegments = restoreParallelLoaderMarkers(segments);
  const normalizedInterceptSegments = interceptSegments
    ? restoreParallelLoaderMarkers(interceptSegments)
    : undefined;

  /**
   * Registers promises from lazy/async components for awaiting.
   * Handles both direct promises and React lazy components (which store promise in _payload).
   */
  const registerLazyRef = <T,>(node: T): T => {
    if (node instanceof Promise) {
      temporalLazyRefs.push(node);
    } else if (isLazyComponent(node)) {
      temporalLazyRefs.push(node._payload);
    }
    return node;
  };

  // Type guard for React lazy component internals
  function isLazyComponent(node: unknown): node is { _payload: Promise<any> } {
    return (
      node != null &&
      typeof node === "object" &&
      "_payload" in node &&
      (node as any)._payload instanceof Promise
    );
  }
  // Separate segments by type, passing intercept segments for explicit injection
  const tree = segmentTreeWalk(normalizedSegments, normalizedInterceptSegments);

  // A route is "in a transition scope" when its own segment OR any layout in
  // its matched chain declares transition(). Both transition() forms land here:
  // the per-route item form sets transition on the route entry, and the block
  // wrapper form sets it on a transparent ancestor layout (dsl-helpers.ts). When
  // in scope, the route and its route-owned layouts use param-agnostic keys so a
  // same-route navigation reconciles (holds content) instead of remounting. The
  // value is a static property of the route's position in the tree, so it is the
  // same on every render of that route (SSR, navigation, action) — the keys
  // never drift. Cross-route navigation still remounts: different routes have
  // different segment ids regardless of transition scope.
  const inTransitionScope = normalizedSegments.some(
    (s) =>
      s.transition != null &&
      (s.type === "layout" ||
        s.type === "route" ||
        s.type === "error" ||
        s.type === "notFound"),
  );
  // Render content segments as siblings
  let content: ReactNode = null;
  for (const node of tree) {
    invariant(
      node.segment.type === "layout" ||
        node.segment.type === "route" ||
        node.segment.type === "error" ||
        node.segment.type === "notFound",
      `Expected layout, route, error, or notFound segment, got ${node.segment.type}`,
    );
    const { component, id, params, loading } = node.segment;
    const segNodeStart = segDebug ? performance.now() : 0;

    // Param-agnostic keys are opt-in via the transition() DSL (see
    // inTransitionScope above). A route (and its route-owned layouts) inside a
    // transition scope drops the param from its key, so navigating between two
    // param values of the SAME route (e.g. /product/1 -> /product/2) reconciles
    // the route subtree instead of remounting it. Combined with the
    // startTransition wrap that shouldStartViewTransition already applies to
    // transition routes (browser/partial-update.ts), the previous content stays
    // on screen while the new loaders resolve (stale-while-revalidate) instead
    // of flashing the loading skeleton. This works on stable React; experimental
    // React adds the animated <ViewTransition> cross-fade on top.
    //
    // Outside a transition scope the key stays param-bearing and the route
    // remounts on param change (the default: a fresh skeleton and fresh
    // component state).
    //
    // error/notFound always keep param-bearing keys: createErrorSegment reuses
    // the boundary layout's shortCode as the error segment id (router/
    // error-handling.ts), so a param-agnostic error key could collide with that
    // layout's key within the same render.
    const includeParams =
      node.segment.type === "error" ||
      node.segment.type === "notFound" ||
      ((node.segment.type === "route" ||
        (node.segment.type === "layout" && node.segment.belongsToRoute)) &&
        !inTransitionScope);

    const paramStr =
      includeParams && params && Object.keys(params).length > 0
        ? Object.entries(params)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(",")
        : "";
    const key = paramStr ? `${id}-${paramStr}` : id;

    const loaderEntries = node.loaders.filter(
      (loader) => loader.loaderId && loader.loaderData !== undefined,
    );

    let resolvedComponent = component;
    if (isAction && component instanceof Promise) {
      const componentAwaitStart = segDebug ? performance.now() : 0;
      resolvedComponent = await component;
      if (segDebug) {
        segDebugLog(`segment ${id}: component awaited (action)`, {
          ms: Math.round(performance.now() - componentAwaitStart),
        });
      }
    }

    let nodeContent: ReactNode = null;
    if (isRenderableLoading(loading)) {
      // forceAwait (popstate, stale-revalidation, fully-prefetched nav) renders a
      // loading() route with the route content ALREADY resolved, so its
      // RouteContentWrapper Suspender does not suspend for a microtask and flash
      // the loading() fallback on a NORMAL (non-transition) commit. The router
      // data is known-ready on these paths, so awaiting the content here is free.
      // The wrapper tree is unchanged (RouteContentWrapper is still created with
      // the same key/fallback) — only the `content` prop is a resolved node
      // instead of a pending promise, which Suspender renders synchronously. This
      // mirrors the forceAwait loaderData unwrap above; a CLIENT component that
      // suspends on mount inside the content still reveals a fallback (it is not
      // pre-resolved).
      const contentPromise = getMemoizedContentPromise(resolvedComponent);
      let loadingContent: Promise<ReactNode> | ReactNode = contentPromise;
      if (forceAwait) {
        const contentAwaitStart = segDebug ? performance.now() : 0;
        loadingContent = await contentPromise;
        if (segDebug) {
          segDebugLog(`segment ${id}: content awaited (forceAwait)`, {
            ms: Math.round(performance.now() - contentAwaitStart),
          });
        }
      }
      nodeContent = createElement(RouteContentWrapper, {
        key: `suspense-loading-${id}`,
        content: loadingContent,
        fallback: loading,
        segmentId: id,
      });
    } else {
      // [VT-DIAG] Gated behind INTERNAL_RANGO_DEBUG. A segment in the no-loading()
      // branch whose component decodes as a Promise/lazy gets registered into
      // temporalLazyRefs and awaited before commit (see below) — which on builds
      // where the segment component arrives deferred defeats client-nav streaming.
      if (INTERNAL_RANGO_DEBUG && typeof window === "object") {
        const c = resolvedComponent as unknown;
        console.log("[VT-DIAG] renderSegments no-loading-branch segment", {
          id,
          type: node.segment.type,
          componentIsPromise: c instanceof Promise,
          componentIsLazy:
            c != null && typeof c === "object" && "_payload" in c,
          componentTypeof: typeof c,
        });
      }
      nodeContent = registerLazyRef(resolvedComponent);
    }

    // Wrap with <ViewTransition> if transition config exists (React experimental only).
    // An empty config ({}) creates a bare <ViewTransition> boundary that participates
    // in transitions without adding custom animation classes. Named element-level
    // <ViewTransition> components inside (with name/share props) morph independently
    // from the parent's default cross-fade.
    //
    // For layouts, wrap the outlet content (what `<Outlet />` renders) rather
    // than the layout component itself. Parallel slots like `<ParallelOutlet
    // name="@modal" />` read from a separate context channel and end up as
    // siblings of the VT in the rendered tree, so modal mounts don't trigger a
    // subtree update on the layout-level VT — which would otherwise make
    // React's commit walker fire `document.startViewTransition` and apply
    // view-transition-names to the underlying main subtree (cover/title/etc.).
    //
    // `transition.viewTransition === false` opts out of the router-owned
    // boundary only. Driving (the startTransition wrap in browser/partial-update.ts
    // and the param-agnostic key/hold below) keys off transition *presence*, not
    // this flag, so a boundary-less transition still holds content and lets
    // consumer-placed <ViewTransition> elements animate. The global
    // createRouter({ viewTransition }) default is resolved into this field
    // during segment resolution (only `false` is stamped; unset/"auto" is left
    // as-is and means "wrap"), so this gate needs no router-option threading.
    let outletContent: ReactNode =
      node.segment.type === "layout" ? content : null;

    const transition = node.segment.transition;

    if (
      ReactViewTransition &&
      transition &&
      transition.viewTransition !== false
    ) {
      if (node.segment.type === "layout") {
        outletContent = wrapDefaultOutletContent(outletContent, transition);
      } else {
        nodeContent = createViewTransitionBoundary(transition, nodeContent);
      }
    }

    // Prepare loader data if there are loaders
    const loaderIds = loaderEntries.map((loader) => loader.loaderId!);

    // Loader-bearing segments get the router-owned error boundary around
    // their children so a read-site loader error renders its errorBoundary()
    // fallback (LOADER_ERROR_FALLBACK marker on the thrown error) instead of
    // escaping to app boundaries. Wrapped UNCONDITIONALLY on loader presence
    // — streams and forceAwait lanes must produce the same tree shape or
    // lane changes remount the subtree (docs/tree-structure.md).
    if (loaderEntries.length > 0) {
      nodeContent = createElement(StreamedLoaderErrorBoundary, {
        children: nodeContent,
      });
    }

    if (loading !== undefined && loading !== null) {
      const loaderDataPromise = getMemoizedLoaderPromise(loaderEntries);
      let boundaryLoaderData: Promise<any[]> | any[] = loaderDataPromise;
      // SPIKE (streaming useLoader): per-loader streams for the boundary's
      // readers. MUST come from the individual loader refs — splitting the
      // aggregate client-side is wrong (Promise.all resolves at the slowest
      // loader, erasing per-loader timing; measured 400ms data held to a
      // 2000ms sibling). Zero-loader boundaries pass NO streams so the
      // resolver keeps the fresh-promise resolve-above suspension — that
      // microtask suspension is what makes SSR emit the loading() fallback
      // for content-suspending routes (segment-loader-promise.ts).
      let boundaryLoaderStreams: Record<string, unknown> | undefined;
      let boundaryAwaitedLoaderIds: string[] | undefined;
      if (forceAwait || isAction) {
        const awaitStart = segDebug ? performance.now() : 0;
        boundaryLoaderData = await loaderDataPromise;
        if (segDebug) {
          segDebugLog(`segment ${id}: loaders awaited (forceAwait/action)`, {
            loaderIds,
            ms: Math.round(performance.now() - awaitStart),
          });
        }
      } else if (loaderEntries.length > 0) {
        ({
          streams: boundaryLoaderStreams,
          awaitedIds: boundaryAwaitedLoaderIds,
        } = await buildLoaderStreams(loaderEntries));
        if (segDebug) {
          segDebugLog(
            `segment ${id}: per-loader streams via LoaderBoundary (read-site suspense)`,
            { loaderIds },
          );
        }
      }
      content = createElement(LoaderBoundary, {
        key: `loader-boundary-${key}`,
        loaderDataPromise: boundaryLoaderData,
        loaderIds,
        loaderStreams: boundaryLoaderStreams,
        awaitedLoaderIds: boundaryAwaitedLoaderIds,
        fallback: loading,
        outletKey: key,
        outletContent,
        segment: node.segment,
        parallel: node.parallel,
        children: nodeContent,
      });
    } else if (loaderEntries.length === 0) {
      content = createElement(OutletProvider, {
        key,
        content: outletContent,
        segment: node.segment,
        parallel: node.parallel,
        pending: outletPending,
        children: nodeContent,
      });
    } else {
      const layoutLoaders = loaderEntries.filter((l) => !l.parallelLoading);
      const parallelOwnedLoaders = loaderEntries.filter(
        (l) => !!l.parallelLoading,
      );

      const layoutLoaderIds = layoutLoaders.map((l) => l.loaderId!);
      // SPIKE (streaming useLoader): a segment without loading() used to BLOCK
      // the tree build here (await buildLoaderPromise) so its data was always
      // resolved before render. Streaming lanes now skip the await and pass
      // per-loader UNDECODED results (possibly pending promises) through
      // OutletProvider.loaderStreams — useLoader suspends at the read site to
      // the nearest CONSUMER Suspense boundary. forceAwait (popstate, stale
      // revalidation, fully-prefetched) and action lanes keep the blocking
      // await so those commits stay whole with no fallback flash.
      let loaderData: Record<string, any> = {};
      let errorFallback: ReactNode = null;
      let loaderStreams: Record<string, unknown> | undefined;
      let awaitedLoaderIds: string[] | undefined;
      if (forceAwait || isAction) {
        const layoutAwaitStart = segDebug ? performance.now() : 0;
        const resolvedData = await buildLoaderPromise(layoutLoaders);
        if (segDebug) {
          segDebugLog(`segment ${id}: layout loaders awaited (blocking)`, {
            loaderIds: layoutLoaderIds,
            ms: Math.round(performance.now() - layoutAwaitStart),
          });
        }
        const decodeStart = segDebug ? performance.now() : 0;
        ({ loaderData, errorFallback } = decodeLoaderResults(
          resolvedData,
          layoutLoaderIds,
        ));
        if (segDebug) {
          const decodeMs = Math.round(performance.now() - decodeStart);
          if (decodeMs > 0) {
            segDebugLog(`segment ${id}: loader results decoded`, {
              ms: decodeMs,
            });
          }
        }
      } else if (layoutLoaders.length > 0) {
        ({ streams: loaderStreams, awaitedIds: awaitedLoaderIds } =
          await buildLoaderStreams(layoutLoaders));
        if (segDebug) {
          segDebugLog(
            `segment ${id}: layout loaders streaming to read sites (no loading())`,
            { loaderIds: layoutLoaderIds },
          );
        }
      }

      if (parallelOwnedLoaders.length > 0) {
        const loadersByParallelNamespace = new Map<string, ResolvedSegment[]>();

        for (const loader of parallelOwnedLoaders) {
          if (!loader.namespace) {
            continue;
          }
          const existing = loadersByParallelNamespace.get(loader.namespace);
          if (existing) {
            existing.push(loader);
          } else {
            loadersByParallelNamespace.set(loader.namespace, [loader]);
          }
        }

        for (const p of node.parallel) {
          if (!p.loading || !p.namespace) {
            continue;
          }

          const ownedLoaders = loadersByParallelNamespace.get(p.namespace);
          if (!ownedLoaders || ownedLoaders.length === 0) {
            continue;
          }

          p.loaderIds = ownedLoaders.map((l) => l.loaderId!);
          const aggregated = getMemoizedLoaderPromise(ownedLoaders);
          if (forceAwait || isAction) {
            const parallelAwaitStart = segDebug ? performance.now() : 0;
            p.loaderDataPromise =
              aggregated instanceof Promise ? await aggregated : aggregated;
            // Reused cached parallel segments still carry the document
            // stream map. LoaderResolver short-circuits on loaderStreams
            // and would ignore this fresh aggregate (mini @cart after
            // addToCart stayed at 0).
            p.loaderStreams = undefined;
            p.awaitedLoaderIds = undefined;
            if (segDebug) {
              segDebugLog(
                `segment ${id}: parallel ${p.id} loaders awaited (forceAwait/action)`,
                {
                  loaderIds: p.loaderIds,
                  ms: Math.round(performance.now() - parallelAwaitStart),
                },
              );
            }
          } else {
            p.loaderDataPromise = aggregated;
            ({ streams: p.loaderStreams, awaitedIds: p.awaitedLoaderIds } =
              await buildLoaderStreams(ownedLoaders));
            if (segDebug) {
              segDebugLog(
                `segment ${id}: parallel ${p.id} loaders streaming (suspense)`,
                { loaderIds: p.loaderIds },
              );
            }
          }
        }
      }

      content = createElement(OutletProvider, {
        key,
        content: outletContent,
        segment: node.segment,
        parallel: node.parallel,
        loaderData: Object.keys(loaderData).length > 0 ? loaderData : undefined,
        loaderStreams,
        awaitedLoaderIds,
        pending: outletPending,
        children: errorFallback ?? nodeContent,
      });
    }

    // Wrap with MountContextProvider for include() scoped components.
    // Must use MountContextProvider (a proper "use client" export) instead of
    // MountContext.Provider directly, because .Provider is a property on the
    // context object and resolves to undefined through RSC client reference proxies.
    if (node.segment.mountPath) {
      content = createElement(MountContextProvider, {
        value: node.segment.mountPath,
        children: content,
      });
    }

    if (segDebug) {
      segDebugLog(`segment ${id} built`, {
        type: node.segment.type,
        ms: Math.round(performance.now() - segNodeStart),
        loaders: node.loaders.map((l) => l.loaderId).filter(Boolean),
        hasLoading: loading !== undefined && loading !== null,
        parallel: node.parallel.map((p) => p.id),
      });
    }
  }

  const errorBoundaryWrapped = createElement(RootErrorBoundary, {
    children: content,
  });
  if (typeof window === "object") {
    // [VT-DIAG] Gated behind INTERNAL_RANGO_DEBUG. If this await dominates the
    // navigation time, a deferred/lazy segment component is being fully resolved
    // before commit, which defeats client-nav streaming. The await itself is
    // functional (it preloads lazy chunk refs); only the timing log is gated.
    const vtDebug = INTERNAL_RANGO_DEBUG && temporalLazyRefs.length > 0;
    const vtDebugStart = vtDebug ? performance.now() : 0;
    if (vtDebug) {
      console.log("[VT-DIAG] renderSegments awaiting temporalLazyRefs", {
        count: temporalLazyRefs.length,
      });
    }
    await Promise.allSettled(temporalLazyRefs);
    if (vtDebug) {
      console.log("[VT-DIAG] renderSegments temporalLazyRefs settled", {
        count: temporalLazyRefs.length,
        ms: Math.round(performance.now() - vtDebugStart),
      });
    }
  }

  let result: ReactNode = errorBoundaryWrapped;

  if (RootLayout) {
    result = createElement(RootLayout, {
      children: errorBoundaryWrapped,
    });
  }

  if (segDebug) {
    segDebugLog("renderSegments complete", {
      ms: Math.round(performance.now() - segDebugStart),
    });
  }

  return result;
}

/**
 * Walk segments in bottom-to-top order for React nesting
 *
 * Segments from match() are in top-to-bottom order (root → leaf):
 * Example: [L0, L0L0, L0R1L0.@sidebar, L0R1L0, L0R1]
 *
 * For proper React rendering, we need bottom-to-top (leaf → root):
 * - Innermost content (route) wraps inside layouts
 * - Each layer provides context via OutletProvider
 * - Outer layouts receive inner content via <Outlet />
 *
 * Parallel segments must be matched to their parent by ID prefix:
 * - "L0R1L0.@sidebar" belongs to "L0R1L0"
 * - Pre-grouping prevents parallels from attaching to wrong parents
 *   during the reversed iteration (which would cause "L0R1L0.@sidebar"
 *   to incorrectly attach to "L0L0" instead of "L0R1L0")
 *
 * Loader segments are also grouped by parent:
 * - "L0D0.cart" belongs to "L0"
 * - Loaders don't render directly, their data is passed to context
 *
 * Intercept segments are passed separately for explicit handling:
 * - They are injected into the correct parent's parallel array
 * - This makes the flow clearer than relying on ID pattern matching
 *
 * @param segments - Main segments from the route tree
 * @param interceptSegments - Optional intercept segments to inject
 */
// Loader segment ids have the grammar `${parentId}D${index}.${loaderId}`.
// parentId is the parent shortCode (M/L/P/R/C + digits, never "D") for normal
// loaders, or `${shortCode}.${slotName}` for intercept-slot loaders, where the
// slot name is user-controlled (`@${string}`) and may contain an uppercase "D"
// (e.g. "@Detail"). Strip from the first `D<index>.` separator so the slot name
// is preserved; splitting on a bare "D" mis-cut "@Detail" to "@" and silently
// dropped the loader's data. The first-`D<index>.` strip is only correct because
// slot names cannot contain "." -- assertValidSlotName (route-definition/
// dsl-helpers.ts) rejects a "." at definition time, so a name like "@D3.foo"
// (which WOULD mis-cut here) can never reach this function.
function loaderParentId(loaderSegmentId: string): string {
  return loaderSegmentId.replace(/D\d+\..*$/, "");
}

// Append a value to the array stored under `key`, creating the array on first
// use. Single Map lookup (vs the has/get!().push double-lookup idiom).
function pushToGroup<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) {
    arr.push(value);
  } else {
    map.set(key, [value]);
  }
}

function* segmentTreeWalk(
  segments: ResolvedSegment[],
  interceptSegments?: ResolvedSegment[],
): Generator<{
  segment: ResolvedSegment;
  parallel: ResolvedSegment[];
  loaders: ResolvedSegment[];
}> {
  // Pre-group parallel and loader segments by their parent ID using prefix matching
  // This ensures each parallel/loader is associated with the correct parent segment
  // regardless of the iteration order
  const parallelsByParent = new Map<string, ResolvedSegment[]>();
  const loadersByParent = new Map<string, ResolvedSegment[]>();
  const nonParallels: ResolvedSegment[] = [];

  for (const segment of segments) {
    if (segment.type === "parallel") {
      // Extract parent ID from parallel ID
      // Example: "L0R1L0.@sidebar" → "L0R1L0"
      const parentId = segment.id.split(".")[0];
      pushToGroup(parallelsByParent, parentId, segment);
    } else if (segment.type === "loader") {
      // Extract parent ID from loader ID
      // Example: "L0D0.cart" → "L0"; "L0.@DetailD0.x" → "L0.@Detail"
      const parentId = loaderParentId(segment.id);
      pushToGroup(loadersByParent, parentId, segment);
    } else {
      // Layout, route, error, and notFound segments are all rendered in the tree
      // Error/notFound segments replace the failed segment with fallback UI
      nonParallels.push(segment);
    }
  }

  // INTERCEPT SEGMENTS: Explicitly inject into parent's parallel array
  // Intercept segments are passed separately for explicit handling
  if (interceptSegments && interceptSegments.length > 0) {
    for (const intercept of interceptSegments) {
      if (intercept.type === "parallel" && intercept.slot) {
        // Extract parent ID from intercept ID (e.g., "M4L0L0L2.@modal" → "M4L0L0L2")
        const parentId = intercept.id.split(".")[0];
        pushToGroup(parallelsByParent, parentId, intercept);
      } else if (intercept.type === "loader") {
        // Intercept loaders - extract parent from loader ID (slot name preserved)
        const parentId = loaderParentId(intercept.id);
        pushToGroup(loadersByParent, parentId, intercept);
      }
    }
  }

  // Segments arrive in root-to-leaf order from the server (resolveSegment
  // and resolveSegmentWithRevalidation push segments in this order).
  // All consumers (reconcileSegments, cache) preserve this order.
  // No sorting needed — iterate bottom-to-top to process leaf segments first.
  // This processes route/leaf layouts first, then parent layouts
  // Note: We reverse the array to iterate from end to start (bottom-to-top)

  for (let i = nonParallels.length - 1; i >= 0; i--) {
    const segment = nonParallels[i];

    // Lookup parallels and loaders that belong to this segment by ID prefix
    const parallel = parallelsByParent.get(segment.id) || [];
    const loaders = loadersByParent.get(segment.id) || [];

    // Also include loaders from parallel segments (e.g., intercept loaders)
    // These have parent IDs like "M9L0L1.@modal" which match the parallel segment ID
    for (const p of parallel) {
      const parallelLoaders = loadersByParent.get(p.id);
      if (parallelLoaders) {
        loaders.push(...parallelLoaders);
      }
    }

    yield { segment, parallel, loaders };
  }
}
