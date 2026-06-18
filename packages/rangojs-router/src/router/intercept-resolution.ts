/**
 * Intercept Resolution
 *
 * Extracted from createRouter closure. Contains intercept detection and resolution
 * functions for soft navigation (modals).
 */

import type { ReactNode } from "react";
import type {
  EntryData,
  InterceptEntry,
  InterceptSelectorContext,
} from "../server/context";
import type {
  HandlerContext,
  InternalHandlerContext,
  ResolvedSegment,
} from "../types";
import { evaluateRevalidation } from "./revalidation.js";
import { getRequestContext } from "../server/request-context.js";
import { executeInterceptMiddleware } from "./middleware.js";
import { createReverseFunction } from "./handler-context.js";
import { getGlobalRouteMap } from "../route-map-builder.js";
import {
  handleHandlerResult,
  warnOnStreamedResponse,
} from "./segment-resolution.js";
import type { SegmentResolutionDeps } from "./types.js";
import { debugLog } from "./logging.js";
import { runInsideLoaderScope } from "../server/context.js";

/**
 * Check if an intercept's when conditions are satisfied.
 * All when() functions must return true for the intercept to activate.
 * If no when() conditions are defined, the intercept always activates.
 *
 * During action revalidation, when() is NOT evaluated.
 */
export function evaluateInterceptWhen(
  intercept: InterceptEntry,
  selectorContext: InterceptSelectorContext | null,
  isAction: boolean,
): boolean {
  if (isAction) {
    return true;
  }

  if (!intercept.when || intercept.when.length === 0) {
    return true;
  }

  if (!selectorContext) {
    return false;
  }

  return intercept.when.every((fn) => fn(selectorContext));
}

/**
 * Find an intercept for the target route by walking up the entry chain.
 * Returns the first (innermost) matching intercept along with the entry that defines it.
 */
export function findInterceptForRoute(
  targetRouteKey: string,
  fromEntry: EntryData | null,
  selectorContext: InterceptSelectorContext | null = null,
  isAction: boolean = false,
): { intercept: InterceptEntry; entry: EntryData } | null {
  let current: EntryData | null = fromEntry;

  while (current) {
    // current first, then its sibling layouts — same order as before.
    for (const source of [current, ...current.layout]) {
      for (const intercept of source.intercept) {
        if (
          intercept.routeName === targetRouteKey &&
          evaluateInterceptWhen(intercept, selectorContext, isAction)
        ) {
          return { intercept, entry: source };
        }
      }
    }

    current = current.parent;
  }

  return null;
}

/**
 * Resolve an intercept entry and emit segment with the slot name.
 */
export async function resolveInterceptEntry<TEnv>(
  interceptEntry: InterceptEntry,
  parentEntry: EntryData,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  belongsToRoute: boolean,
  deps: SegmentResolutionDeps<TEnv>,
  revalidationContext?: {
    clientSegmentIds: Set<string>;
    prevParams: Record<string, string>;
    request: Request;
    prevUrl: URL;
    nextUrl: URL;
    routeKey: string;
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    };
    stale?: boolean;
  },
  options?: {
    /**
     * Skip the intercept's middleware execution. Set ONLY by the post-response
     * background re-render paths (proactive caching, stale background
     * revalidation), whose sole purpose is to re-render the segment tree to
     * populate the cache. The foreground request already ran the intercept
     * middleware before the response was sent — it validated auth, set cookies,
     * and wrote context vars into the request context's shared `_variables`,
     * which the background render reuses. Re-running middleware here would fire
     * its side effects a SECOND time, and a middleware that short-circuits with
     * a Response would `throw` and silently abort the cache write. Never set on
     * the foreground path.
     */
    skipMiddleware?: boolean;
  },
): Promise<ResolvedSegment[]> {
  const segments: ResolvedSegment[] = [];

  if (!options?.skipMiddleware && interceptEntry.middleware.length > 0) {
    const requestCtx = getRequestContext();
    if (!requestCtx?.res) {
      throw new Error(
        "Request context with stubResponse is required for intercept middleware",
      );
    }
    const middlewareResponse = await executeInterceptMiddleware(
      interceptEntry.middleware,
      context.request,
      context.env,
      params,
      (context as InternalHandlerContext<any, TEnv>)._variables,
      requestCtx.res,
      createReverseFunction(getGlobalRouteMap()),
    );
    if (middlewareResponse) throw middlewareResponse;
  }

  const loaderPromises: Promise<any>[] = [];
  const loaderIds: string[] = [];

  for (let i = 0; i < interceptEntry.loader.length; i++) {
    const { loader, revalidate: loaderRevalidateFns } =
      interceptEntry.loader[i];
    const segmentId = `${parentEntry.shortCode}.${interceptEntry.slotName}D${i}.${loader.$$id}`;

    if (revalidationContext) {
      const {
        clientSegmentIds,
        prevParams,
        request,
        prevUrl,
        nextUrl,
        routeKey,
        actionContext,
        stale,
      } = revalidationContext;

      const interceptSegmentId = `${parentEntry.shortCode}.${interceptEntry.slotName}`;
      if (clientSegmentIds.has(interceptSegmentId)) {
        const dummySegment: ResolvedSegment = {
          id: segmentId,
          namespace: `intercept:${interceptEntry.routeName}`,
          type: "loader",
          index: i,
          component: null,
          params,
          loaderId: loader.$$id,
          belongsToRoute,
        };

        const shouldRevalidate = await evaluateRevalidation({
          segment: dummySegment,
          prevParams,
          getPrevSegment: null,
          request,
          prevUrl,
          nextUrl,
          revalidations: loaderRevalidateFns.map((fn, j) => ({
            name: `intercept-loader-revalidate${j}`,
            fn,
          })),
          routeKey,
          context,
          actionContext,
          stale,
          traceSource: "intercept-loader",
        });

        if (!shouldRevalidate) {
          debugLog("intercept.loader", "skipped revalidation", {
            loaderId: loader.$$id,
          });
          continue;
        }
        debugLog("intercept.loader", "revalidating", {
          loaderId: loader.$$id,
          stale,
        });
      }
    }

    loaderIds.push(loader.$$id);
    loaderPromises.push(
      deps.wrapLoaderPromise(
        runInsideLoaderScope(() => context.use(loader)),
        parentEntry,
        segmentId,
        context.pathname,
      ),
    );
  }

  const handlerResult =
    typeof interceptEntry.handler === "function"
      ? handleHandlerResult(interceptEntry.handler(context))
      : interceptEntry.handler;

  let layoutElement: ReactNode | undefined;
  if (interceptEntry.layout) {
    if (typeof interceptEntry.layout === "function") {
      const layoutResult = await interceptEntry.layout(context);
      if (layoutResult instanceof Response) {
        throw layoutResult;
      }
      layoutElement = layoutResult;
    } else {
      layoutElement = interceptEntry.layout;
    }
  }

  let component: ReactNode;
  let loaderDataPromise: Promise<any[]> | any[] | undefined;

  if (interceptEntry.loading && loaderPromises.length > 0) {
    if (handlerResult instanceof Promise) {
      warnOnStreamedResponse(
        handlerResult,
        `intercept ${interceptEntry.slotName}`,
      );
    }
    component =
      handlerResult instanceof Promise
        ? handlerResult
        : (Promise.resolve(handlerResult) as ReactNode);
    loaderDataPromise = Promise.all(loaderPromises);
  } else if (loaderPromises.length > 0) {
    loaderDataPromise = await Promise.all(loaderPromises);
    component =
      handlerResult instanceof Promise ? await handlerResult : handlerResult;
  } else {
    component =
      interceptEntry.loading && handlerResult instanceof Promise
        ? handlerResult
        : handlerResult instanceof Promise
          ? await handlerResult
          : handlerResult;
  }

  const interceptSegment = {
    id: `${parentEntry.shortCode}.${interceptEntry.slotName}`,
    namespace: `intercept:${interceptEntry.routeName}`,
    type: "parallel" as const,
    index: 0,
    component,
    loading: interceptEntry.loading === false ? null : interceptEntry.loading,
    layout: layoutElement,
    params,
    slot: interceptEntry.slotName,
    belongsToRoute,
    parallelName: `intercept:${interceptEntry.routeName}.${interceptEntry.slotName}`,
    loaderDataPromise,
    loaderIds: loaderIds.length > 0 ? loaderIds : undefined,
  };
  segments.push(interceptSegment);

  return segments;
}

/**
 * Resolve only the loaders for a cached intercept segment.
 * Used on intercept cache hit to get fresh loader data while keeping cached component/layout.
 */
export async function resolveInterceptLoadersOnly<TEnv>(
  interceptEntry: InterceptEntry,
  parentEntry: EntryData,
  params: Record<string, string>,
  context: HandlerContext<any, TEnv>,
  belongsToRoute: boolean,
  deps: SegmentResolutionDeps<TEnv>,
  revalidationContext: {
    clientSegmentIds: Set<string>;
    prevParams: Record<string, string>;
    request: Request;
    prevUrl: URL;
    nextUrl: URL;
    routeKey: string;
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    };
    stale?: boolean;
  },
): Promise<{
  loaderDataPromise: Promise<any[]> | any[];
  loaderIds: string[];
} | null> {
  if (interceptEntry.loader.length === 0) {
    return null;
  }

  const loaderPromises: Promise<any>[] = [];
  const loaderIds: string[] = [];

  const {
    clientSegmentIds,
    prevParams,
    request,
    prevUrl,
    nextUrl,
    routeKey,
    actionContext,
    stale,
  } = revalidationContext;

  for (let i = 0; i < interceptEntry.loader.length; i++) {
    const { loader, revalidate: loaderRevalidateFns } =
      interceptEntry.loader[i];
    const segmentId = `${parentEntry.shortCode}.${interceptEntry.slotName}D${i}.${loader.$$id}`;

    const interceptSegmentId = `${parentEntry.shortCode}.${interceptEntry.slotName}`;
    if (clientSegmentIds.has(interceptSegmentId)) {
      const dummySegment: ResolvedSegment = {
        id: segmentId,
        namespace: `intercept:${interceptEntry.routeName}`,
        type: "loader",
        index: i,
        component: null,
        params,
        loaderId: loader.$$id,
        belongsToRoute,
      };

      const shouldRevalidate = await evaluateRevalidation({
        segment: dummySegment,
        prevParams,
        getPrevSegment: null,
        request,
        prevUrl,
        nextUrl,
        revalidations: loaderRevalidateFns.map((fn, j) => ({
          name: `intercept-loader-revalidate${j}`,
          fn,
        })),
        routeKey,
        context,
        actionContext,
        stale,
        traceSource: "intercept-loader",
      });

      if (!shouldRevalidate) {
        debugLog("intercept.loader", "skipped on cache hit", {
          loaderId: loader.$$id,
        });
        continue;
      }
      debugLog("intercept.loader", "revalidating on cache hit", {
        loaderId: loader.$$id,
        stale,
      });
    }

    loaderIds.push(loader.$$id);
    loaderPromises.push(
      deps.wrapLoaderPromise(
        runInsideLoaderScope(() => context.use(loader)),
        parentEntry,
        segmentId,
        context.pathname,
      ),
    );
  }

  if (loaderPromises.length === 0) {
    return null;
  }

  // Match fresh-path semantics: only defer (no await) when loading is truthy.
  // `loading: false` means "no loading UI, await loaders before render" —
  // same as the fresh path's `if (interceptEntry.loading && ...)` check.
  const loaderDataPromise = interceptEntry.loading
    ? Promise.all(loaderPromises)
    : await Promise.all(loaderPromises);

  return { loaderDataPromise, loaderIds };
}
