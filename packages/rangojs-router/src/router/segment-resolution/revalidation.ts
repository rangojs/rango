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
import {
  getParallelEntries,
  getParallelSlotEntries,
  type EntryData,
  type ParallelEntryData,
} from "../../server/context";
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
  warnOnStreamedResponse,
  tryStaticHandler,
  tryStaticSlot,
  resolveLayoutComponent,
  resolveWithErrorBoundary,
} from "./helpers.js";
import { applyViewTransitionDefault } from "./view-transition-default.js";
import { getRouterContext } from "../router-context.js";
import { resolveSink, safeEmit } from "../telemetry.js";
import { observeStreamedHandler } from "./streamed-handler-telemetry.js";
import {
  track,
  RangoContext,
  runInsideLoaderScope,
} from "../../server/context.js";

/**
 * Trace a parallel slot that's being force-rendered on a full refetch (client
 * has no cached state). User revalidate fns are bypassed in this case — see
 * the call sites for the load-bearing rationale.
 */
function traceFullRefetchedParallelSlot(
  parallelId: string,
  belongsToRoute: boolean,
): void {
  if (!isTraceActive()) return;
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
        runInsideLoaderScope(() =>
          resolveLoaderData(loaderEntry, ctx, ctx.pathname),
        ),
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
  const seenIds = new Set<string>();

  async function collectEntryLoaders(
    entry: EntryData,
    belongsToRoute: boolean,
    shortCodeOverride?: string,
  ): Promise<void> {
    // Skip if all loaders from this entry have already been resolved
    // via a parent (e.g., cache boundary wrapping a layout with shared loaders).
    const loaderEntries = entry.loader ?? [];
    const sc = shortCodeOverride ?? entry.shortCode;
    const allAlreadySeen =
      loaderEntries.length > 0 &&
      loaderEntries.every((le, i) =>
        seenIds.has(`${sc}D${i}.${le.loader.$$id}`),
      );
    if (!allAlreadySeen) {
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
      for (const seg of segments) {
        if (!seenIds.has(seg.id)) {
          seenIds.add(seg.id);
          allLoaderSegments.push(seg);
        }
      }
      allMatchedIds.push(...matchedIds);
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
        const inherited = await resolveLoadersWithRevalidation(
          entry,
          context,
          childBelongsToRoute,
          clientSegmentIds,
          prevParams,
          request,
          prevUrl,
          nextUrl,
          routeKey,
          deps,
          actionContext,
          layoutEntry.shortCode,
          stale,
        );
        for (const seg of inherited.segments) {
          if (!seenIds.has(seg.id)) {
            seenIds.add(seg.id);
            seg._inherited = true;
            allLoaderSegments.push(seg);
          }
        }
        allMatchedIds.push(...inherited.matchedIds);
      }
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
      for (const { slot, entry: parallelEntry } of getParallelSlotEntries(
        entry.parallel,
      )) {
        const parallelParentShortCode = parentShortCode ?? entry.shortCode;
        const parallelId = `${parallelParentShortCode}.${slot}`;
        map.set(parallelId, {
          entry: parallelEntry,
          revalidate: parallelEntry.revalidate,
        });
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
 * Resolve the component for a single parallel slot on the revalidation path.
 * Pure component resolution shared verbatim by
 * resolveParallelSegmentsWithRevalidation and the orphan-inlined loop in
 * resolveOrphanLayoutWithRevalidation: try the static slot cache, else run the
 * slot handler (pinning _currentSegmentId to the slot id so handle pushes land
 * in the slot's own bucket, and wrapping a streamed handler). Returns the
 * resolved component and whether the handler actually ran. Does NOT touch the
 * revalidate-default policy (the caller decides shouldResolve, including the
 * orphan-vs-main defaultOverride divergence) or loader-resolution ordering.
 */
async function resolveParallelSlotComponent<TEnv>(args: {
  shouldResolve: boolean;
  parallelEntry: ParallelEntryData;
  slot: string;
  parallelId: string;
  handler:
    | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
    | ReactNode
    | undefined;
  context: HandlerContext<any, TEnv>;
  deps: SegmentResolutionDeps<TEnv>;
  routeKey: string;
  params: Record<string, string>;
}): Promise<{ component: ReactNode | undefined; handlerRan: boolean }> {
  const {
    shouldResolve,
    parallelEntry,
    slot,
    parallelId,
    handler,
    context,
    deps,
    routeKey,
    params,
  } = args;

  let component: ReactNode | undefined;
  let handlerRan = false;
  if (shouldResolve) {
    component = await tryStaticSlot(parallelEntry, slot, parallelId);
    // tryStaticSlot returning a value means the static cache supplied the
    // component — handler did NOT run. handlerRan stays false.
  }
  if (component === undefined) {
    const hasLoadingFallback =
      parallelEntry.loading !== undefined && parallelEntry.loading !== false;
    if (!shouldResolve) {
      component = null;
    } else if (handler === undefined) {
      // Handler evicted (production static slot) but static lookup missed.
      // Nothing to render — use null so the client keeps its cached version.
      component = null;
    } else {
      // Slot-keyed pushes — slot owns its own bucket, parent layout owns its
      // own. On slot-only revalidations the partial merge updates only the
      // slot's bucket; the parent's bucket stays intact.
      (context as InternalHandlerContext<any, TEnv>)._currentSegmentId =
        parallelId;
      handlerRan = true;
      if (hasLoadingFallback) {
        const result =
          typeof handler === "function" ? handler(context) : handler;
        if (result instanceof Promise) {
          warnOnStreamedResponse(result, parallelId);
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
  }

  return { component, handlerRan };
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

  const resolvedParallelEntries = new Set<string>();
  for (const { slot, entry: parallelEntry } of getParallelSlotEntries(
    entry.parallel,
  )) {
    invariant(
      parallelEntry.type === "parallel",
      `Expected parallel entry, got: ${parallelEntry.type}`,
    );

    const slots = parallelEntry.handler as Record<
      `@${string}`,
      | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
      | ReactNode
    >;
    // In production, static handler bodies are evicted and the slot value
    // may be undefined. The static store holds the pre-rendered component.
    // We defer the handler check until after tryStaticSlot.
    const handler = slots[slot];

    const parallelId = `${entry.shortCode}.${slot}`;

    const isFullRefetch = clientSegmentIds.size === 0;
    const isNewParent = !clientSegmentIds.has(entry.shortCode);
    // Always announce the slot in matchedIds — it's unconditionally appended
    // to `segments` below, and a segment present in segments but missing from
    // matched lets the client prune it (then it's missing from clientSegmentIds
    // on the next request, perpetuating the staleness).
    matchedIds.push(parallelId);

    let shouldResolve: boolean;
    if (isFullRefetch) {
      // Client has nothing cached — slot MUST render. User revalidate fns are
      // bypassed here because returning false would leave the segment blank
      // with no client-side fallback.
      traceFullRefetchedParallelSlot(parallelId, belongsToRoute);
      shouldResolve = true;
    } else {
      // For non-empty client sets, consult user revalidate fns. When the slot
      // is unknown to the client, override the type-derived default so the
      // soft chain seeds with the right "new segment" / "parent-chain" value.
      let defaultOverride: { value: boolean; reason: string } | undefined;
      if (!clientSegmentIds.has(parallelId)) {
        const value = belongsToRoute || isNewParent;
        defaultOverride = {
          value,
          reason: value ? "new-segment" : "skip-parent-chain",
        };
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

      shouldResolve = await evaluateRevalidation({
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
        defaultOverride,
      });
    }
    emitRevalidationDecision(
      parallelId,
      context.pathname,
      routeKey,
      shouldResolve,
    );

    const { component, handlerRan } = await resolveParallelSlotComponent({
      shouldResolve,
      parallelEntry,
      slot,
      parallelId,
      handler,
      context,
      deps,
      routeKey,
      params,
    });

    segments.push({
      id: parallelId,
      namespace: parallelEntry.id,
      type: "parallel",
      index: 0,
      component,
      loading: parallelEntry.loading === false ? null : parallelEntry.loading,
      transition: applyViewTransitionDefault(
        parallelEntry.transition,
        deps.viewTransitionDefault,
      ),
      params,
      slot,
      _handlerRan: handlerRan,
      belongsToRoute,
      parallelName: `${parallelEntry.id}.${slot}`,
      ...(parallelEntry.mountPath
        ? { mountPath: parallelEntry.mountPath }
        : {}),
    });

    if (resolvedParallelEntries.has(parallelEntry.id)) {
      continue;
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
    resolvedParallelEntries.add(parallelEntry.id);
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

  let handlerRan = false;
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
      handlerRan = true;
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
      // For Passthrough routes at runtime, use the live handler instead of
      // the build handler. At build time (context.build === true), always
      // use the build handler from routeEntry.handler.
      const handler =
        !context.build && routeEntry.liveHandler
          ? routeEntry.liveHandler
          : routeEntry.handler;
      if (!routeEntry.loading) {
        const result = handleHandlerResult(await handler(context));
        doneHandler();
        return result;
      }
      if (!actionContext) {
        const result = handleHandlerResult(handler(context));
        if (result instanceof Promise) {
          warnOnStreamedResponse(result, routeEntry.id);
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
      const actionResult = handleHandlerResult(await handler(context));
      doneHandler();
      return {
        content: Promise.resolve(actionResult),
      };
    },
    () => null,
  );

  // Normalize void handlers (undefined) to null so the reconciler's
  // component === null checks work consistently for both void and explicit null.
  const resolvedComponent =
    component && typeof component === "object" && "content" in component
      ? ((component as { content: ReactNode }).content ?? null)
      : (component ?? null);

  const segment: ResolvedSegment = {
    id: entry.shortCode,
    namespace: entry.id,
    type:
      entry.type === "cache" ? "layout" : (entry.type as "layout" | "route"),
    index: 0,
    component: resolvedComponent,
    loading: entry.loading === false ? null : entry.loading,
    transition: applyViewTransitionDefault(
      entry.transition,
      deps.viewTransitionDefault,
    ),
    params,
    belongsToRoute,
    ...(entry.type === "layout" || entry.type === "cache"
      ? { layoutName: entry.id }
      : {}),
    ...(entry.mountPath ? { mountPath: entry.mountPath } : {}),
    _handlerRan: handlerRan,
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
        true,
        deps,
        actionContext,
        stale,
        entry,
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
  belongsToRoute: boolean,
  deps: SegmentResolutionDeps<TEnv>,
  actionContext?: ActionContext,
  stale?: boolean,
  /** Parent route entry — its loaders are inherited so parallel slots can access them. */
  parentRouteEntry?: EntryData,
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

  // Inherit parent route's loaders so parallel slots inside this layout
  // can access them via useLoader(). See resolveOrphanLayout in fresh.ts.
  if (
    parentRouteEntry &&
    parentRouteEntry.loader &&
    parentRouteEntry.loader.length > 0 &&
    Object.keys(orphan.parallel).length > 0
  ) {
    const inheritedResult = await resolveLoadersWithRevalidation(
      parentRouteEntry,
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
      orphan.shortCode,
      stale,
    );
    // Tag as inherited so buildMatchResult can deduplicate when safe
    for (const s of inheritedResult.segments) {
      s._inherited = true;
    }
    segments.push(...inheritedResult.segments);
    matchedIds.push(...inheritedResult.matchedIds);
  }

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
    transition: applyViewTransitionDefault(
      orphan.transition,
      deps.viewTransitionDefault,
    ),
    ...(orphan.mountPath ? { mountPath: orphan.mountPath } : {}),
  });

  const resolvedParallelEntries = new Set<string>();
  for (const { slot, entry: parallelEntry } of getParallelSlotEntries(
    orphan.parallel,
  )) {
    invariant(
      parallelEntry.type === "parallel",
      `Expected parallel entry, got: ${parallelEntry.type}`,
    );

    if (!resolvedParallelEntries.has(parallelEntry.id)) {
      // shortCodeOverride must match the parent layout, not the parallel entry.
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
        orphan.shortCode,
        stale,
      );
      segments.push(...loaderResult.segments);
      matchedIds.push(...loaderResult.matchedIds);
      resolvedParallelEntries.add(parallelEntry.id);
    }

    const slots = parallelEntry.handler as Record<
      `@${string}`,
      | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
      | ReactNode
    >;
    // Handler may be undefined in production after static handler eviction.
    const handler = slots[slot];

    // Use orphan.shortCode (the parent layout) to match the SSR path
    // (resolveParallelEntry receives parentShortCode = orphan.shortCode).
    // Using parallelEntry.shortCode would generate IDs the client doesn't know about.
    const parallelId = `${orphan.shortCode}.${slot}`;
    matchedIds.push(parallelId);

    const isFullRefetch = clientSegmentIds.size === 0;
    let shouldResolve: boolean;
    if (isFullRefetch) {
      // Same load-bearing rationale as the main parallel path: full refetch
      // means the client has nothing to fall back to, so the slot must render.
      traceFullRefetchedParallelSlot(parallelId, belongsToRoute);
      shouldResolve = true;
    } else {
      // When slot is unknown to the client, seed the soft chain with `true`
      // (orphan parallels always belong to the route — we want them rendered
      // unless the user explicitly opts out via revalidate()).
      const defaultOverride = clientSegmentIds.has(parallelId)
        ? undefined
        : { value: true, reason: "new-segment" };

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

      shouldResolve = await evaluateRevalidation({
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
        defaultOverride,
      });
    }
    emitRevalidationDecision(
      parallelId,
      context.pathname,
      routeKey,
      shouldResolve,
    );

    const { component, handlerRan } = await resolveParallelSlotComponent({
      shouldResolve,
      parallelEntry,
      slot,
      parallelId,
      handler,
      context,
      deps,
      routeKey,
      params,
    });

    segments.push({
      id: parallelId,
      namespace: parallelEntry.id,
      type: "parallel",
      index: 0,
      component,
      loading: parallelEntry.loading === false ? null : parallelEntry.loading,
      transition: applyViewTransitionDefault(
        parallelEntry.transition,
        deps.viewTransitionDefault,
      ),
      params,
      slot,
      _handlerRan: handlerRan,
      belongsToRoute,
      parallelName: `${parallelEntry.id}.${slot}`,
      ...(parallelEntry.mountPath
        ? { mountPath: parallelEntry.mountPath }
        : {}),
    });
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
    if (entry.type === "cache") {
      const store = RangoContext.getStore();
      if (store) store.insideCacheScope = true;
    }
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
