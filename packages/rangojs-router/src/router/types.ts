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

/**
 * Result of resolving loaders with revalidation
 * Contains both segments to render and all matched segment IDs
 */
export interface LoaderRevalidationResult {
  segments: ResolvedSegment[];
  matchedIds: string[];
}

/**
 * Result of resolving segments with revalidation
 * Contains both segments to render and all matched segment IDs
 */
export interface SegmentRevalidationResult {
  segments: ResolvedSegment[];
  matchedIds: string[];
}

/**
 * Action context type for revalidation
 */
export type ActionContext = {
  actionId?: string;
  actionUrl?: URL;
  actionResult?: any;
  formData?: FormData;
};

/**
 * Dependencies passed to segment resolution functions
 * These are created within createRouter and passed to extracted utilities
 */
export interface RouterDependencies<TEnv> {
  findNearestErrorBoundary: (
    entry: EntryData | null,
  ) => ReactNode | ErrorBoundaryHandler | null;
  findNearestNotFoundBoundary: (
    entry: EntryData | null,
  ) => ReactNode | NotFoundBoundaryHandler | null;
}

/**
 * Dependencies injected from createRouter closure into extracted segment resolution functions.
 * These are the closure-bound helpers that cannot be imported directly.
 */
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
  trackHandler: <T>(promise: Promise<T>) => Promise<T>;
  findNearestErrorBoundary: (
    entry: EntryData | null,
  ) => ReactNode | ErrorBoundaryHandler | null;
  findNearestNotFoundBoundary: (
    entry: EntryData | null,
  ) => ReactNode | NotFoundBoundaryHandler | null;
  callOnError: (error: unknown, phase: ErrorPhase, context: any) => void;
}

/**
 * Dependencies injected from createRouter closure into extracted intercept resolution functions.
 */
export interface InterceptResolutionDeps<TEnv = any> {
  wrapLoaderPromise: SegmentResolutionDeps<TEnv>["wrapLoaderPromise"];
  evaluateInterceptWhen: (
    intercept: InterceptEntry,
    selectorContext: InterceptSelectorContext | null,
    isAction: boolean,
  ) => boolean;
}

/**
 * Dependencies injected from createRouter closure into extracted match API functions.
 */
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

/**
 * Title descriptor types for template support
 */
export type TitleDescriptor =
  | string
  | { template: string; default: string } // For layouts - template applied to child titles
  | { absolute: string }; // Bypass parent template

/**
 * Unset descriptor to remove inherited meta
 * Key format matches getMetaKey output: "title", "name:description", "property:og:image"
 */
export type UnsetDescriptor = { unset: string };

/**
 * Base meta descriptor types (sync values)
 */
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

/**
 * Meta descriptor that can be sync or async.
 * Use Promise<MetaDescriptorBase> for streaming meta that resolves after initial render.
 */
export type MetaDescriptor = MetaDescriptorBase | Promise<MetaDescriptorBase>;

type LdJsonObject = { [Key in string]: LdJsonValue } & {
  [Key in string]?: LdJsonValue | undefined;
};
type LdJsonArray = LdJsonValue[] | readonly LdJsonValue[];
type LdJsonPrimitive = string | number | boolean | null;
type LdJsonValue = LdJsonPrimitive | LdJsonObject | LdJsonArray;
