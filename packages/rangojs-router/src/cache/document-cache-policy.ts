/**
 * Document cache storage policy: which responses the document cache stores.
 * A leaf (types and the per-client signal only), so request-scoped code can
 * ask whether a render will be stored (documentCacheStoresRender) without
 * importing the cache middleware.
 */

import { hasPerClientSignal } from "../browser/cookie-name.js";
import type { RequestContext } from "../server/request-context.js";

export interface CacheDirectives {
  sMaxAge?: number;
  staleWhileRevalidate?: number;
}

/**
 * Parse Cache-Control header for s-maxage and stale-while-revalidate directives
 */
function parseCacheControl(header: string | null): CacheDirectives | null {
  if (!header) return null;

  // RFC 7234: in a SHARED cache, `private` and `no-store` forbid storage and
  // MUST win over `s-maxage` even though `private, s-maxage` is contradictory.
  // The document cache is a shared app store, so refuse both regardless of any
  // s-maxage / stale-while-revalidate also present. Match standalone directive
  // tokens (start/end, whitespace, comma, semicolon, or `=` bounded), not a
  // substring, so a value containing "private" cannot false-veto.
  if (/(^|[\s,;])(private|no-store)(?=$|[\s,;=])/i.test(header)) {
    return null;
  }

  // RFC 7234 §5.2.2.2: a shared cache MUST NOT serve a stored `no-cache`
  // response without successful origin validation. This store's hit path has no
  // validation step, so serving a stored no-cache response within s-maxage
  // would hand the client content the origin marked must-revalidate. Refuse to
  // store it. Only UNqualified `no-cache` (no `=`) vetoes — the field-name-
  // scoped `no-cache="set-cookie"` form IS storable per the RFC, so the `=`
  // boundary is excluded from the lookahead (unlike private/no-store above).
  if (/(^|[\s,;])no-cache(?=$|[\s,;])/i.test(header)) {
    return null;
  }

  const directives: CacheDirectives = {};

  // Parse s-maxage
  const sMaxAgeMatch = header.match(/s-maxage\s*=\s*(\d+)/i);
  if (sMaxAgeMatch) {
    directives.sMaxAge = parseInt(sMaxAgeMatch[1], 10);
  }

  // Parse stale-while-revalidate
  const swrMatch = header.match(/stale-while-revalidate\s*=\s*(\d+)/i);
  if (swrMatch) {
    directives.staleWhileRevalidate = parseInt(swrMatch[1], 10);
  }

  // Only return if we have at least s-maxage (required for document caching)
  if (directives.sMaxAge !== undefined) {
    return directives;
  }

  return null;
}

/**
 * Check if response should be cached based on Cache-Control headers
 */
export function shouldCacheResponse(
  response: Response,
  requestCtx?: Pick<
    RequestContext,
    "_payloadVisitorTheme" | "_payloadDeferred" | "_payloadVisitorLocation"
  >,
): CacheDirectives | null {
  // Only cache successful responses
  if (response.status !== 200) {
    return null;
  }

  // Never cache a per-client signal into a SHARED response store. A Set-Cookie
  // (e.g. a rango state rotation from invalidateClientCache(), or any cookie a
  // loader set) would be replayed to every client on a hit — pinning them to
  // one value and even rolling a rotated client back to a prior one. The
  // x-rango-keep-cache directive header is the mirror image: a replayed "keep"
  // would suppress invalidation for every replayed client. Refuse both.
  if (hasPerClientSignal(response.headers)) {
    return null;
  }

  // The payload carries the visitor's theme (#978): the render ran before the
  // response opted in (a Cache-Control written after next()), so
  // payloadInitialTheme could not render the default.
  if (requestCtx?._payloadVisitorTheme) {
    return null;
  }

  // A rewritten request's render shows the visitor's URL (renderedLocation,
  // full-payload.ts); this entry is keyed by the rewrite target.
  if (requestCtx?._payloadVisitorLocation) {
    return null;
  }

  // prefetch: false. The payload carries deferred units: it answers one
  // page's prefetch and nothing else. parseCacheControl refuses the
  // Cache-Control it is sent with (rsc-rendering.ts NOT_REUSED), but a
  // middleware can replace that after next(), and a navigation answered
  // with this body would show a fallback no fill ever replaces.
  if (requestCtx?._payloadDeferred) {
    return null;
  }

  const cacheControl = response.headers.get("Cache-Control");
  return parseCacheControl(cacheControl);
}

/**
 * Whether this cache will store the response the current render produces, as
 * far as the render can tell: the middleware runs it (a MISS or a stale
 * refresh) and the response stub already opts in. payloadInitialTheme
 * (rsc/full-payload.ts) then renders the no-cookie default theme (#978). A
 * Cache-Control written after next() is not on the stub yet; for that render
 * shouldCacheResponse refuses a payload marked `_payloadVisitorTheme`.
 */
export function documentCacheStoresRender(
  reqCtx: Pick<RequestContext, "_documentCacheRender" | "res">,
): boolean {
  return (
    reqCtx._documentCacheRender === true &&
    shouldCacheResponse(reqCtx.res) !== null
  );
}
