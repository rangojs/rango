/**
 * The URLs a rewritten request moved through (`throw rewrite()`), and what
 * each context sees of them.
 *
 * One source: the trail lives in the request's variables under a token no
 * user code can reach, so a middleware cannot reset the loop count. The
 * visitor's URL is its first entry (`ctx.rewrittenFrom`); the hops are its
 * length minus one.
 */

import { contextGet, contextSet, createVar } from "../context-var.js";
import { RewriteLoopError } from "../errors.js";
import { documentCacheStoresRender } from "../cache/document-cache-policy.js";
import { guardIdentityRead, type IdentityReadWording } from "./context.js";
import type { RequestContext } from "./request-context.js";

/** Most rewrites one request may take; the next one is a RewriteLoopError. */
export const MAX_REWRITE_HOPS = 5;

/** Clean hrefs, the visitor's first. */
const REWRITE_TRAIL = createVar<readonly string[]>();

type TrailContext = Pick<RequestContext<any>, "_variables">;

function pathKey(url: URL): string {
  return url.pathname + url.search;
}

/** The trail of a rewritten request; undefined when nothing rewrote. */
export function rewriteTrail(
  reqCtx: TrailContext | undefined,
): readonly string[] | undefined {
  return reqCtx?._variables
    ? (contextGet(reqCtx._variables, REWRITE_TRAIL) as
        | readonly string[]
        | undefined)
    : undefined;
}

/**
 * Count one hop from `from` to `to` (clean URLs) and return its number.
 * Throws RewriteLoopError past {@link MAX_REWRITE_HOPS}, or when `to` is the
 * URL the request is on (pathname and search).
 */
export function recordRewriteHop(
  reqCtx: TrailContext,
  from: URL,
  to: URL,
): number {
  const trail = [...(rewriteTrail(reqCtx) ?? [from.href]), to.href];
  const hops = trail.length - 1;
  if (pathKey(to) === pathKey(from) || hops > MAX_REWRITE_HOPS) {
    throw new RewriteLoopError(
      trail.map((href) => pathKey(new URL(href))),
      MAX_REWRITE_HOPS,
    );
  }
  contextSet(reqCtx._variables, REWRITE_TRAIL, trail);
  return hops;
}

type AudienceContext = Pick<
  RequestContext<any>,
  "_shellCaptureRun" | "_documentCacheRender" | "res"
>;

/**
 * A render other visitors may be served: a PPR shell capture, or a render
 * the document cache stores (its response opted in before next()). It shows
 * what a direct visit to its URL shows: no visitor theme, no visitor URL.
 */
export function rendersForSharedAudience(reqCtx: AudienceContext): boolean {
  return reqCtx._shellCaptureRun === true || documentCacheStoresRender(reqCtx);
}

/**
 * The URL the visitor is on: the first URL of a rewritten request, else
 * `url` with the internal `_rsc*` params stripped. A reload the router asks
 * the browser for points here.
 */
export function visitorUrl(reqCtx: TrailContext | undefined, url: URL): URL {
  const first = rewriteTrail(reqCtx)?.[0];
  if (first) return new URL(first);
  const clean = new URL(url);
  for (const key of [...clean.searchParams.keys()]) {
    if (key.startsWith("_rsc")) clean.searchParams.delete(key);
  }
  return clean;
}

const REWRITTEN_FROM_FIX =
  "It is the visitor's URL, which the shared entry would serve to every " +
  "visitor. Read it in middleware and pass what the page needs through a " +
  "variable the cache key covers.";

const REWRITTEN_FROM_READ: IdentityReadWording = {
  verb: "read",
  fix: {
    useCache:
      "ctx.rewrittenFrom is not in the cache key. Read it before the cached " +
      "function and pass it in as an argument.",
    cacheScope: REWRITTEN_FROM_FIX,
    capture: REWRITTEN_FROM_FIX,
    warning: REWRITTEN_FROM_FIX,
  },
};

/**
 * Who reads `rewrittenFrom`: "render" for the contexts a render reads
 * (handler, loader, response route, getRequestContext()), "middleware" for a
 * middleware ctx, which runs once per request and is never stored.
 */
export type RewrittenFromReader = "render" | "middleware";

/**
 * The read behind every `ctx.rewrittenFrom`. Guarded like cookies(): inside
 * a `cache()` boundary or a `"use cache"` function it throws, and a loader's
 * own `cache()` fill records it. A render other visitors may be served sees
 * `undefined`, as on a direct visit; any other render that sees the visitor's
 * URL marks `_payloadVisitorLocation`, so the document cache does not store
 * it.
 */
function readRewrittenFrom(
  reqCtx: RequestContext<any> | undefined,
  reader: RewrittenFromReader,
): string | undefined {
  if (!reqCtx) return undefined;
  if (reader === "render" && rendersForSharedAudience(reqCtx)) {
    return undefined;
  }
  guardIdentityRead(reqCtx, "ctx.rewrittenFrom", REWRITTEN_FROM_READ);
  const href = rewriteTrail(reqCtx)?.[0];
  if (href && reader === "render") reqCtx._payloadVisitorLocation = true;
  return href;
}

/** Each context's own copy of the URL, kept while the visitor URL holds. */
const COPIES = new WeakMap<object, URL>();
/** The request context a handler/loader/middleware ctx reads through. */
const SOURCES = new WeakMap<object, RequestContext<any> | undefined>();
const READERS = new WeakMap<object, RewrittenFromReader>();

function copyFor(holder: object, href: string | undefined): URL | undefined {
  if (!href) return undefined;
  const memo = COPIES.get(holder);
  if (memo && memo.href === href) return memo;
  const copy = new URL(href);
  COPIES.set(holder, copy);
  return copy;
}

/**
 * Non-enumerable, like `ctx.theme`: serializing a ctx (React's dev debug
 * info) must not count as a read.
 */
const SCOPED_DESCRIPTOR: PropertyDescriptor = {
  get(this: object): URL | undefined {
    const href = readRewrittenFrom(
      SOURCES.get(this),
      READERS.get(this) ?? "render",
    );
    return copyFor(this, href);
  },
  enumerable: false,
  configurable: true,
};

const REQUEST_DESCRIPTOR: PropertyDescriptor = {
  get(this: RequestContext<any>): URL | undefined {
    return copyFor(this, readRewrittenFrom(this, "render"));
  },
  enumerable: false,
  configurable: true,
};

/**
 * Define `ctx.rewrittenFrom` on a handler, loader, response-route or
 * middleware ctx, read through `source` (the request context it belongs
 * to). Each ctx gets its own copy of the URL.
 */
export function defineRewrittenFrom(
  ctx: object,
  source: RequestContext<any> | undefined,
  reader: RewrittenFromReader = "render",
): void {
  SOURCES.set(ctx, source);
  if (reader !== "render") READERS.set(ctx, reader);
  Object.defineProperty(ctx, "rewrittenFrom", SCOPED_DESCRIPTOR);
}

/** Define `rewrittenFrom` on a request context, read through itself. */
export function defineRequestRewrittenFrom(ctx: RequestContext<any>): void {
  Object.defineProperty(ctx, "rewrittenFrom", REQUEST_DESCRIPTOR);
}
