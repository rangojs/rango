/**
 * ResolutionPass: what one revalidating walk over a matched chain reads.
 *
 * Every function of the partial lane (revalidation.ts, intercept-resolution.ts)
 * resolves against the same request: the handler context, the segments the
 * client holds, the previous and next location, the action, the staleness and
 * the router's deps. They take this one object instead of threading the same
 * ten values through each signature in a fixed order, where two adjacent
 * `URL`s or `Record<string, string>`s could swap without a type error.
 */

import type { HandlerContext } from "../../types";
import type { ActionContext, SegmentResolutionDeps } from "../types.js";
import { NOTHING_HELD } from "./prefetch-deferral.js";

/**
 * The segment ids the client holds, the set resolution works on (match-api.ts
 * may delete a route's id from the listed set to force a render). Empty on a
 * full refetch.
 */
export type ClientHeld = ReadonlySet<string>;

/**
 * A pass without the router's deps: what match middleware knows about the
 * request. createSegmentWrappers (segment-wrappers.ts) binds the deps.
 */
export interface ResolutionPassInput<TEnv = any> {
  readonly context: HandlerContext<any, TEnv>;
  readonly client: ClientHeld;
  /** The matched route's params, stamped on every segment the walk emits. */
  readonly params: Record<string, string>;
  readonly prevParams: Record<string, string>;
  readonly request: Request;
  readonly prevUrl: URL;
  readonly nextUrl: URL;
  readonly routeKey: string;
  readonly actionContext?: ActionContext;
  readonly stale?: boolean;
}

export interface ResolutionPass<TEnv = any> extends ResolutionPassInput<TEnv> {
  readonly deps: SegmentResolutionDeps<TEnv>;
}

/**
 * The input of a pass whose client holds nothing: every segment is new and
 * renders. The background re-render of an intercept (background-revalidation.ts)
 * resolves with it.
 */
export function heldNothingPassInput<TEnv>(
  context: HandlerContext<any, TEnv>,
  routeKey: string,
  params: Record<string, string>,
): ResolutionPassInput<TEnv> {
  return {
    context,
    client: NOTHING_HELD,
    params,
    prevParams: {},
    request: context.request,
    prevUrl: context.url,
    nextUrl: context.url,
    routeKey,
  };
}
