import type { EntryData, InterceptEntry } from "../server/context";
import type {
  HandlerContext,
  ResolvedSegment,
  ShouldRevalidateFn,
} from "../types";
import type { SegmentResolutionDeps } from "./types.js";
import type { ResolveSegmentOptions } from "./segment-resolution.js";

import {
  resolveAllSegments as _resolveAllSegments,
  resolveLoadersOnly as _resolveLoadersOnly,
  resolveLoadersOnlyWithRevalidation as _resolveLoadersOnlyWithRevalidation,
  buildEntryRevalidateMap as _buildEntryRevalidateMap,
  resolveAllSegmentsWithRevalidation as _resolveAllSegmentsWithRevalidation,
} from "./segment-resolution.js";

import {
  findInterceptForRoute as _findInterceptForRoute,
  resolveInterceptEntry as _resolveInterceptEntry,
  resolveInterceptLoadersOnly as _resolveInterceptLoadersOnly,
} from "./intercept-resolution.js";

import type { InterceptSelectorContext } from "../server/context";

export interface SegmentWrappers<TEnv = any> {
  resolveAllSegments: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
    options?: ResolveSegmentOptions,
  ) => Promise<ResolvedSegment[]>;
  resolveLoadersOnly: (
    entries: EntryData[],
    context: HandlerContext<any, TEnv>,
  ) => Promise<ResolvedSegment[]>;
  resolveLoadersOnlyWithRevalidation: (
    entries: EntryData[],
    context: HandlerContext<any, TEnv>,
    clientSegmentIds: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    routeKey: string,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    },
    stale?: boolean,
  ) => Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }>;
  buildEntryRevalidateMap: (
    entries: EntryData[],
  ) => Map<
    string,
    { entry: EntryData; revalidate: ShouldRevalidateFn<any, any>[] }
  >;
  resolveAllSegmentsWithRevalidation: (
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    clientSegmentSet: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    actionContext:
      | {
          actionId?: string;
          actionUrl?: URL;
          actionResult?: any;
          formData?: FormData;
        }
      | undefined,
    interceptResult: { intercept: InterceptEntry; entry: EntryData } | null,
    localRouteName: string,
    pathname: string,
  ) => Promise<{ segments: ResolvedSegment[]; matchedIds: string[] }>;
  findInterceptForRoute: (
    targetRouteKey: string,
    fromEntry: EntryData | null,
    selectorContext?: InterceptSelectorContext | null,
    isAction?: boolean,
  ) => { intercept: InterceptEntry; entry: EntryData } | null;
  resolveInterceptEntry: (
    interceptEntry: InterceptEntry,
    parentEntry: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    belongsToRoute?: boolean,
    revalidationContext?: any,
    options?: { skipMiddleware?: boolean },
  ) => Promise<ResolvedSegment[]>;
  resolveInterceptLoadersOnly: (
    interceptEntry: InterceptEntry,
    parentEntry: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    belongsToRoute?: boolean,
    revalidationContext?: any,
  ) => Promise<{
    loaderDataPromise: Promise<any[]> | any[];
    loaderIds: string[];
  } | null>;
}

/**
 * Create thin wrapper functions that bind segmentDeps to extracted
 * segment resolution and intercept resolution functions.
 *
 * These maintain the same signatures as the original inline functions
 * so that RouterContext and call sites don't need to change.
 */
export function createSegmentWrappers<TEnv = any>(
  segmentDeps: SegmentResolutionDeps<TEnv>,
): SegmentWrappers<TEnv> {
  function resolveAllSegments(
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
    options?: ResolveSegmentOptions,
  ): ReturnType<typeof _resolveAllSegments> {
    return _resolveAllSegments(
      entries,
      routeKey,
      params,
      context,
      loaderPromises,
      segmentDeps,
      options,
    );
  }

  function resolveLoadersOnly(
    entries: EntryData[],
    context: HandlerContext<any, TEnv>,
  ): ReturnType<typeof _resolveLoadersOnly> {
    return _resolveLoadersOnly(entries, context, segmentDeps);
  }

  function resolveLoadersOnlyWithRevalidation(
    entries: EntryData[],
    context: HandlerContext<any, TEnv>,
    clientSegmentIds: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    routeKey: string,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    },
    stale?: boolean,
  ): ReturnType<typeof _resolveLoadersOnlyWithRevalidation> {
    return _resolveLoadersOnlyWithRevalidation(
      entries,
      context,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      segmentDeps,
      actionContext,
      stale,
    );
  }

  function buildEntryRevalidateMap(
    entries: EntryData[],
  ): ReturnType<typeof _buildEntryRevalidateMap> {
    return _buildEntryRevalidateMap(entries);
  }

  function resolveAllSegmentsWithRevalidation(
    entries: EntryData[],
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    clientSegmentSet: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    actionContext:
      | {
          actionId?: string;
          actionUrl?: URL;
          actionResult?: any;
          formData?: FormData;
        }
      | undefined,
    interceptResult: { intercept: InterceptEntry; entry: EntryData } | null,
    localRouteName: string,
    pathname: string,
    stale?: boolean,
  ): ReturnType<typeof _resolveAllSegmentsWithRevalidation> {
    return _resolveAllSegmentsWithRevalidation(
      entries,
      routeKey,
      params,
      context,
      clientSegmentSet,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      actionContext,
      interceptResult,
      localRouteName,
      pathname,
      segmentDeps,
      stale,
    );
  }

  function findInterceptForRoute(
    targetRouteKey: string,
    fromEntry: EntryData | null,
    selectorContext: InterceptSelectorContext | null = null,
    isAction: boolean = false,
  ): ReturnType<typeof _findInterceptForRoute> {
    return _findInterceptForRoute(
      targetRouteKey,
      fromEntry,
      selectorContext,
      isAction,
    );
  }

  function resolveInterceptEntry(
    interceptEntry: InterceptEntry,
    parentEntry: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    belongsToRoute: boolean = true,
    revalidationContext?: any,
    options?: { skipMiddleware?: boolean },
  ): ReturnType<typeof _resolveInterceptEntry> {
    return _resolveInterceptEntry(
      interceptEntry,
      parentEntry,
      params,
      context,
      belongsToRoute,
      segmentDeps,
      revalidationContext,
      options,
    );
  }

  function resolveInterceptLoadersOnly(
    interceptEntry: InterceptEntry,
    parentEntry: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    belongsToRoute: boolean = true,
    revalidationContext: any,
  ): ReturnType<typeof _resolveInterceptLoadersOnly> {
    return _resolveInterceptLoadersOnly(
      interceptEntry,
      parentEntry,
      params,
      context,
      belongsToRoute,
      segmentDeps,
      revalidationContext,
    );
  }

  return {
    resolveAllSegments: resolveAllSegments,
    resolveLoadersOnly: resolveLoadersOnly,
    resolveLoadersOnlyWithRevalidation: resolveLoadersOnlyWithRevalidation,
    buildEntryRevalidateMap: buildEntryRevalidateMap,
    resolveAllSegmentsWithRevalidation: resolveAllSegmentsWithRevalidation,
    findInterceptForRoute: findInterceptForRoute,
    resolveInterceptEntry: resolveInterceptEntry,
    resolveInterceptLoadersOnly: resolveInterceptLoadersOnly,
  };
}
