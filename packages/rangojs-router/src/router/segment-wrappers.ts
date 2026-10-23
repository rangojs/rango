import type { SegmentResolutionDeps } from "./types.js";
import type { RouterContext } from "./router-context.js";
import type {
  ResolutionPass,
  ResolutionPassInput,
} from "./segment-resolution/resolution-pass.js";

import {
  resolveLoadersOnlyWithRevalidation as _resolveLoadersOnlyWithRevalidation,
  buildEntryRevalidateMap as _buildEntryRevalidateMap,
  resolveAllSegmentsWithRevalidation as _resolveAllSegmentsWithRevalidation,
} from "./segment-resolution.js";

import {
  findInterceptForRoute as _findInterceptForRoute,
  resolveInterceptEntry as _resolveInterceptEntry,
  resolveInterceptLoadersOnly as _resolveInterceptLoadersOnly,
} from "./intercept-resolution.js";

/** The resolvers RouterContext exposes, with the router's deps bound. */
export type SegmentWrappers<TEnv = any> = Pick<
  RouterContext<TEnv>,
  "resolveAllSegmentsWithRevalidation" | "resolveInterceptEntry"
> &
  Required<
    Pick<
      RouterContext<TEnv>,
      | "resolveLoadersOnlyWithRevalidation"
      | "buildEntryRevalidateMap"
      | "resolveInterceptLoadersOnly"
    >
  > & {
    /** Its own signature: a null selector context, isAction defaulting to false. */
    findInterceptForRoute: typeof _findInterceptForRoute;
  };

/**
 * Bind the router's segment deps into the extracted segment and intercept
 * resolvers. Each gets a ResolutionPass: the caller's request-side input with
 * the deps added here, once per call.
 */
export function createSegmentWrappers<TEnv = any>(
  deps: SegmentResolutionDeps<TEnv>,
): SegmentWrappers<TEnv> {
  const pass = (input: ResolutionPassInput<TEnv>): ResolutionPass<TEnv> => ({
    ...input,
    deps,
  });

  return {
    resolveLoadersOnlyWithRevalidation: (input, entries) =>
      _resolveLoadersOnlyWithRevalidation(pass(input), entries),
    buildEntryRevalidateMap: _buildEntryRevalidateMap,
    resolveAllSegmentsWithRevalidation: (input, entries, walk) =>
      _resolveAllSegmentsWithRevalidation(pass(input), entries, walk),
    findInterceptForRoute: _findInterceptForRoute,
    resolveInterceptEntry: (input, intercept, entry, belongsToRoute, options) =>
      _resolveInterceptEntry(
        pass(input),
        intercept,
        entry,
        belongsToRoute,
        options,
      ),
    resolveInterceptLoadersOnly: (input, intercept, entry, belongsToRoute) =>
      _resolveInterceptLoadersOnly(
        pass(input),
        intercept,
        entry,
        belongsToRoute,
      ),
  };
}
