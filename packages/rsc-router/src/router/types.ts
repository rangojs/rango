/**
 * Router Internal Types
 *
 * Shared types for router module utilities.
 */

import type { ReactNode } from "react";
import type { EntryData } from "../server/context";
import type {
  ResolvedSegment,
  HandlerContext,
  ErrorBoundaryHandler,
  NotFoundBoundaryHandler,
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
 * These are created within createRSCRouter and passed to extracted utilities
 */
export interface RouterDependencies<TEnv> {
  findNearestErrorBoundary: (
    entry: EntryData | null
  ) => ReactNode | ErrorBoundaryHandler | null;
  findNearestNotFoundBoundary: (
    entry: EntryData | null
  ) => ReactNode | NotFoundBoundaryHandler | null;
  executeMiddleware: (
    middleware: any[],
    ctx: HandlerContext<any, TEnv>,
    entryId?: string
  ) => Promise<Response | null>;
}
