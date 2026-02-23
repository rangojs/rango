/**
 * Segment Resolution
 *
 * Extracted from createRouter closure. Contains all segment resolution functions
 * for both fresh (full match) and revalidation (partial match) paths.
 *
 * Functions receive a `deps` parameter for closure-bound helpers from createRouter.
 */

import type { ReactNode } from "react";
import {
  DataNotFoundError,
  invariant,
} from "../errors";
import {
  createErrorInfo,
  createErrorSegment,
  createNotFoundInfo,
  createNotFoundSegment,
} from "./error-handling.js";
import {
  revalidate,
} from "./loader-resolution.js";
import { evaluateRevalidation } from "./revalidation.js";
import { getRequestContext } from "../server/request-context.js";
import { DefaultErrorFallback } from "../default-error-boundary.js";
import type { EntryData } from "../server/context";
import type {
  HandlerContext,
  InternalHandlerContext,
  ResolvedSegment,
  ErrorInfo,
  ShouldRevalidateFn,
} from "../types";
import type {
  SegmentResolutionDeps,
  SegmentRevalidationResult,
  ActionContext,
} from "./types.js";
import { debugLog } from "./logging.js";
import type { StaticStore } from "../prerender/store.js";

// Lazy-initialized static store for production Static handler interception.
// Remains undefined until first check; null means checked but no manifest.
// When no __STATIC_MANIFEST exists (dev mode), set to null eagerly to avoid
// the dynamic import() in ensureStaticDeps() which disrupts AsyncLocalStorage
// in workerd/Cloudflare runtime.
let _staticStore: StaticStore | null | undefined =
  typeof globalThis !== "undefined" && globalThis.__STATIC_MANIFEST
    ? undefined
    : null;
let _deserializeComponent: ((encoded: string) => Promise<unknown>) | undefined;

async function ensureStaticDeps(): Promise<void> {
  if (_staticStore === undefined) {
    const { createStaticStore } = await import("../prerender/store.js");
    _staticStore = createStaticStore();
  }
  if (!_deserializeComponent && _staticStore) {
    const { deserializeComponent } = await import("../cache/segment-codec.js");
    _deserializeComponent = deserializeComponent;
  }
}

/**
 * Try to load a pre-rendered Static component from the build-time store.
 * Returns the deserialized React element, or undefined if not available.
 * Also replays any handle data captured at build time into the request's HandleStore.
 *
 * @param handlerId - The handler's $$id used to look up the static store entry.
 * @param segmentId - The runtime segment shortCode. Handle data is replayed under
 *   this key so that useHandle's segmentOrder matching works correctly.
 */
async function tryStaticLookup(handlerId: string, segmentId: string): Promise<ReactNode | undefined> {
  // Fast path: already checked and no manifest available (dev mode or no Static handlers).
  // Avoids await which can disrupt AsyncLocalStorage in workerd/Cloudflare runtime.
  if (_staticStore === null) return undefined;
  await ensureStaticDeps();
  if (!_staticStore || !_deserializeComponent) return undefined;
  const entry = await _staticStore.get(handlerId);
  if (!entry) return undefined;

  // Replay handle data captured during build-time rendering.
  // The data was keyed by handlerId at build time; replay under segmentId
  // so it matches the segment order used by useHandle on the client.
  if (entry.handles && Object.keys(entry.handles).length > 0) {
    const handleStore = getRequestContext()?._handleStore;
    if (handleStore) {
      handleStore.replaySegmentData(segmentId, entry.handles);
    }
  }

  return _deserializeComponent(entry.encoded) as Promise<ReactNode>;
}

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

  return Promise.all(
    loaderEntries.map(async ({ loader }, i) => {
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
          loadingDisabled ? await ctx.use(loader) : ctx.use(loader),
          entry,
          segmentId,
          ctx.pathname,
        ),
        belongsToRoute,
      };
    }),
  );
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
        parallelEntry, params, context, false, entry.shortCode, deps, options,
      );
      segments.push(...parallelSegments);
    }

    (context as InternalHandlerContext)._currentSegmentId = entry.shortCode;

    // Static handler interception: use pre-rendered component from build-time store.
    // Cast via any because the cache entry type in the union lacks isStaticPrerender.
    const entryAny = entry as any;
    let component: ReactNode | undefined;
    if (entryAny.isStaticPrerender && entryAny.staticHandlerId) {
      component = await tryStaticLookup(entryAny.staticHandlerId, entry.shortCode);
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
        orphan, params, context, loaderPromises, false, deps, options,
      );
      segments.push(...orphanSegments);
    }
  } else if (entry.type === "route") {
    if (!options?.skipLoaders) {
      const loaderSegments = await resolveLoaders(entry, context, true, deps);
      segments.push(...loaderSegments);
    }

    for (const orphan of entry.layout) {
      const orphanSegments = await resolveOrphanLayout(
        orphan, params, context, loaderPromises, true, deps, options,
      );
      segments.push(...orphanSegments);
    }

    for (const parallelEntry of entry.parallel) {
      const parallelSegments = await resolveParallelEntry(
        parallelEntry, params, context, true, entry.shortCode, deps, options,
      );
      segments.push(...parallelSegments);
    }

    (context as InternalHandlerContext)._currentSegmentId = entry.shortCode;
    let component: ReactNode | undefined;

    // Static handler interception: use pre-rendered component from build-time store
    if (entry.isStaticPrerender && (entry as any).staticHandlerId) {
      component = await tryStaticLookup((entry as any).staticHandlerId, entry.shortCode);
    }
    if (component === undefined) {
      if (entry.loading) {
        const result = handleHandlerResult(entry.handler(context));
        component = result instanceof Promise ? deps.trackHandler(result) : result;
      } else {
        component = handleHandlerResult(await entry.handler(context));
      }
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
    const loaderSegments = await resolveLoaders(orphan, context, belongsToRoute, deps);
    segments.push(...loaderSegments);
  }

  for (const parallelEntry of orphan.parallel) {
    const parallelSegments = await resolveParallelEntry(
      parallelEntry, params, context, belongsToRoute, orphan.shortCode, deps, options,
    );
    segments.push(...parallelSegments);
  }

  // Static handler interception for orphan layouts
  const orphanAny = orphan as any;
  let component: ReactNode | undefined;
  if (orphanAny.isStaticPrerender && orphanAny.staticHandlerId) {
    component = await tryStaticLookup(orphanAny.staticHandlerId, orphan.shortCode);
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
      component = await tryStaticLookup(slotStaticId, `${parentShortCode}.${slot}`);
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
      parallelEntry, context, belongsToRoute, deps, parentShortCode,
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
          error, entry.shortCode, entry.type, context.pathname,
        );

        deps.callOnError(error, "handler", {
          request: context.request,
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
          notFoundInfo, notFoundFallback, entry, params,
        );
        return [notFoundSegment];
      }
    }

    const fallback = deps.findNearestErrorBoundary(entry);
    const segmentType: ErrorInfo["segmentType"] = entry.type;
    const errorInfo = createErrorInfo(error, entry.shortCode, segmentType);
    const effectiveFallback = fallback ?? DefaultErrorFallback;

    deps.callOnError(error, "handler", {
      request: context.request,
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

    const errorSegment = createErrorSegment(errorInfo, effectiveFallback, entry, params);
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
      entry, routeKey, params, context, loaderPromises,
      () => resolveSegment(entry, routeKey, params, context, loaderPromises, deps, false, options),
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

  const loaderMeta = loaderEntries.map(
    ({ loader, revalidate: loaderRevalidateFns }, i) => ({
      loader,
      loaderRevalidateFns,
      segmentId: `${shortCode}D${i}.${loader.$$id}`,
      index: i,
    }),
  );

  const matchedIds = loaderMeta.map((m) => m.segmentId);

  const revalidationChecks = await Promise.all(
    loaderMeta.map(
      async ({ loader, loaderRevalidateFns, segmentId, index }) => {
        const shouldRun = await revalidate(
          async () => {
            if (!clientSegmentIds.has(segmentId)) return true;

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
            });
          },
          async () => true,
          () => false,
        );
        return { shouldRun, loader, segmentId, index };
      },
    ),
  );

  const loadersToRun = revalidationChecks.filter((c) => c.shouldRun);
  const segments: ResolvedSegment[] = loadersToRun.map(
    ({ loader, segmentId, index }) => ({
      id: segmentId,
      namespace: entry.id,
      type: "loader" as const,
      index,
      component: null,
      params: ctx.params,
      loaderId: loader.$$id,
      loaderData: deps.wrapLoaderPromise(
        ctx.use(loader),
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
): Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }> {
  const allLoaderSegments: ResolvedSegment[] = [];
  const allMatchedIds: string[] = [];

  for (const entry of entries) {
    const belongsToRoute = entry.type === "route";
    const { segments, matchedIds } = await resolveLoadersWithRevalidation(
      entry, context, belongsToRoute, clientSegmentIds,
      prevParams, request, prevUrl, nextUrl, routeKey, deps, actionContext,
    );
    allLoaderSegments.push(...segments);
    allMatchedIds.push(...matchedIds);
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
            const parallelId = `${parallelEntry.shortCode}.${slot}`;
            map.set(parallelId, {
              entry: parallelEntry,
              revalidate: parallelEntry.revalidate,
            });
          }
        }
      }
    }

    for (const layoutEntry of entry.layout) {
      processEntry(layoutEntry);
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
        if (isFullRefetch) return true;
        if (!clientSegmentIds.has(parallelId)) return belongsToRoute || isNewParent;

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
        });
      })();

      let component: ReactNode | undefined;
      // Static handler interception for individual parallel slots
      const slotStaticId = (parallelEntry as any).staticHandlerIds?.[slot];
      if (slotStaticId && shouldResolve) {
        component = await tryStaticLookup(slotStaticId, parallelId);
      }
      if (component === undefined) {
        const hasLoadingFallback =
          parallelEntry.loading !== undefined && parallelEntry.loading !== false;
        if (!shouldResolve) {
          component = null;
        } else if (hasLoadingFallback) {
          component =
            (typeof handler === "function"
              ? handler(context)
              : handler) as ReactNode;
        } else {
          component =
            typeof handler === "function"
              ? await handler(context)
              : handler;
        }
      }

      segments.push({
        id: parallelId,
        namespace: parallelEntry.id,
        type: "parallel",
        index: 0,
        component,
        loading:
          parallelEntry.loading === false ? null : parallelEntry.loading,
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

    if (!parallelEntry.loading) {
      const loaderResult = await resolveLoadersWithRevalidation(
        parallelEntry, context, belongsToRoute, clientSegmentIds,
        prevParams, request, prevUrl, nextUrl, routeKey, deps,
        actionContext, entry.shortCode, stale,
      );
      segments.push(...loaderResult.segments);
      matchedIds.push(...loaderResult.matchedIds);
    }
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
      if (!hasSegment) return true;

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
      });
      debugLog("segment.revalidate", "entry revalidation decision", {
        segmentId: entry.shortCode,
        shouldRevalidate,
      });
      return shouldRevalidate;
    },
    async () => {
      (context as InternalHandlerContext)._currentSegmentId = entry.shortCode;
      // Static handler interception: use pre-rendered component from build-time store
      const entryAny = entry as any;
      if (entryAny.isStaticPrerender && entryAny.staticHandlerId) {
        const staticComponent = await tryStaticLookup(entryAny.staticHandlerId, entry.shortCode);
        if (staticComponent !== undefined) return staticComponent;
      }
      if (entry.type === "layout" || entry.type === "cache") {
        return typeof entry.handler === "function"
          ? handleHandlerResult(await entry.handler(context))
          : entry.handler;
      }
      const routeEntry = entry as Extract<EntryData, { type: "route" }>;
      if (!routeEntry.loading) {
        return handleHandlerResult(await routeEntry.handler(context));
      }
      if (!actionContext) {
        const result = handleHandlerResult(routeEntry.handler(context));
        return {
          content: result instanceof Promise ? deps.trackHandler(result) : result,
        };
      }
      debugLog("segment.action", "resolving action route with awaited value", {
        entryId: entry.id,
      });
      return {
        content: Promise.resolve(
          handleHandlerResult(await routeEntry.handler(context)),
        ),
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
    entry, context, belongsToRoute, clientSegmentIds,
    prevParams, request, prevUrl, nextUrl, routeKey, deps,
    actionContext, undefined, stale,
  );
  segments.push(...loaderResult.segments);
  matchedIds.push(...loaderResult.matchedIds);

  if (entry.type === "route") {
    for (const orphan of entry.layout) {
      const orphanResult = await resolveOrphanLayoutWithRevalidation(
        orphan, params, context, clientSegmentIds,
        prevParams, request, prevUrl, nextUrl, routeKey,
        loaderPromises, true, deps, actionContext, stale,
      );
      segments.push(...orphanResult.segments);
      matchedIds.push(...orphanResult.matchedIds);
    }
  }

  const parallelResult = await resolveParallelSegmentsWithRevalidation(
    entry, params, context, belongsToRoute, clientSegmentIds,
    prevParams, request, prevUrl, nextUrl, routeKey, deps,
    actionContext, stale,
  );
  segments.push(...parallelResult.segments);
  matchedIds.push(...parallelResult.matchedIds);

  if (entry.type === "layout" || entry.type === "cache") {
    for (const orphan of entry.layout) {
      const orphanResult = await resolveOrphanLayoutWithRevalidation(
        orphan, params, context, clientSegmentIds,
        prevParams, request, prevUrl, nextUrl, routeKey,
        loaderPromises, false, deps, actionContext, stale,
      );
      segments.push(...orphanResult.segments);
      matchedIds.push(...orphanResult.matchedIds);
    }
  }

  const handlerResult = await resolveEntryHandlerWithRevalidation(
    entry, params, context, belongsToRoute, clientSegmentIds,
    prevParams, request, prevUrl, nextUrl, routeKey, deps,
    actionContext, stale,
  );
  segments.push(handlerResult.segment);
  matchedIds.push(handlerResult.matchedId);

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
    orphan, context, belongsToRoute, clientSegmentIds,
    prevParams, request, prevUrl, nextUrl, routeKey, deps,
    actionContext, undefined, stale,
  );
  segments.push(...loaderResult.segments);
  matchedIds.push(...loaderResult.matchedIds);

  for (const parallelEntry of orphan.parallel) {
    invariant(
      parallelEntry.type === "parallel",
      `Expected parallel entry, got: ${parallelEntry.type}`,
    );

    const loaderResult = await resolveLoadersWithRevalidation(
      parallelEntry, context, belongsToRoute, clientSegmentIds,
      prevParams, request, prevUrl, nextUrl, routeKey, deps,
      actionContext, undefined, stale,
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
        if (!clientSegmentIds.has(parallelId)) return true;

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
        });
      })();

      let component: ReactNode | undefined;
      // Static handler interception for individual parallel slots
      const slotStaticId = (parallelEntry as any).staticHandlerIds?.[slot];
      if (slotStaticId && shouldResolve) {
        component = await tryStaticLookup(slotStaticId, parallelId);
      }
      if (component === undefined) {
        const hasLoadingFallback =
          parallelEntry.loading !== undefined && parallelEntry.loading !== false;
        if (!shouldResolve) {
          component = null;
        } else if (hasLoadingFallback) {
          component =
            (typeof handler === "function"
              ? handler(context)
              : handler) as ReactNode;
        } else {
          component =
            typeof handler === "function"
              ? await handler(context)
              : handler;
        }
      }

      segments.push({
        id: parallelId,
        namespace: parallelEntry.id,
        type: "parallel",
        index: 0,
        component,
        loading:
          parallelEntry.loading === false ? null : parallelEntry.loading,
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

  matchedIds.push(orphan.shortCode);

  const component = await revalidate(
    async () => {
      if (!clientSegmentIds.has(orphan.shortCode)) return true;

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

      return await evaluateRevalidation({
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
      });
    },
    async () => {
      // Static handler interception for orphan layouts
      const orphanAny = orphan as any;
      if (orphanAny.isStaticPrerender && orphanAny.staticHandlerId) {
        const staticComponent = await tryStaticLookup(orphanAny.staticHandlerId, orphan.shortCode);
        if (staticComponent !== undefined) return staticComponent;
      }
      return typeof orphan.handler === "function"
        ? handleHandlerResult(await orphan.handler(context))
        : orphan.handler;
    },
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

  return { segments, matchedIds };
}

/**
 * Wrapper for segment resolution with revalidation that adds error boundary handling.
 */
export async function resolveWithRevalidationErrorHandling<TEnv>(
  entry: EntryData,
  params: Record<string, string>,
  resolveFn: () => Promise<SegmentRevalidationResult>,
  deps: SegmentResolutionDeps<TEnv>,
  pathname?: string,
  errorContext?: {
    request: Request;
    url: URL;
    routeKey?: string;
    env?: TEnv;
    isPartial?: boolean;
    requestStartTime?: number;
  },
): Promise<SegmentRevalidationResult> {
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
          error, entry.shortCode, entry.type, pathname,
        );

        if (errorContext) {
          deps.callOnError(error, "handler", {
            request: errorContext.request,
            url: errorContext.url,
            routeKey: errorContext.routeKey,
            params,
            segmentId: entry.shortCode,
            segmentType: entry.type as any,
            env: errorContext.env,
            isPartial: errorContext.isPartial,
            handledByBoundary: true,
            metadata: { notFound: true, message: notFoundInfo.message },
            requestStartTime: errorContext.requestStartTime,
          });
        }

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
          notFoundInfo, notFoundFallback, entry, params,
        );

        return {
          segments: [notFoundSegment],
          matchedIds: [notFoundSegment.id],
        };
      }
    }

    const fallback = deps.findNearestErrorBoundary(entry);
    const segmentType: ErrorInfo["segmentType"] = entry.type;
    const errorInfo = createErrorInfo(error, entry.shortCode, segmentType);
    const effectiveFallback = fallback ?? DefaultErrorFallback;

    if (errorContext) {
      deps.callOnError(error, "handler", {
        request: errorContext.request,
        url: errorContext.url,
        routeKey: errorContext.routeKey,
        params,
        segmentId: entry.shortCode,
        segmentType: entry.type as any,
        env: errorContext.env,
        isPartial: errorContext.isPartial,
        handledByBoundary: !!fallback,
        requestStartTime: errorContext.requestStartTime,
      });
    }

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

    const errorSegment = createErrorSegment(errorInfo, effectiveFallback, entry, params);

    return {
      segments: [errorSegment],
      matchedIds: [errorSegment.id],
    };
  }
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
): Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }> {
  const allSegments: ResolvedSegment[] = [];
  const matchedIds: string[] = [];
  const seenSegIds = new Set<string>();
  const seenMatchIds = new Set<string>();

  for (const entry of entries) {
    if (entry.type === "route" && interceptResult) {
      debugLog("matchPartial.intercept", "skipping route handler during intercept", {
        localRouteName,
        segmentId: entry.shortCode,
      });
      if (!seenMatchIds.has(entry.shortCode)) {
        seenMatchIds.add(entry.shortCode);
        matchedIds.push(entry.shortCode);
      }
      continue;
    }

    const nonParallelEntry = entry as Exclude<EntryData, { type: "parallel" }>;
    const resolved = await resolveWithRevalidationErrorHandling(
      nonParallelEntry,
      params,
      () =>
        resolveSegmentWithRevalidation(
          nonParallelEntry, routeKey, params, context, clientSegmentSet,
          prevParams, request, prevUrl, nextUrl, loaderPromises, deps,
          actionContext, false,
        ),
      deps,
      pathname,
    );

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
