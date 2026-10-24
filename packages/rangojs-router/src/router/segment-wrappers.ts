import type { SegmentResolutionDeps } from "./types.js";
import type { RouterContext } from "./router-context.js";
import type {
  ResolutionPass,
  ResolutionPassInput,
} from "./segment-resolution/resolution-pass.js";

import {
  resolveLoadersOnly as _resolveLoadersOnly,
  buildEntryRevalidateMap as _buildEntryRevalidateMap,
  resolveAllSegments as _resolveAllSegments,
} from "./segment-resolution.js";

import {
  findInterceptForRoute as _findInterceptForRoute,
  resolveInterceptEntry as _resolveInterceptEntry,
  resolveInterceptLoadersOnly as _resolveInterceptLoadersOnly,
} from "./intercept-resolution.js";

/** The resolvers RouterContext exposes, with the router's deps bound. */
export type SegmentWrappers<TEnv = any> = Pick<
  RouterContext<TEnv>,
  "resolveAllSegments" | "resolveInterceptEntry"
> &
  Required<
    Pick<
      RouterContext<TEnv>,
      | "resolveLoadersOnly"
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
    resolveLoadersOnly: (input, entries, walk) =>
      _resolveLoadersOnly(pass(input), entries, walk),
    buildEntryRevalidateMap: _buildEntryRevalidateMap,
    resolveAllSegments: (input, entries, walk) =>
      _resolveAllSegments(pass(input), entries, walk),
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
