/**
 * Revalidation Path Segment Resolution
 *
 * Functions for resolving segments during partial (revalidation) requests.
 * Mirrors the fresh path but adds revalidation awareness: only re-resolves
 * segments whose revalidate() predicate returns true.
 */

import type { ReactNode } from "react";
import { invariant } from "../../errors";
import { revalidate } from "../loader-resolution.js";
import { evaluateRevalidation } from "../revalidation.js";
import type { EntryData } from "../../server/context";
import type {
  HandlerContext,
  InternalHandlerContext,
  ResolvedSegment,
  ShouldRevalidateFn,
} from "../../types";
import type {
  SegmentResolutionDeps,
  SegmentRevalidationResult,
  ActionContext,
} from "../types.js";
import {
  debugLog,
  pushRevalidationTraceEntry,
  isTraceActive,
} from "../logging.js";
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
// Telemetry helpers
// ---------------------------------------------------------------------------

/**
 * Attach a fire-and-forget rejection observer to a streamed handler promise.
 * Silently no-ops when called outside RouterContext (e.g. in unit tests).
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
// Revalidation telemetry helper
// ---------------------------------------------------------------------------

/**
 * Emit revalidation.decision telemetry for a segment if a sink is configured.
 * Called after evaluateRevalidation returns to capture the decision.
 * Silently no-ops when called outside RouterContext (e.g. in unit tests).
 */
function emitRevalidationDecision(
  segmentId: string,
  pathname: string,
  routeKey: string,
  shouldRevalidate: boolean,
): void {
  let routerCtx;
  try {
    routerCtx = getRouterContext();
  } catch {
    return;
  }
  if (routerCtx?.telemetry) {
    safeEmit(resolveSink(routerCtx.telemetry), {
      type: "revalidation.decision",
      timestamp: performance.now(),
      requestId: routerCtx.requestId,
      segmentId,
      pathname,
      routeKey,
      shouldRevalidate,
    });
  }
}

// ---------------------------------------------------------------------------
// Revalidation path (partial match)
// ---------------------------------------------------------------------------

/**
 * Resolve loaders with revalidation awareness (for partial rendering).
 * Returns both segments to render AND all matched segment IDs.
 */
export async function resolveLoadersWithRevalidation<TEnv>(
  entry: EntryData,
  ctx: HandlerContext<any, TEnv>,
  belongsToRoute: boolean,
  clientSegmentIds: Set<string>,
  prevParams: Record<string, string>,
  request: Request,
  prevUrl: URL,
  nextUrl: URL,
  routeKey: string,
  deps: SegmentResolutionDeps<TEnv>,
  actionContext?: ActionContext,
  shortCodeOverride?: string,
  stale?: boolean,
): Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }> {
  const loaderEntries = entry.loader ?? [];
  if (loaderEntries.length === 0) return { segments: [], matchedIds: [] };

  const shortCode = shortCodeOverride ?? entry.shortCode;

  const loaderMeta = loaderEntries.map((loaderEntry, i) => ({
    loaderEntry,
    loader: loaderEntry.loader,
    loaderRevalidateFns: loaderEntry.revalidate,
    segmentId: `${shortCode}D${i}.${loaderEntry.loader.$$id}`,
    index: i,
  }));

  const matchedIds = loaderMeta.map((m) => m.segmentId);

  const revalidationChecks = await Promise.all(
    loaderMeta.map(
      async ({
        loaderEntry,
        loader,
        loaderRevalidateFns,
        segmentId,
        index,
      }) => {
        const shouldRun = await revalidate(
          async () => {
            if (!clientSegmentIds.has(segmentId)) {
              if (isTraceActive()) {
                pushRevalidationTraceEntry({
                  segmentId,
                  segmentType: "loader",
                  belongsToRoute,
                  source: "loader",
                  defaultShouldRevalidate: true,
                  finalShouldRevalidate: true,
                  reason: "new-segment",
                });
              }
              return true;
            }

            const dummySegment: ResolvedSegment = {
              id: segmentId,
              namespace: entry.id,
              type: "loader",
              index,
              component: null,
              params: ctx.params,
              loaderId: loader.$$id,
              belongsToRoute,
            };

            return await evaluateRevalidation({
              segment: dummySegment,
              prevParams,
              getPrevSegment: null,
              request,
              prevUrl,
              nextUrl,
              revalidations: loaderRevalidateFns.map((fn, j) => ({
                name: `loader-revalidate${j}`,
                fn,
              })),
              routeKey,
              context: ctx,
              actionContext,
              stale,
              traceSource: "loader",
            });
          },
          async () => true,
          () => false,
        );
        emitRevalidationDecision(segmentId, ctx.pathname, routeKey, shouldRun);
        return { shouldRun, loaderEntry, loader, segmentId, index };
      },
    ),
  );

  const loadersToRun = revalidationChecks.filter((c) => c.shouldRun);
  const segments: ResolvedSegment[] = loadersToRun.map(
    ({ loaderEntry, loader, segmentId, index }) => ({
      id: segmentId,
      namespace: entry.id,
      type: "loader" as const,
      index,
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
    }),
  );

  return { segments, matchedIds };
}

/**
 * Resolve only loader segments for all entries with revalidation logic.
 */
export async function resolveLoadersOnlyWithRevalidation<TEnv>(
  entries: EntryData[],
  context: HandlerContext<any, TEnv>,
  clientSegmentIds: Set<string>,
  prevParams: Record<string, string>,
  request: Request,
  prevUrl: URL,
  nextUrl: URL,
  routeKey: string,
  deps: SegmentResolutionDeps<TEnv>,
  actionContext?: ActionContext,
  stale?: boolean,
): Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }> {
  const allLoaderSegments: ResolvedSegment[] = [];
  const allMatchedIds: string[] = [];

  async function collectEntryLoaders(
    entry: EntryData,
    belongsToRoute: boolean,
    shortCodeOverride?: string,
  ): Promise<void> {
    const { segments, matchedIds } = await resolveLoadersWithRevalidation(
      entry,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      deps,
      actionContext,
      shortCodeOverride,
      stale,
    );
    allLoaderSegments.push(...segments);
    allMatchedIds.push(...matchedIds);

    for (const parallelEntry of entry.parallel) {
      await collectEntryLoaders(parallelEntry, belongsToRoute, entry.shortCode);
    }

    const childBelongsToRoute = belongsToRoute || entry.type === "route";
    for (const layoutEntry of entry.layout) {
      await collectEntryLoaders(layoutEntry, childBelongsToRoute);
    }
  }

  for (const entry of entries) {
    await collectEntryLoaders(entry, entry.type === "route");
  }

  return { segments: allLoaderSegments, matchedIds: allMatchedIds };
}

/**
 * Build a map of segment shortCode -> entry with revalidate functions.
 */
export function buildEntryRevalidateMap(
  entries: EntryData[],
): Map<
  string,
  { entry: EntryData; revalidate: ShouldRevalidateFn<any, any>[] }
> {
  const map = new Map<
    string,
    { entry: EntryData; revalidate: ShouldRevalidateFn<any, any>[] }
  >();

  function processEntry(entry: EntryData, parentShortCode?: string) {
    map.set(entry.shortCode, { entry, revalidate: entry.revalidate });

    if (entry.type !== "parallel") {
      for (const parallelEntry of entry.parallel) {
        if (parallelEntry.type === "parallel") {
          const slots = Object.keys(parallelEntry.handler) as `@${string}`[];
          for (const slot of slots) {
            const parallelParentShortCode = parentShortCode ?? entry.shortCode;
            const parallelId = `${parallelParentShortCode}.${slot}`;
            map.set(parallelId, {
              entry: parallelEntry,
              revalidate: parallelEntry.revalidate,
            });
          }
        }
      }
    }

    for (const layoutEntry of entry.layout) {
      processEntry(layoutEntry, entry.shortCode);
    }
  }

  for (const entry of entries) {
    processEntry(entry);
  }

  return map;
}

/**
 * Resolve parallel segments with revalidation.
 */
export async function resolveParallelSegmentsWithRevalidation<TEnv>(
  entry: EntryData,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  belongsToRoute: boolean,
  clientSegmentIds: Set<string>,
  prevParams: Record<string, string>,
  request: Request,
  prevUrl: URL,
  nextUrl: URL,
  routeKey: string,
  deps: SegmentResolutionDeps<TEnv>,
  actionContext?: ActionContext,
  stale?: boolean,
): Promise<SegmentRevalidationResult> {
  const segments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];

  for (const parallelEntry of entry.parallel) {
    invariant(
      parallelEntry.type === "parallel",
      `Expected parallel entry, got: ${parallelEntry.type}`,
    );

    const slots = parallelEntry.handler as Record<
      `@${string}`,
      | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
      | ReactNode
    >;

    for (const [slot, handler] of Object.entries(slots)) {
      const parallelId = `${entry.shortCode}.${slot}`;

      const isFullRefetch = clientSegmentIds.size === 0;
      // When the parent layout is new (not in client's segment set),
      // all its parallel children must be resolved and tracked.
      // Without this, navigating to a new layout with parallels
      // (e.g., BlogLayout with @sidebar) from a different route
      // would silently drop those parallel segments.
      const isNewParent = !clientSegmentIds.has(entry.shortCode);
      if (
        isFullRefetch ||
        clientSegmentIds.has(parallelId) ||
        belongsToRoute ||
        isNewParent
      ) {
        matchedIds.push(parallelId);
      }

      const shouldResolve = await (async () => {
        if (isFullRefetch) {
          if (isTraceActive()) {
            pushRevalidationTraceEntry({
              segmentId: parallelId,
              segmentType: "parallel",
              belongsToRoute,
              source: "parallel",
              defaultShouldRevalidate: true,
              finalShouldRevalidate: true,
              reason: "full-refetch",
            });
          }
          return true;
        }
        if (!clientSegmentIds.has(parallelId)) {
          const result = belongsToRoute || isNewParent;
          if (isTraceActive()) {
            pushRevalidationTraceEntry({
              segmentId: parallelId,
              segmentType: "parallel",
              belongsToRoute,
              source: "parallel",
              defaultShouldRevalidate: result,
              finalShouldRevalidate: result,
              reason: result ? "new-segment" : "skip-parent-chain",
            });
          }
          return result;
        }

        const dummySegment: ResolvedSegment = {
          id: parallelId,
          namespace: parallelEntry.id,
          type: "parallel",
          index: 0,
          component: null as any,
          params,
          slot,
          belongsToRoute,
          parallelName: `${parallelEntry.id}.${slot}`,
          ...(parallelEntry.mountPath
            ? { mountPath: parallelEntry.mountPath }
            : {}),
        };

        return await evaluateRevalidation({
          segment: dummySegment,
          prevParams,
          getPrevSegment: null,
          request,
          prevUrl,
          nextUrl,
          revalidations: parallelEntry.revalidate.map((fn, i) => ({
            name: `revalidate${i}`,
            fn,
          })),
          routeKey,
          context,
          actionContext,
          stale,
          traceSource: "parallel",
        });
      })();
      emitRevalidationDecision(
        parallelId,
        context.pathname,
        routeKey,
        shouldResolve,
      );

      let component: ReactNode | undefined;
      if (shouldResolve) {
        component = await tryStaticSlot(parallelEntry, slot, parallelId);
      }
      if (component === undefined) {
        const hasLoadingFallback =
          parallelEntry.loading !== undefined &&
          parallelEntry.loading !== false;
        if (!shouldResolve) {
          component = null;
        } else if (hasLoadingFallback) {
          const result =
            typeof handler === "function" ? handler(context) : handler;
          if (result instanceof Promise) {
            const tracked = deps.trackHandler(result, {
              segmentId: parallelId,
              segmentType: "parallel",
            });
            observeStreamedHandler(
              tracked,
              parallelId,
              "parallel",
              context.pathname,
              routeKey,
              params,
            );
            component = tracked as ReactNode;
          } else {
            component = result as ReactNode;
          }
        } else {
          component =
            typeof handler === "function" ? await handler(context) : handler;
        }
      }

      segments.push({
        id: parallelId,
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

    const loaderResult = await resolveLoadersWithRevalidation(
      parallelEntry,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      deps,
      actionContext,
      entry.shortCode,
      stale,
    );
    segments.push(...loaderResult.segments);
    matchedIds.push(...loaderResult.matchedIds);
  }

  return { segments, matchedIds };
}

/**
 * Resolve entry handler (layout, cache, or route) with revalidation.
 */
export async function resolveEntryHandlerWithRevalidation<TEnv>(
  entry: Exclude<EntryData, { type: "parallel" }>,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  belongsToRoute: boolean,
  clientSegmentIds: Set<string>,
  prevParams: Record<string, string>,
  request: Request,
  prevUrl: URL,
  nextUrl: URL,
  routeKey: string,
  deps: SegmentResolutionDeps<TEnv>,
  actionContext?: ActionContext,
  stale?: boolean,
): Promise<{ segment: ResolvedSegment; matchedId: string }> {
  const matchedId = entry.shortCode;

  const component = await revalidate(
    async () => {
      const hasSegment = clientSegmentIds.has(entry.shortCode);
      debugLog("segment.revalidate", "entry presence check", {
        segmentId: entry.shortCode,
        entryType: entry.type,
        clientHasSegment: hasSegment,
        belongsToRoute,
      });
      if (!hasSegment) {
        if (isTraceActive()) {
          const segType =
            entry.type === "cache"
              ? "layout"
              : (entry.type as "layout" | "route");
          pushRevalidationTraceEntry({
            segmentId: entry.shortCode,
            segmentType: segType,
            belongsToRoute,
            source: "segment-resolution",
            defaultShouldRevalidate: true,
            finalShouldRevalidate: true,
            reason: "new-segment",
          });
        }
        return true;
      }

      const dummySegment: ResolvedSegment = {
        id: entry.shortCode,
        namespace: entry.id,
        type:
          entry.type === "cache"
            ? "layout"
            : (entry.type as "layout" | "route"),
        index: 0,
        component: null as any,
        params,
        belongsToRoute,
        ...(entry.type === "layout" || entry.type === "cache"
          ? { layoutName: entry.id }
          : {}),
        ...(entry.mountPath ? { mountPath: entry.mountPath } : {}),
      };

      const shouldRevalidate = await evaluateRevalidation({
        segment: dummySegment,
        prevParams,
        getPrevSegment: null,
        request,
        prevUrl,
        nextUrl,
        revalidations: entry.revalidate.map((fn, i) => ({
          name: `revalidate${i}`,
          fn,
        })),
        routeKey,
        context,
        actionContext,
        stale,
        traceSource:
          entry.type === "route" ? "route-handler" : "layout-handler",
      });
      emitRevalidationDecision(
        entry.shortCode,
        context.pathname,
        routeKey,
        shouldRevalidate,
      );
      debugLog("segment.revalidate", "entry revalidation decision", {
        segmentId: entry.shortCode,
        shouldRevalidate,
      });
      return shouldRevalidate;
    },
    async () => {
      const doneHandler = track(`handler:${entry.id}`, 2);
      (context as InternalHandlerContext<any, TEnv>)._currentSegmentId =
        entry.shortCode;
      if (entry.type === "layout" || entry.type === "cache") {
        const layoutComponent = await resolveLayoutComponent(entry, context);
        doneHandler();
        return layoutComponent;
      }
      const staticComponent = await tryStaticHandler(entry, entry.shortCode);
      if (staticComponent !== undefined) {
        doneHandler();
        return staticComponent;
      }
      const routeEntry = entry as Extract<EntryData, { type: "route" }>;
      if (!routeEntry.loading) {
        const result = handleHandlerResult(await routeEntry.handler(context));
        doneHandler();
        return result;
      }
      if (!actionContext) {
        const result = handleHandlerResult(routeEntry.handler(context));
        if (result instanceof Promise) {
          result.finally(doneHandler).catch(() => {});
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
          return { content: tracked };
        }
        doneHandler();
        return { content: result };
      }
      debugLog("segment.action", "resolving action route with awaited value", {
        entryId: entry.id,
      });
      const actionResult = handleHandlerResult(
        await routeEntry.handler(context),
      );
      doneHandler();
      return {
        content: Promise.resolve(actionResult),
      };
    },
    () => null,
  );

  const resolvedComponent =
    component && typeof component === "object" && "content" in component
      ? (component as { content: ReactNode }).content
      : component;

  const segment: ResolvedSegment = {
    id: entry.shortCode,
    namespace: entry.id,
    type:
      entry.type === "cache" ? "layout" : (entry.type as "layout" | "route"),
    index: 0,
    component: resolvedComponent,
    loading: entry.loading === false ? null : entry.loading,
    transition: entry.transition,
    params,
    belongsToRoute,
    ...(entry.type === "layout" || entry.type === "cache"
      ? { layoutName: entry.id }
      : {}),
    ...(entry.mountPath ? { mountPath: entry.mountPath } : {}),
  };

  return { segment, matchedId };
}

/**
 * Resolve segments with revalidation awareness (for partial rendering).
 */
export async function resolveSegmentWithRevalidation<TEnv>(
  entry: Exclude<EntryData, { type: "parallel" }>,
  routeKey: string,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  clientSegmentIds: Set<string>,
  prevParams: Record<string, string>,
  request: Request,
  prevUrl: URL,
  nextUrl: URL,
  loaderPromises: Map<string, Promise<any>>,
  deps: SegmentResolutionDeps<TEnv>,
  actionContext?: ActionContext,
  stale?: boolean,
): Promise<SegmentRevalidationResult> {
  const segments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];

  const belongsToRoute = entry.type === "route";

  const loaderResult = await resolveLoadersWithRevalidation(
    entry,
    context,
    belongsToRoute,
    clientSegmentIds,
    prevParams,
    request,
    prevUrl,
    nextUrl,
    routeKey,
    deps,
    actionContext,
    undefined,
    stale,
  );
  segments.push(...loaderResult.segments);
  matchedIds.push(...loaderResult.matchedIds);

  // For route entries, execute the handler BEFORE orphan layouts and parallels
  // so ctx.set() data is available to them via ctx.get(). The handler's
  // segment is pushed after children to preserve tree composition order.
  let routeHandlerResult:
    | { segment: ResolvedSegment; matchedId: string }
    | undefined;
  if (entry.type === "route") {
    routeHandlerResult = await resolveEntryHandlerWithRevalidation(
      entry,
      params,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      deps,
      actionContext,
      stale,
    );

    for (const orphan of entry.layout) {
      const orphanResult = await resolveOrphanLayoutWithRevalidation(
        orphan,
        params,
        context,
        clientSegmentIds,
        prevParams,
        request,
        prevUrl,
        nextUrl,
        routeKey,
        loaderPromises,
        true,
        deps,
        actionContext,
        stale,
      );
      segments.push(...orphanResult.segments);
      matchedIds.push(...orphanResult.matchedIds);
    }
  }

  if (routeHandlerResult) {
    // Route entry: handler already executed above; resolve parallels
    // (handler data visible) then push handler segment last for tree order.
    const parallelResult = await resolveParallelSegmentsWithRevalidation(
      entry,
      params,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      deps,
      actionContext,
      stale,
    );
    segments.push(...parallelResult.segments);
    matchedIds.push(...parallelResult.matchedIds);

    segments.push(routeHandlerResult.segment);
    matchedIds.push(routeHandlerResult.matchedId);
  } else {
    // Layout/cache entry: handler-first — resolve handler before parallels
    // so ctx.set() values are visible to parallel children.
    const handlerResult = await resolveEntryHandlerWithRevalidation(
      entry,
      params,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      deps,
      actionContext,
      stale,
    );
    segments.push(handlerResult.segment);
    matchedIds.push(handlerResult.matchedId);

    const parallelResult = await resolveParallelSegmentsWithRevalidation(
      entry,
      params,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      deps,
      actionContext,
      stale,
    );
    segments.push(...parallelResult.segments);
    matchedIds.push(...parallelResult.matchedIds);

    for (const orphan of entry.layout) {
      const orphanResult = await resolveOrphanLayoutWithRevalidation(
        orphan,
        params,
        context,
        clientSegmentIds,
        prevParams,
        request,
        prevUrl,
        nextUrl,
        routeKey,
        loaderPromises,
        false,
        deps,
        actionContext,
        stale,
      );
      segments.push(...orphanResult.segments);
      matchedIds.push(...orphanResult.matchedIds);
    }
  }

  return { segments, matchedIds };
}

/**
 * Resolve orphan layout with revalidation.
 */
export async function resolveOrphanLayoutWithRevalidation<TEnv>(
  orphan: EntryData,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  clientSegmentIds: Set<string>,
  prevParams: Record<string, string>,
  request: Request,
  prevUrl: URL,
  nextUrl: URL,
  routeKey: string,
  loaderPromises: Map<string, Promise<any>>,
  belongsToRoute: boolean,
  deps: SegmentResolutionDeps<TEnv>,
  actionContext?: ActionContext,
  stale?: boolean,
): Promise<SegmentRevalidationResult> {
  invariant(
    orphan.type === "layout" || orphan.type === "cache",
    `Expected orphan to be a layout or cache, got: ${orphan.type}`,
  );

  const segments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];

  const loaderResult = await resolveLoadersWithRevalidation(
    orphan,
    context,
    belongsToRoute,
    clientSegmentIds,
    prevParams,
    request,
    prevUrl,
    nextUrl,
    routeKey,
    deps,
    actionContext,
    undefined,
    stale,
  );
  segments.push(...loaderResult.segments);
  matchedIds.push(...loaderResult.matchedIds);

  // Handler-first: resolve orphan layout handler before its parallels
  // so ctx.set() values are visible to parallel children.
  matchedIds.push(orphan.shortCode);

  const component = await revalidate(
    async () => {
      if (!clientSegmentIds.has(orphan.shortCode)) {
        if (isTraceActive()) {
          pushRevalidationTraceEntry({
            segmentId: orphan.shortCode,
            segmentType: "layout",
            belongsToRoute,
            source: "orphan-layout",
            defaultShouldRevalidate: true,
            finalShouldRevalidate: true,
            reason: "new-segment",
          });
        }
        return true;
      }

      const dummySegment: ResolvedSegment = {
        id: orphan.shortCode,
        namespace: orphan.id,
        type: "layout",
        index: 0,
        component: null as any,
        params,
        belongsToRoute,
        layoutName: orphan.id,
        ...(orphan.mountPath ? { mountPath: orphan.mountPath } : {}),
      };

      const shouldRevalidate = await evaluateRevalidation({
        segment: dummySegment,
        prevParams,
        getPrevSegment: null,
        request,
        prevUrl,
        nextUrl,
        revalidations: orphan.revalidate.map((fn, i) => ({
          name: `revalidate${i}`,
          fn,
        })),
        routeKey,
        context,
        actionContext,
        stale,
        traceSource: "orphan-layout",
      });
      emitRevalidationDecision(
        orphan.shortCode,
        context.pathname,
        routeKey,
        shouldRevalidate,
      );
      return shouldRevalidate;
    },
    async () => resolveLayoutComponent(orphan, context),
    () => null,
  );

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
    invariant(
      parallelEntry.type === "parallel",
      `Expected parallel entry, got: ${parallelEntry.type}`,
    );

    const loaderResult = await resolveLoadersWithRevalidation(
      parallelEntry,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      deps,
      actionContext,
      undefined,
      stale,
    );
    segments.push(...loaderResult.segments);
    matchedIds.push(...loaderResult.matchedIds);

    const slots = parallelEntry.handler as Record<
      `@${string}`,
      | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
      | ReactNode
    >;

    for (const [slot, handler] of Object.entries(slots)) {
      // Use orphan.shortCode (the parent layout) to match the SSR path
      // (resolveParallelEntry receives parentShortCode = orphan.shortCode).
      // Using parallelEntry.shortCode would generate IDs the client doesn't know about.
      const parallelId = `${orphan.shortCode}.${slot}`;
      matchedIds.push(parallelId);

      const shouldResolve = await (async () => {
        if (!clientSegmentIds.has(parallelId)) {
          if (isTraceActive()) {
            pushRevalidationTraceEntry({
              segmentId: parallelId,
              segmentType: "parallel",
              belongsToRoute,
              source: "parallel",
              defaultShouldRevalidate: true,
              finalShouldRevalidate: true,
              reason: "new-segment",
            });
          }
          return true;
        }

        const dummySegment: ResolvedSegment = {
          id: parallelId,
          namespace: parallelEntry.id,
          type: "parallel",
          index: 0,
          component: null as any,
          params,
          slot,
          belongsToRoute,
          parallelName: `${parallelEntry.id}.${slot}`,
          ...(parallelEntry.mountPath
            ? { mountPath: parallelEntry.mountPath }
            : {}),
        };

        return await evaluateRevalidation({
          segment: dummySegment,
          prevParams,
          getPrevSegment: null,
          request,
          prevUrl,
          nextUrl,
          revalidations: parallelEntry.revalidate.map((fn, i) => ({
            name: `revalidate${i}`,
            fn,
          })),
          routeKey,
          context,
          actionContext,
          stale,
          traceSource: "parallel",
        });
      })();
      emitRevalidationDecision(
        parallelId,
        context.pathname,
        routeKey,
        shouldResolve,
      );

      let component: ReactNode | undefined;
      if (shouldResolve) {
        component = await tryStaticSlot(parallelEntry, slot, parallelId);
      }
      if (component === undefined) {
        const hasLoadingFallback =
          parallelEntry.loading !== undefined &&
          parallelEntry.loading !== false;
        if (!shouldResolve) {
          component = null;
        } else if (hasLoadingFallback) {
          const result =
            typeof handler === "function" ? handler(context) : handler;
          if (result instanceof Promise) {
            const tracked = deps.trackHandler(result, {
              segmentId: parallelId,
              segmentType: "parallel",
            });
            observeStreamedHandler(
              tracked,
              parallelId,
              "parallel",
              context.pathname,
              routeKey,
              params,
            );
            component = tracked as ReactNode;
          } else {
            component = result as ReactNode;
          }
        } else {
          component =
            typeof handler === "function" ? await handler(context) : handler;
        }
      }

      segments.push({
        id: parallelId,
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
  }

  return { segments, matchedIds };
}

/**
 * Resolve all segments for a route with revalidation logic (for matchPartial).
 */
export async function resolveAllSegmentsWithRevalidation<TEnv>(
  entries: EntryData[],
  routeKey: string,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  clientSegmentSet: Set<string>,
  prevParams: Record<string, string>,
  request: Request,
  prevUrl: URL,
  nextUrl: URL,
  loaderPromises: Map<string, Promise<any>>,
  actionContext: ActionContext | undefined,
  interceptResult: { intercept: any; entry: EntryData } | null,
  localRouteName: string,
  pathname: string,
  deps: SegmentResolutionDeps<TEnv>,
  stale?: boolean,
): Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }> {
  const allSegments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];
  const seenSegIds = new Set<string>();
  const seenMatchIds = new Set<string>();

  const telemetry = getRouterContext()?.telemetry;

  for (const entry of entries) {
    if (entry.type === "route" && interceptResult) {
      debugLog(
        "matchPartial.intercept",
        "skipping route handler during intercept",
        {
          localRouteName,
          segmentId: entry.shortCode,
        },
      );
      if (!seenMatchIds.has(entry.shortCode)) {
        seenMatchIds.add(entry.shortCode);
        matchedIds.push(entry.shortCode);
      }
      continue;
    }

    const nonParallelEntry = entry as Exclude<EntryData, { type: "parallel" }>;
    const doneEntry = track(`segment:${entry.id}`, 1);
    const resolved = await resolveWithErrorBoundary(
      nonParallelEntry,
      params,
      () =>
        resolveSegmentWithRevalidation(
          nonParallelEntry,
          routeKey,
          params,
          context,
          clientSegmentSet,
          prevParams,
          request,
          prevUrl,
          nextUrl,
          loaderPromises,
          deps,
          actionContext,
          stale,
        ),
      (seg) => ({ segments: [seg], matchedIds: [seg.id] }),
      deps,
      { request, url: context.url, routeKey, isPartial: true, telemetry },
      pathname,
    );
    doneEntry();

    // Deduplicate segments and matchedIds by ID, matching resolveAllSegments.
    // include() scopes can produce entries that resolve the same shared
    // layout/loader segment. Duplicates cause React tree depth changes.
    for (const seg of resolved.segments) {
      if (!seenSegIds.has(seg.id)) {
        seenSegIds.add(seg.id);
        allSegments.push(seg);
      }
    }
    for (const id of resolved.matchedIds) {
      if (!seenMatchIds.has(id)) {
        seenMatchIds.add(id);
        matchedIds.push(id);
      }
    }
  }

  return { segments: allSegments, matchedIds };
}
