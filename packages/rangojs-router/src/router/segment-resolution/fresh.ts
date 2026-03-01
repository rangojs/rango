/**
 * Fresh Path Segment Resolution
 *
 * Functions for resolving segments during a full (non-revalidation) request.
 * Handles loaders, layouts, routes, parallels, orphan layouts, and error boundaries.
 */

import type { ReactNode } from "react";
import { DataNotFoundError, invariant } from "../../errors";
import {
  createErrorInfo,
  createErrorSegment,
  createNotFoundInfo,
  createNotFoundSegment,
} from "../error-handling.js";
import { getRequestContext } from "../../server/request-context.js";
import { DefaultErrorFallback } from "../../default-error-boundary.js";
import type { EntryData } from "../../server/context";
import type {
  HandlerContext,
  InternalHandlerContext,
  ResolvedSegment,
  ErrorInfo,
} from "../../types";
import type { SegmentResolutionDeps } from "../types.js";
import { debugLog } from "../logging.js";
import { tryStaticLookup } from "./static-store.js";
import { resolveLoaderData } from "./loader-cache.js";

/**
 * Handle Response returns from handlers.
 * When a handler returns a Response (e.g., redirect), throw it to trigger
 * the short-circuit mechanism. Otherwise return the ReactNode.
 */
export function handleHandlerResult(
  result: ReactNode | Response | Promise<ReactNode> | Promise<Response>,
): ReactNode {
  if (result instanceof Response) {
    throw result;
  }
  if (result instanceof Promise) {
    return result.then((resolved) => {
      if (resolved instanceof Response) {
        throw resolved;
      }
      return resolved;
    }) as ReactNode;
  }
  return result;
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

    for (const parallelEntry of entry.parallel) {
      const parallelSegments = await resolveParallelEntry(
        parallelEntry,
        params,
        context,
        false,
        entry.shortCode,
        deps,
        options,
      );
      segments.push(...parallelSegments);
    }

    (context as InternalHandlerContext<any, TEnv>)._currentSegmentId =
      entry.shortCode;

    // Static handler interception: use pre-rendered component from build-time store.
    // Cast via any because the cache entry type in the union lacks isStaticPrerender.
    const entryAny = entry as any;
    let component: ReactNode | undefined;
    if (entryAny.isStaticPrerender && entryAny.staticHandlerId) {
      component = await tryStaticLookup(
        entryAny.staticHandlerId,
        entry.shortCode,
      );
    }
    if (component === undefined) {
      component =
        typeof entry.handler === "function"
          ? handleHandlerResult(await entry.handler(context))
          : entry.handler;
    }

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

    for (const orphan of entry.layout) {
      const orphanSegments = await resolveOrphanLayout(
        orphan,
        params,
        context,
        loaderPromises,
        false,
        deps,
        options,
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
    let component: ReactNode | undefined;

    // Static handler interception: use pre-rendered component from build-time store
    if (entry.isStaticPrerender && (entry as any).staticHandlerId) {
      component = await tryStaticLookup(
        (entry as any).staticHandlerId,
        entry.shortCode,
      );
    }
    if (component === undefined) {
      if (entry.loading) {
        const result = handleHandlerResult(entry.handler(context));
        component =
          result instanceof Promise ? deps.trackHandler(result) : result;
      } else {
        component = handleHandlerResult(await entry.handler(context));
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

  for (const parallelEntry of orphan.parallel) {
    const parallelSegments = await resolveParallelEntry(
      parallelEntry,
      params,
      context,
      belongsToRoute,
      orphan.shortCode,
      deps,
      options,
    );
    segments.push(...parallelSegments);
  }

  // Static handler interception for orphan layouts
  const orphanAny = orphan as any;
  let component: ReactNode | undefined;
  if (orphanAny.isStaticPrerender && orphanAny.staticHandlerId) {
    component = await tryStaticLookup(
      orphanAny.staticHandlerId,
      orphan.shortCode,
    );
  }
  if (component === undefined) {
    component =
      typeof orphan.handler === "function"
        ? handleHandlerResult(await orphan.handler(context))
        : orphan.handler;
  }

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
    let component: ReactNode | undefined;

    // Static handler interception for individual parallel slots
    const slotStaticId = (parallelEntry as any).staticHandlerIds?.[slot];
    if (slotStaticId) {
      component = await tryStaticLookup(
        slotStaticId,
        `${parentShortCode}.${slot}`,
      );
    }

    if (component === undefined) {
      const hasLoadingFallback =
        parallelEntry.loading !== undefined && parallelEntry.loading !== false;
      if (hasLoadingFallback) {
        const result =
          typeof handler === "function" ? handler(context) : handler;
        component = result as ReactNode;
      } else {
        component =
          typeof handler === "function" ? await handler(context) : handler;
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
 * Wrapper that adds error boundary handling to segment resolution.
 */
export async function resolveWithErrorHandling<TEnv>(
  entry: EntryData,
  routeKey: string,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  loaderPromises: Map<string, Promise<any>>,
  resolveFn: () => Promise<ResolvedSegment[]>,
  deps: SegmentResolutionDeps<TEnv>,
  errorContext?: {
    env?: TEnv;
    isPartial?: boolean;
    requestStartTime?: number;
  },
): Promise<ResolvedSegment[]> {
  try {
    return await resolveFn();
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    if (error instanceof DataNotFoundError) {
      const notFoundFallback = deps.findNearestNotFoundBoundary(entry);

      if (notFoundFallback) {
        const notFoundInfo = createNotFoundInfo(
          error,
          entry.shortCode,
          entry.type,
          context.pathname,
        );

        // Safe request access: during build-time prerendering, context.request
        // is a throwing getter. Use undefined when unavailable.
        let safeRequest: Request | undefined;
        try {
          safeRequest = context.request;
        } catch {}

        deps.callOnError(error, "handler", {
          request: safeRequest as Request,
          url: context.url,
          routeKey,
          params,
          segmentId: entry.shortCode,
          segmentType: entry.type as any,
          env: errorContext?.env,
          isPartial: errorContext?.isPartial,
          handledByBoundary: true,
          metadata: { notFound: true, message: notFoundInfo.message },
          requestStartTime: errorContext?.requestStartTime,
        });

        debugLog("segment", "notFound boundary handled error", {
          segmentId: entry.shortCode,
          message: notFoundInfo.message,
        });

        const reqCtx = getRequestContext();
        if (reqCtx) {
          reqCtx.res = new Response(null, {
            status: 404,
            headers: reqCtx.res.headers,
          });
        }

        const notFoundSegment = createNotFoundSegment(
          notFoundInfo,
          notFoundFallback,
          entry,
          params,
        );
        return [notFoundSegment];
      }
    }

    const fallback = deps.findNearestErrorBoundary(entry);
    const segmentType: ErrorInfo["segmentType"] = entry.type;
    const errorInfo = createErrorInfo(error, entry.shortCode, segmentType);
    const effectiveFallback = fallback ?? DefaultErrorFallback;

    // Safe request access: during build-time prerendering, context.request
    // is a throwing getter. Use undefined when unavailable.
    let safeReq: Request | undefined;
    try {
      safeReq = context.request;
    } catch {}

    deps.callOnError(error, "handler", {
      request: safeReq as Request,
      url: context.url,
      routeKey,
      params,
      segmentId: entry.shortCode,
      segmentType: entry.type as any,
      env: errorContext?.env,
      isPartial: errorContext?.isPartial,
      handledByBoundary: !!fallback,
      requestStartTime: errorContext?.requestStartTime,
    });

    debugLog("segment", "error boundary handled error", {
      segmentId: entry.shortCode,
      boundary: fallback ? "custom" : "default",
      message: errorInfo.message,
    });

    {
      const reqCtx = getRequestContext();
      if (reqCtx) {
        reqCtx.res = new Response(null, {
          status: 500,
          headers: reqCtx.res.headers,
        });
      }
    }

    const errorSegment = createErrorSegment(
      errorInfo,
      effectiveFallback,
      entry,
      params,
    );
    return [errorSegment];
  }
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

  for (const entry of entries) {
    const resolvedSegments = await resolveWithErrorHandling(
      entry,
      routeKey,
      params,
      context,
      loaderPromises,
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
      deps,
    );
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
