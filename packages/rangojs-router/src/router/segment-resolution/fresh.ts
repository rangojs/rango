/**
 * Fresh Path Segment Resolution
 *
 * Functions for resolving segments during a full (non-revalidation) request.
 * Handles loaders, layouts, routes, parallels, orphan layouts, and error boundaries.
 */

import type { ReactNode } from "react";
import { invariant } from "../../errors";
import type { EntryData } from "../../server/context";
import type {
  HandlerContext,
  InternalHandlerContext,
  ResolvedSegment,
} from "../../types";
import type { SegmentResolutionDeps } from "../types.js";
import { resolveLoaderData } from "./loader-cache.js";
import {
  handleHandlerResult,
  tryStaticHandler,
  tryStaticSlot,
  resolveLayoutComponent,
  resolveWithErrorBoundary,
} from "./helpers.js";
import { getRouterContext } from "../router-context.js";
import { resolveSink, safeEmit } from "../telemetry.js";
import { track } from "../../server/context.js";

// ---------------------------------------------------------------------------
// Streamed handler telemetry
// ---------------------------------------------------------------------------

/**
 * Attach a fire-and-forget rejection observer to a streamed handler promise.
 * React catches the actual error via its error boundary; this only emits
 * the handler.error telemetry event.
 */
function observeStreamedHandler(
  promise: Promise<ReactNode>,
  segmentId: string,
  segmentType: string,
  pathname?: string,
  routeKey?: string,
  params?: Record<string, string>,
): void {
  let routerCtx;
  try {
    routerCtx = getRouterContext();
  } catch {
    return;
  }
  if (!routerCtx?.telemetry) return;
  const sink = resolveSink(routerCtx.telemetry);
  const reqId = routerCtx.requestId;
  promise.catch((err: unknown) => {
    const errorObj = err instanceof Error ? err : new Error(String(err));
    safeEmit(sink, {
      type: "handler.error",
      timestamp: performance.now(),
      requestId: reqId,
      segmentId,
      segmentType,
      error: errorObj,
      handledByBoundary: true,
      pathname,
      routeKey,
      params,
    });
  });
}

// ---------------------------------------------------------------------------
// Fresh path (full match, no revalidation)
// ---------------------------------------------------------------------------

/**
 * Resolve loaders for an entry and emit segments.
 * Loaders are run lazily via ctx.use() and memoized for parallel execution.
 */
export async function resolveLoaders<TEnv>(
  entry: EntryData,
  ctx: HandlerContext<any, TEnv>,
  belongsToRoute: boolean,
  deps: SegmentResolutionDeps<TEnv>,
  shortCodeOverride?: string,
): Promise<ResolvedSegment[]> {
  const loaderEntries = entry.loader ?? [];
  if (loaderEntries.length === 0) return [];

  const shortCode = shortCodeOverride ?? entry.shortCode;
  const hasLoading = "loading" in entry && entry.loading !== undefined;
  const loadingDisabled = hasLoading && entry.loading === false;

  if (!loadingDisabled) {
    return loaderEntries.map((loaderEntry, i) => {
      const { loader } = loaderEntry;
      const segmentId = `${shortCode}D${i}.${loader.$$id}`;
      return {
        id: segmentId,
        namespace: entry.id,
        type: "loader" as const,
        index: i,
        component: null,
        params: ctx.params,
        loaderId: loader.$$id,
        loaderData: deps.wrapLoaderPromise(
          resolveLoaderData(loaderEntry, ctx, ctx.pathname),
          entry,
          segmentId,
          ctx.pathname,
        ),
        belongsToRoute,
      };
    });
  }

  // Loading disabled: still start all loaders in parallel, but only emit
  // settled promises so handlers don't stream loading placeholders.
  const pendingLoaderData = loaderEntries.map((loaderEntry) =>
    resolveLoaderData(loaderEntry, ctx, ctx.pathname),
  );
  await Promise.all(pendingLoaderData);

  return loaderEntries.map((loaderEntry, i) => {
    const { loader } = loaderEntry;
    const segmentId = `${shortCode}D${i}.${loader.$$id}`;
    return {
      id: segmentId,
      namespace: entry.id,
      type: "loader" as const,
      index: i,
      component: null,
      params: ctx.params,
      loaderId: loader.$$id,
      loaderData: deps.wrapLoaderPromise(
        pendingLoaderData[i]!,
        entry,
        segmentId,
        ctx.pathname,
      ),
      belongsToRoute,
    };
  });
}

/**
 * Options for segment resolution.
 */
export interface ResolveSegmentOptions {
  /** When true, skip resolveLoaders() calls (used for pre-rendering) */
  skipLoaders?: boolean;
}

/**
 * Resolve segments from EntryData.
 * Executes middlewares, loaders, parallels, and handlers in correct order.
 * Returns array: [main segment, ...orphan layout segments]
 */
export async function resolveSegment<TEnv>(
  entry: EntryData,
  routeKey: string,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>,
  deps: SegmentResolutionDeps<TEnv>,
  isRouteEntry: boolean = false,
  options?: ResolveSegmentOptions,
): Promise<ResolvedSegment[]> {
  const segments: ResolvedSegment[] = [];

  if (entry.type === "layout" || entry.type === "cache") {
    if (!options?.skipLoaders) {
      const loaderSegments = await resolveLoaders(entry, context, false, deps);
      segments.push(...loaderSegments);
    }

    // Handler-first: layout handler executes before its parallels and orphan
    // layouts so that ctx.set() values are visible to all children.
    (context as InternalHandlerContext<any, TEnv>)._currentSegmentId =
      entry.shortCode;

    const doneLayoutHandler = track(`handler:${entry.id}`, 2);
    const component = await resolveLayoutComponent(entry, context);
    doneLayoutHandler();

    segments.push({
      id: entry.shortCode,
      namespace: entry.id,
      type: "layout",
      index: 0,
      component,
      loading: entry.loading === false ? null : entry.loading,
      transition: entry.transition,
      params,
      belongsToRoute: false,
      layoutName: entry.id,
      ...(entry.mountPath ? { mountPath: entry.mountPath } : {}),
    });

    for (const parallelEntry of entry.parallel) {
      const parallelSegments = await resolveParallelEntry(
        parallelEntry,
        params,
        context,
        false,
        entry.shortCode,
        deps,
        options,
        routeKey,
      );
      segments.push(...parallelSegments);
    }

    for (const orphan of entry.layout) {
      const orphanSegments = await resolveOrphanLayout(
        orphan,
        params,
        context,
        loaderPromises,
        false,
        deps,
        options,
        routeKey,
      );
      segments.push(...orphanSegments);
    }
  } else if (entry.type === "route") {
    if (!options?.skipLoaders) {
      const loaderSegments = await resolveLoaders(entry, context, true, deps);
      segments.push(...loaderSegments);
    }

    // Route handler EXECUTES before its children (orphan layouts, parallels).
    // This lets the handler set() context variables that children can read
    // via get(). Caching wraps all segments together (per-route, not
    // per-segment), so either all run or none do -- no partial scenarios.
    //
    // The handler's segment is PUSHED after orphans/parallels to preserve
    // the correct tree composition order (layouts wrap the route content).
    (context as InternalHandlerContext<any, TEnv>)._currentSegmentId =
      entry.shortCode;
    let component: ReactNode | undefined = await tryStaticHandler(
      entry,
      entry.shortCode,
    );
    if (component === undefined) {
      const doneRouteHandler = track(`handler:${entry.id}`, 2);
      if (entry.loading) {
        const result = handleHandlerResult(entry.handler(context));
        if (result instanceof Promise) {
          result.finally(doneRouteHandler).catch(() => {});
          const tracked = deps.trackHandler(result, {
            segmentId: entry.shortCode,
            segmentType: entry.type,
          });
          observeStreamedHandler(
            tracked,
            entry.shortCode,
            entry.type,
            context.pathname,
            routeKey,
            params,
          );
          component = tracked;
        } else {
          doneRouteHandler();
          component = result;
        }
      } else {
        component = handleHandlerResult(await entry.handler(context));
        doneRouteHandler();
      }
    }

    for (const orphan of entry.layout) {
      const orphanSegments = await resolveOrphanLayout(
        orphan,
        params,
        context,
        loaderPromises,
        true,
        deps,
        options,
        routeKey,
      );
      segments.push(...orphanSegments);
    }

    for (const parallelEntry of entry.parallel) {
      const parallelSegments = await resolveParallelEntry(
        parallelEntry,
        params,
        context,
        true,
        entry.shortCode,
        deps,
        options,
        routeKey,
      );
      segments.push(...parallelSegments);
    }

    segments.push({
      id: entry.shortCode,
      namespace: entry.id,
      type: "route",
      index: 0,
      component,
      loading: entry.loading === false ? null : entry.loading,
      transition: entry.transition,
      params,
      belongsToRoute: true,
      ...(entry.mountPath ? { mountPath: entry.mountPath } : {}),
    });
  } else {
    throw new Error(`Unknown entry type: ${(entry as any).type}`);
  }

  return segments;
}

/**
 * Resolve orphan layout with its middlewares, loaders, and parallels.
 */
export async function resolveOrphanLayout<TEnv>(
  orphan: EntryData,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>,
  belongsToRoute: boolean,
  deps: SegmentResolutionDeps<TEnv>,
  options?: ResolveSegmentOptions,
  routeKey?: string,
): Promise<ResolvedSegment[]> {
  invariant(
    orphan.type === "layout" || orphan.type === "cache",
    `Expected orphan to be a layout or cache, got: ${orphan.type}`,
  );

  const segments: ResolvedSegment[] = [];
  if (!options?.skipLoaders) {
    const loaderSegments = await resolveLoaders(
      orphan,
      context,
      belongsToRoute,
      deps,
    );
    segments.push(...loaderSegments);
  }

  // Handler-first: orphan layout handler executes before its parallels
  // so that ctx.set() values are visible to parallel children.
  const doneOrphanHandler = track(`handler:${orphan.id}`, 2);
  const component = await resolveLayoutComponent(orphan, context);
  doneOrphanHandler();

  segments.push({
    id: orphan.shortCode,
    namespace: orphan.id,
    type: "layout",
    index: 0,
    component,
    params,
    belongsToRoute,
    layoutName: orphan.id,
    loading: orphan.loading === false ? null : orphan.loading,
    transition: orphan.transition,
    ...(orphan.mountPath ? { mountPath: orphan.mountPath } : {}),
  });

  for (const parallelEntry of orphan.parallel) {
    const parallelSegments = await resolveParallelEntry(
      parallelEntry,
      params,
      context,
      belongsToRoute,
      orphan.shortCode,
      deps,
      options,
      routeKey,
    );
    segments.push(...parallelSegments);
  }

  return segments;
}

/**
 * Resolve parallel EntryData with its loaders and slot handlers.
 */
export async function resolveParallelEntry<TEnv>(
  parallelEntry: EntryData,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  belongsToRoute: boolean,
  parentShortCode: string,
  deps: SegmentResolutionDeps<TEnv>,
  options?: ResolveSegmentOptions,
  routeKey?: string,
): Promise<ResolvedSegment[]> {
  invariant(
    parallelEntry.type === "parallel",
    `Expected parallel entry, got: ${parallelEntry.type}`,
  );

  const segments: ResolvedSegment[] = [];

  const slots = parallelEntry.handler as Record<
    `@${string}`,
    | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
    | ReactNode
  >;

  for (const [slot, handler] of Object.entries(slots)) {
    let component: ReactNode | undefined = await tryStaticSlot(
      parallelEntry,
      slot,
      `${parentShortCode}.${slot}`,
    );

    if (component === undefined) {
      const doneParallelHandler = track(
        `handler:${parallelEntry.id}.${slot}`,
        2,
      );
      const hasLoadingFallback =
        parallelEntry.loading !== undefined && parallelEntry.loading !== false;
      if (hasLoadingFallback) {
        const result =
          typeof handler === "function" ? handler(context) : handler;
        if (result instanceof Promise) {
          result.finally(doneParallelHandler).catch(() => {});
          const tracked = deps.trackHandler(result, {
            segmentId: `${parentShortCode}.${slot}`,
            segmentType: "parallel",
          });
          observeStreamedHandler(
            tracked,
            `${parentShortCode}.${slot}`,
            "parallel",
            context.pathname,
            routeKey,
            params,
          );
          component = tracked as ReactNode;
        } else {
          doneParallelHandler();
          component = result as ReactNode;
        }
      } else {
        component =
          typeof handler === "function" ? await handler(context) : handler;
        doneParallelHandler();
      }
    }

    segments.push({
      id: `${parentShortCode}.${slot}`,
      namespace: parallelEntry.id,
      type: "parallel",
      index: 0,
      component,
      loading: parallelEntry.loading === false ? null : parallelEntry.loading,
      transition: parallelEntry.transition,
      params,
      slot,
      belongsToRoute,
      parallelName: `${parallelEntry.id}.${slot}`,
      ...(parallelEntry.mountPath
        ? { mountPath: parallelEntry.mountPath }
        : {}),
    });
  }

  if (!parallelEntry.loading && !options?.skipLoaders) {
    const loaderSegments = await resolveLoaders(
      parallelEntry,
      context,
      belongsToRoute,
      deps,
      parentShortCode,
    );
    segments.push(...loaderSegments);
  }

  return segments;
}

/**
 * Resolve all segments for a route (used for single-cache-per-request pattern).
 */
export async function resolveAllSegments<TEnv>(
  entries: EntryData[],
  routeKey: string,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>,
  deps: SegmentResolutionDeps<TEnv>,
  options?: ResolveSegmentOptions,
): Promise<ResolvedSegment[]> {
  const allSegments: ResolvedSegment[] = [];
  const seenIds = new Set<string>();

  // Safe request access: during build-time prerendering, context.request
  // is a throwing getter. Use undefined when unavailable.
  let safeRequest: Request | undefined;
  try {
    safeRequest = context.request;
  } catch {}

  // Get telemetry sink from RouterContext (may not exist during prerendering)
  let telemetry;
  try {
    telemetry = getRouterContext()?.telemetry;
  } catch {}

  for (const entry of entries) {
    const doneEntry = track(`segment:${entry.id}`, 1);
    const resolvedSegments = await resolveWithErrorBoundary(
      entry,
      params,
      () =>
        resolveSegment(
          entry,
          routeKey,
          params,
          context,
          loaderPromises,
          deps,
          false,
          options,
        ),
      (seg) => [seg],
      deps,
      { request: safeRequest, url: context.url, routeKey, telemetry },
      context.pathname,
    );
    doneEntry();
    // Deduplicate by segment ID. include() scopes can produce entries that
    // resolve the same shared layout/loader segment. Duplicates in the segment
    // array propagate to the client's matched[] and change the React tree depth.
    for (const seg of resolvedSegments) {
      if (!seenIds.has(seg.id)) {
        seenIds.add(seg.id);
        allSegments.push(seg);
      }
    }
  }

  return allSegments;
}

/**
 * Resolve only loader segments for all entries (used when serving cached non-loader segments).
 */
export async function resolveLoadersOnly<TEnv>(
  entries: EntryData[],
  context: HandlerContext<any, TEnv>,
  deps: SegmentResolutionDeps<TEnv>,
): Promise<ResolvedSegment[]> {
  const loaderSegments: ResolvedSegment[] = [];

  for (const entry of entries) {
    const belongsToRoute = entry.type === "route";
    const segments = await resolveLoaders(entry, context, belongsToRoute, deps);
    loaderSegments.push(...segments);
  }

  return loaderSegments;
}
