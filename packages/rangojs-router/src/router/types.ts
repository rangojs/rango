/**
 * Router Internal Types
 *
 * Shared types for router module utilities.
 */

import type { ReactNode } from "react";
import type {
  EntryData,
  InterceptEntry,
  InterceptSelectorContext,
} from "../server/context";
import type {
  ErrorInfo,
  ErrorPhase,
  LoaderDataResult,
  ResolvedSegment,
  HandlerContext,
  InternalHandlerContext,
  ErrorBoundaryHandler,
  NotFoundBoundaryHandler,
  ShouldRevalidateFn,
} from "../types";

export interface SegmentRevalidationResult {
  segments: ResolvedSegment[];
  matchedIds: string[];
}

export type ActionContext = {
  actionId?: string;
  actionUrl?: URL;
  actionResult?: any;
  formData?: FormData;
};

export interface SegmentResolutionDeps<TEnv = any> {
  wrapLoaderPromise: <T>(
    promise: Promise<T>,
    entry: EntryData,
    segmentId: string,
    pathname: string,
    errorContext?: {
      request: Request;
      url: URL;
      routeKey?: string;
      params?: Record<string, string>;
      env?: TEnv;
      isPartial?: boolean;
      requestStartTime?: number;
    },
  ) => Promise<LoaderDataResult<T>>;
  trackHandler: <T>(
    promise: Promise<T>,
    errorContext?: {
      segmentId?: string;
      segmentType?: string;
    },
  ) => Promise<T>;
  findNearestErrorBoundary: (
    entry: EntryData | null,
  ) => ReactNode | ErrorBoundaryHandler | null;
  findNearestNotFoundBoundary: (
    entry: EntryData | null,
  ) => ReactNode | NotFoundBoundaryHandler | null;
  notFoundComponent?: ReactNode | ((props: { pathname: string }) => ReactNode);
  callOnError: (error: unknown, phase: ErrorPhase, context: any) => void;
  /**
   * Router-level default for the per-segment `transition({ viewTransition })`
   * flag, from createRouter({ viewTransition }). Resolved into each segment's
   * transition config during resolution (only `false` is stamped) so the render
   * gate reads the boundary decision off the segment on both server and client.
   * Undefined is treated as "auto" (wrap).
   */
  viewTransitionDefault?: "auto" | false;
}

export interface MatchApiDeps<TEnv = any> {
  findMatch: (pathname: string, ms?: any) => any;
  getMetricsStore: () => any;
  findInterceptForRoute: (
    routeKey: string,
    parentEntry: EntryData | null,
    selectorContext: InterceptSelectorContext | null,
    isAction: boolean,
  ) => { intercept: InterceptEntry; entry: EntryData } | null;
  callOnError: SegmentResolutionDeps<TEnv>["callOnError"];
  findNearestErrorBoundary: SegmentResolutionDeps<TEnv>["findNearestErrorBoundary"];
  getRouteMap: () => Record<string, string>;
}

export type TitleDescriptor =
  | string
  | { template: string; default: string } // For layouts - template applied to child titles
  | { absolute: string };

export type UnsetDescriptor = { unset: string };

export type MetaDescriptorBase =
  | { charSet: "utf-8" }
  | { title: TitleDescriptor }
  | { name: string; content: string }
  | { property: string; content: string }
  | { httpEquiv: string; content: string }
  | { "script:ld+json": LdJsonObject }
  | { tagName: "meta" | "link"; [name: string]: string }
  | UnsetDescriptor
  | { [name: string]: unknown };

export type MetaDescriptor = MetaDescriptorBase | Promise<MetaDescriptorBase>;

type LdJsonObject = { [Key in string]: LdJsonValue } & {
  [Key in string]?: LdJsonValue | undefined;
};
type LdJsonArray = LdJsonValue[] | readonly LdJsonValue[];
type LdJsonPrimitive = string | number | boolean | null;
type LdJsonValue = LdJsonPrimitive | LdJsonObject | LdJsonArray;
