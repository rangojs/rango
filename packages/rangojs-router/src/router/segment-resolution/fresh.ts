/**
 * Fresh Path Segment Resolution
 *
 * Functions for resolving segments during a full (non-revalidation) request.
 * Handles loaders, layouts, routes, parallels, orphan layouts, and error boundaries.
 */

import type { ReactNode } from "react";
import { invariant } from "../../errors";
import {
  getParallelEntries,
  getParallelSlotEntries,
  type EntryData,
} from "../../server/context";
import type {
  HandlerContext,
  InternalHandlerContext,
  ResolvedSegment,
} from "../../types";
import type { SegmentResolutionDeps } from "../types.js";
import { resolveLoaderData } from "./loader-cache.js";
import { _getRequestContext } from "../../server/request-context.js";
import { appendMetric } from "../metrics.js";
import {
  handleHandlerResult,
  tryStaticHandler,
  tryStaticSlot,
  resolveLayoutComponent,
  resolveWithErrorBoundary,
} from "./helpers.js";
import { getRouterContext } from "../router-context.js";
import { resolveSink, safeEmit } from "../telemetry.js";
import {
  track,
  RSCRouterContext,
  runInsideLoaderScope,
} from "../../server/context.js";

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
  const ms = _getRequestContext()?._metricsStore;

  if (!loadingDisabled) {
    // Streaming loaders: promises kick off now, settle during RSC serialization.
    const segments = loaderEntries.map((loaderEntry, i) => {
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
          runInsideLoaderScope(() =>
            resolveLoaderData(loaderEntry, ctx, ctx.pathname),
          ),
          entry,
          segmentId,
          ctx.pathname,
        ),
        belongsToRoute,
      };
    });

    return segments;
  }

  // Loading disabled: still start all loaders in parallel, but only emit
  // settled promises so handlers don't stream loading placeholders.
  const pendingLoaderData = loaderEntries.map((loaderEntry) => {
    const start = performance.now();
    const promise = runInsideLoaderScope(() =>
      resolveLoaderData(loaderEntry, ctx, ctx.pathname),
    );
    return { promise, start, loaderId: loaderEntry.loader.$$id };
  });
  await Promise.all(pendingLoaderData.map((p) => p.promise));

  return loaderEntries.map((loaderEntry, i) => {
    const { loader } = loaderEntry;
    const segmentId = `${shortCode}D${i}.${loader.$$id}`;
    const pending = pendingLoaderData[i]!;
    if (ms && !ms.metrics.some((m) => m.label === `loader:${loader.$$id}`)) {
      // All loaders ran in parallel via Promise.all — each span covers
      // from its own kickoff to the batch settlement, giving a ceiling
      // on that loader's contribution to the overall wait.
      const batchEnd = performance.now();
      appendMetric(
        ms,
        `loader:${loader.$$id}`,
        pending.start,
        batchEnd - pending.start,
        2,
      );
    }
    return {
      id: segmentId,
      namespace: entry.id,
      type: "loader" as const,
      index: i,
      component: null,
      params: ctx.params,
      loaderId: loader.$$id,
      loaderData: deps.wrapLoaderPromise(
        pending.promise,
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

    const resolvedParallelEntries = new Set<string>();
    for (const { slot, entry: parallelEntry } of getParallelSlotEntries(
      entry.parallel,
    )) {
      const parallelSegments = await resolveParallelEntry(
        parallelEntry,
        params,
        context,
        false,
        entry.shortCode,
        deps,
        options,
        routeKey,
        [slot],
        !resolvedParallelEntries.has(parallelEntry.id),
      );
      segments.push(...parallelSegments);
      resolvedParallelEntries.add(parallelEntry.id);
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
      // For Passthrough routes at runtime, use the live handler instead of
      // the build handler. At build time (context.build === true), always
      // use the build handler from entry.handler.
      const handler =
        !context.build && entry.liveHandler ? entry.liveHandler : entry.handler;
      const doneRouteHandler = track(`handler:${entry.id}`, 2);
      if (entry.loading) {
        const result = handleHandlerResult(handler(context));
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
        component = handleHandlerResult(await handler(context));
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
        entry,
      );
      segments.push(...orphanSegments);
    }

    const resolvedParallelEntries = new Set<string>();
    for (const { slot, entry: parallelEntry } of getParallelSlotEntries(
      entry.parallel,
    )) {
      const parallelSegments = await resolveParallelEntry(
        parallelEntry,
        params,
        context,
        true,
        entry.shortCode,
        deps,
        options,
        routeKey,
        [slot],
        !resolvedParallelEntries.has(parallelEntry.id),
      );
      segments.push(...parallelSegments);
      resolvedParallelEntries.add(parallelEntry.id);
    }

    segments.push({
      id: entry.shortCode,
      namespace: entry.id,
      type: "route",
      index: 0,
      component: component ?? null,
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
  /** Parent route entry — its loaders are inherited by the layout so
   *  parallel slots inside this layout can access them via useLoader(). */
  parentRouteEntry?: EntryData,
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

    // Inherit parent route's loaders so parallel slots inside this layout
    // can access them via useLoader(). Without this, the route's loaders
    // are only in the route's OutletProvider (rendered as <Outlet /> content),
    // which is a child — not a parent — of the layout's context.
    if (
      parentRouteEntry &&
      parentRouteEntry.loader &&
      parentRouteEntry.loader.length > 0 &&
      Object.keys(orphan.parallel).length > 0
    ) {
      const inheritedLoaders = await resolveLoaders(
        parentRouteEntry,
        context,
        belongsToRoute,
        deps,
        orphan.shortCode,
      );
      segments.push(...inheritedLoaders);
    }
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

  const resolvedParallelEntries = new Set<string>();
  for (const { slot, entry: parallelEntry } of getParallelSlotEntries(
    orphan.parallel,
  )) {
    const parallelSegments = await resolveParallelEntry(
      parallelEntry,
      params,
      context,
      belongsToRoute,
      orphan.shortCode,
      deps,
      options,
      routeKey,
      [slot],
      !resolvedParallelEntries.has(parallelEntry.id),
    );
    segments.push(...parallelSegments);
    resolvedParallelEntries.add(parallelEntry.id);
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
  slotNames?: `@${string}`[],
  includeLoaders: boolean = true,
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

  const slotsToResolve = slotNames ?? (Object.keys(slots) as `@${string}`[]);

  for (const slot of slotsToResolve) {
    // Try static lookup first — in production, handler bodies are evicted
    // and replaced with stubs that have no .handler property (undefined).
    // The static store holds the pre-rendered component for these slots.
    let component: ReactNode | undefined = await tryStaticSlot(
      parallelEntry,
      slot,
      `${parentShortCode}.${slot}`,
    );

    if (component === undefined) {
      const handler = slots[slot];
      if (handler === undefined) {
        continue;
      }
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

  if (!options?.skipLoaders && includeLoaders) {
    const loaderSegments = await resolveLoaders(
      parallelEntry,
      context,
      belongsToRoute,
      deps,
      parentShortCode,
    );
    // Tag parallel-owned loaders so renderSegments can stream them
    // using the parallel's loading() instead of awaiting on the layout
    const parallelLoading =
      parallelEntry.loading === false ? undefined : parallelEntry.loading;
    if (parallelLoading) {
      for (const seg of loaderSegments) {
        seg.parallelLoading = parallelLoading;
      }
    }
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
    // Set ALS flag when entering a cache() boundary so that ctx.get()
    // can guard non-cacheable variable reads. Also guards response-level
    // side effects (headers.set). Persists for all descendant entries.
    if (entry.type === "cache") {
      const store = RSCRouterContext.getStore();
      if (store) store.insideCacheScope = true;
    }
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
  const seenIds = new Set<string>();

  async function collectEntryLoaders(
    entry: EntryData,
    belongsToRoute: boolean,
    shortCodeOverride?: string,
  ): Promise<void> {
    // Skip if all loaders from this entry have already been resolved
    // via a parent (e.g., cache boundary wrapping a layout with shared loaders).
    const entryLoaders = entry.loader ?? [];
    const sc = shortCodeOverride ?? entry.shortCode;
    const allAlreadySeen =
      entryLoaders.length > 0 &&
      entryLoaders.every((le, i) =>
        seenIds.has(`${sc}D${i}.${le.loader.$$id}`),
      );
    if (!allAlreadySeen) {
      const segments = await resolveLoaders(
        entry,
        context,
        belongsToRoute,
        deps,
        shortCodeOverride,
      );
      for (const seg of segments) {
        if (!seenIds.has(seg.id)) {
          seenIds.add(seg.id);
          loaderSegments.push(seg);
        }
      }
    }

    const seenParallelEntryIds = new Set<string>();
    for (const parallelEntry of getParallelEntries(entry.parallel)) {
      if (seenParallelEntryIds.has(parallelEntry.id)) continue;
      seenParallelEntryIds.add(parallelEntry.id);
      await collectEntryLoaders(parallelEntry, belongsToRoute, entry.shortCode);
    }

    const childBelongsToRoute = belongsToRoute || entry.type === "route";
    for (const layoutEntry of entry.layout) {
      await collectEntryLoaders(layoutEntry, childBelongsToRoute);
      // Inherit route loaders for orphan layouts with parallels.
      // Resolve directly — do NOT re-enter collectEntryLoaders with the
      // route entry, as that would re-iterate route.layout and loop.
      if (
        entry.type === "route" &&
        entry.loader &&
        entry.loader.length > 0 &&
        Object.keys(layoutEntry.parallel).length > 0
      ) {
        const inherited = await resolveLoaders(
          entry,
          context,
          childBelongsToRoute,
          deps,
          layoutEntry.shortCode,
        );
        for (const seg of inherited) {
          if (!seenIds.has(seg.id)) {
            seenIds.add(seg.id);
            loaderSegments.push(seg);
          }
        }
      }
    }
  }

  for (const entry of entries) {
    await collectEntryLoaders(entry, entry.type === "route");
  }

  return loaderSegments;
}
