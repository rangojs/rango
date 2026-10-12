/**
 * The pass loop that honors `throw rewrite()` (route-definition/rewrite.ts):
 * one catch around the global middleware chain moves the same request
 * context to the target (server/request-context.ts rebaseRequestContext) and
 * runs the request again from the top, as a direct visit to the target
 * would run it. Shared by the request handler (rsc/handler.ts) and the
 * dispatch testing primitive, so the two cannot drift.
 */

import { RewriteLoopError } from "../errors.js";
import {
  describeRewriteTarget,
  isRewrite,
  rewriteNotSupported,
  type Rewrite,
} from "../route-definition/rewrite.js";
import { prefixBasename } from "../router/basename.js";
import {
  createReverseFunction,
  stripInternalParams,
} from "../router/handler-context.js";
import {
  rebaseRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import { recordRewriteHop } from "../server/rewrite-trail.js";

/** Response header naming the route path a rewritten request rendered. */
export const REWRITE_HEADER = "x-rango-rewrite";

/**
 * Resolve a rewrite's target against the router's route map (global names,
 * no param auto-fill, as middleware `ctx.reverse`) and the request origin.
 * A path is basename-prefixed like `redirect()` and must stay under the
 * basename once normalized (`/../admin` cannot step out of it). The
 * target's own `_rsc*` params are dropped: only the visitor's transport
 * params carry over. Throws for an unknown name, a missing param, another
 * origin or a path outside the basename.
 */
export function resolveRewriteTarget(
  rewrite: Rewrite,
  routeMap: Record<string, string>,
  base: URL,
  basename?: string,
): URL {
  const { target } = rewrite;
  const path =
    "path" in target
      ? prefixBasename(target.path, basename)
      : // `{}`, not undefined: a route with params then throws for the
        // missing ones instead of resolving to its raw pattern.
        createReverseFunction(routeMap)(
          target.name,
          target.params ?? {},
          target.search,
        );
  const resolved = stripInternalParams(new URL(path, base.origin));
  if (resolved.origin !== base.origin) {
    throw new TypeError(
      `${describeRewriteTarget(target)} must name a path in this app, not another origin.`,
    );
  }
  if (
    basename &&
    resolved.pathname !== basename &&
    !resolved.pathname.startsWith(basename + "/")
  ) {
    throw new TypeError(
      `${describeRewriteTarget(target)} resolves to ${resolved.pathname}, outside the router's basename ${basename}.`,
    );
  }
  resolved.hash = "";
  return resolved;
}

/**
 * The raw URL of a rewritten pass: the target's path and search plus the
 * visitor's internal `_rsc*` transport params, so a navigation stays a
 * navigation (same segments, version, partial flag).
 */
function rewriteTransportUrl(target: URL, visitorRaw: URL): URL {
  const raw = new URL(target);
  visitorRaw.searchParams.forEach((value, key) => {
    if (key.startsWith("_rsc")) raw.searchParams.append(key, value);
  });
  return raw;
}

/** The next pass of a rewritten request. */
export interface RewritePass {
  request: Request;
  /** The pass's raw URL, `_rsc*` params included. */
  url: URL;
  /** The target's clean URL. */
  target: URL;
  hops: number;
}

/**
 * Move the request context to `rewrite`'s target for the next pass: check
 * that this request can be rewritten, resolve the target, count the hop,
 * then rebase the context. Throws the site error for a mutation or a loader
 * fetch, a resolution error, and RewriteLoopError.
 */
export function applyRewrite(
  rewrite: Rewrite,
  passRequest: Request,
  reqCtx: RequestContext<any>,
  routeMap: Record<string, string>,
  basename: string | undefined,
): RewritePass {
  // A loader fetch first: `load()` with a body is a POST, and its refusal
  // is the loader fetch's.
  if (reqCtx.originalUrl.searchParams.has("_rsc_loader")) {
    throw rewriteNotSupported(rewrite, "loader-fetch");
  }
  if (passRequest.method !== "GET" && passRequest.method !== "HEAD") {
    throw rewriteNotSupported(rewrite, "mutation");
  }
  const target = resolveRewriteTarget(rewrite, routeMap, reqCtx.url, basename);
  const hops = recordRewriteHop(reqCtx, reqCtx.url, target);
  const url = rewriteTransportUrl(target, reqCtx.originalUrl);
  const request = new Request(url, passRequest);
  rebaseRequestContext(reqCtx, request, url);
  return { request, url, target, hops };
}

/** The response to a rewrite loop. */
export function loopDetectedResponse(): Response {
  return new Response("Loop Detected", {
    status: 508,
    headers: { "content-type": "text/plain;charset=utf-8" },
  });
}

export interface RewritePassesOptions {
  reqCtx: RequestContext<any>;
  /** The visitor's request and raw URL: the first pass. */
  request: Request;
  url: URL;
  routeMap: () => Record<string, string>;
  basename: string | undefined;
  /** One pass: the global chain matched on `url`'s path around the core handler. */
  runPass: (request: Request, url: URL) => Promise<Response>;
  /** After a hop moved the context to its target. */
  onHop?: (pass: RewritePass) => void;
  /** Report a rewrite the request cannot take (onError, phase "routing"). */
  report: (error: unknown, at: { request: Request; url: URL }) => void;
  /**
   * The response for a refused rewrite other than a loop (a loader fetch's
   * error response); undefined rethrows the error.
   */
  refuse?: (error: unknown, rewrite: Rewrite) => Response | undefined;
}

export interface RewritePassesResult {
  response: Response;
  /** The pathname the final pass rendered, when a rewrite took the request there. */
  rewrittenTo?: string;
}

/**
 * Run the request pass by pass until one produces a response. A `Rewrite`
 * that unwinds a pass moves the context to its target and runs the next;
 * a loop answers 508; a rewrite the request cannot take is reported and
 * becomes `refuse`'s response, or is thrown.
 */
export async function runRewritePasses(
  opts: RewritePassesOptions,
): Promise<RewritePassesResult> {
  let request = opts.request;
  let url = opts.url;
  let rewrittenTo: string | undefined;
  for (;;) {
    let rewrite: Rewrite;
    try {
      return { response: await opts.runPass(request, url), rewrittenTo };
    } catch (error) {
      if (!isRewrite(error)) throw error;
      rewrite = error;
    }
    let pass: RewritePass;
    try {
      pass = applyRewrite(
        rewrite,
        request,
        opts.reqCtx,
        opts.routeMap(),
        opts.basename,
      );
    } catch (error) {
      opts.report(error, { request, url });
      if (error instanceof RewriteLoopError) {
        return { response: loopDetectedResponse() };
      }
      const refused = opts.refuse?.(error, rewrite);
      if (refused) return { response: refused };
      throw error;
    }
    request = pass.request;
    url = pass.url;
    rewrittenTo = pass.target.pathname;
    opts.onHop?.(pass);
  }
}
