/**
 * ResolutionPass: what one walk over a matched chain reads.
 *
 * Every function of the segment walker (revalidation.ts, intercept-resolution.ts)
 * resolves against the same request: the handler context, the segments the
 * client holds, the previous and next location, the action, the staleness and
 * the router's deps. They take this one object instead of threading the same
 * ten values through each signature in a fixed order, where two adjacent
 * `URL`s or `Record<string, string>`s could swap without a type error.
 *
 * A full match (a document, the background re-render of a route record, a
 * build-time prerender) is a FRESH pass: see FRESH below.
 */

import type { HandlerContext } from "../../types.js";
import type { ActionContext, SegmentResolutionDeps } from "../types.js";
import { NOTHING_HELD } from "./prefetch-deferral.js";

/**
 * The segment ids the client holds, the set resolution works on (match-api.ts
 * may delete a route's id from the listed set to force a render). Empty on a
 * full refetch.
 */
export type ClientHeld = ReadonlySet<string>;

/**
 * The client of a full match: it holds nothing and asks for nothing to be
 * kept. Compared by identity (`pass.client === FRESH`), never by size: a
 * partial request whose client holds nothing (NOTHING_HELD, an empty
 * `_rsc_segments`) still asks the revalidate() rules. On a FRESH pass every
 * segment is new without a decision, trace entry or `revalidation.decision`
 * event, and the walker takes the full match's branches (revalidation.ts,
 * each marked FRESH).
 */
export const FRESH: ClientHeld = new Set<string>();

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
  /** Undefined only on a build-time FRESH pass (freshPassInput). */
  readonly request: Request | undefined;
  readonly prevUrl: URL;
  readonly nextUrl: URL;
  readonly routeKey: string;
  readonly actionContext?: ActionContext;
  readonly stale?: boolean;
  /**
   * No loader runs and no loader segment is emitted: build time
   * (prerender-match.ts) and the background re-render of a route record
   * (background-revalidation.ts), whose records never hold loaders.
   */
  readonly skipLoaders?: boolean;
  /**
   * A render error rethrows instead of rendering the error boundary, and a
   * streamed handler's rejection is not recovered. Build time only, so a
   * failure (or `throw new Skip()`) reaches the build instead of being baked
   * into a frozen 200 (issue #587).
   */
  readonly throwOnError?: boolean;
}

export interface ResolutionPass<TEnv = any> extends ResolutionPassInput<TEnv> {
  readonly deps: SegmentResolutionDeps<TEnv>;
}

/**
 * The input of a full match's pass (FRESH). At build time the prerender
 * context's `request` is a throwing getter (handler-context.ts
 * createPrerenderContext): the pass carries undefined instead.
 */
export function freshPassInput<TEnv>(
  context: HandlerContext<any, TEnv>,
  routeKey: string,
  params: Record<string, string>,
  options?: { skipLoaders?: boolean; throwOnError?: boolean },
): ResolutionPassInput<TEnv> {
  let request: Request | undefined;
  try {
    request = context.request;
  } catch {}
  return {
    context,
    client: FRESH,
    params,
    prevParams: {},
    request,
    prevUrl: context.url,
    nextUrl: context.url,
    routeKey,
    ...options,
  };
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
