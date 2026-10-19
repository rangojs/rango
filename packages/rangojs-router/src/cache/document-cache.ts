/**
 * Document-Level Cache Middleware
 *
 * Caches full HTTP responses in the configured app store based on Cache-Control
 * headers. A deployment CDN may independently consume the same shared-cache
 * directives; this middleware itself runs inside the worker/function.
 * Routes opt-in to caching by setting s-maxage or stale-while-revalidate headers.
 *
 * Flow:
 * 1. Check cache for existing response
 * 2. If fresh hit → return cached response
 * 3. If stale hit (within SWR window) → return cached, revalidate in background
 * 4. If miss → run handler, cache if response has cache headers
 */

import { requestHeaders } from "../server/request-headers.js";
import { FILL_PARAM, STALE_PARAM } from "../prefetch-markers.js";
import type { MiddlewareFn, MiddlewareContext } from "../router/middleware.js";
import {
  documentCacheStoresRender,
  shouldCacheResponse,
} from "./document-cache-policy.js";
import {
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import { mayNeedSSR } from "../rsc/ssr-setup.js";
import { requestKeyBase } from "./cache-key-utils.js";
import { runBackground } from "./background-task.js";
import {
  isWarmReplace,
  noteWarmDocument,
  noteWarmWrite,
} from "../prerender/warm-request.js";
import { reportCacheError } from "./cache-error.js";
import {
  executionStart,
  markResponseStart,
  predatesInvalidation,
} from "./tag-invalidation.js";
import { observePhase, PHASES } from "../router/instrument.js";
import { isRewrite } from "../route-definition/rewrite.js";
import {
  SEGMENT_FRAGMENT_CAPABILITY_HEADER,
  SEGMENT_FRAGMENT_RECOVERY_HEADER,
} from "../segment-fragments.js";

export { documentCacheStoresRender };

const CACHE_STATUS_HEADER = "x-document-cache-status";

function collectRequestTags(
  requestCtx: RequestContext | undefined,
): string[] | undefined {
  const tags = requestCtx?._requestTags;
  return tags && tags.size > 0 ? [...tags] : undefined;
}

function hashSegmentIds(segmentIds: string): string {
  if (!segmentIds) return "";

  let hash = 0;
  for (let i = 0; i < segmentIds.length; i++) {
    const char = segmentIds.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Throw the first error the drained render reported through Flight or Fizz
 * onError. A component that throws after the 200 committed does not fail the
 * stream: it completes with an error row or an errored Suspense boundary, and
 * every hit would serve it (issue #915). The caller's catch reports the skipped
 * write as cache-write. Read only after the body is fully drained, when both
 * renders have finished.
 */
function throwIfRenderErrored(requestCtx: RequestContext | undefined): void {
  const errors = requestCtx?._renderErrors;
  if (errors && errors.length > 0) throw errors[0];
}

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Add the cache-status header (HIT/STALE/MISS) to a response.
 *
 * The response we get here is always a fresh instance — the store rebuilds a
 * new Response per getResponse(), and the miss path wraps a fresh Response
 * around the tee'd body — so mutating its headers in place is safe and avoids
 * cloning every header + allocating a new Response on every cache hit. Only when
 * the headers are immutable (a guarded Response rejects set() with a TypeError)
 * do we fall back to rebuilding the Response with a mutable Headers.
 */
function addCacheStatusHeader(
  response: Response,
  status: "HIT" | "STALE" | "MISS",
): Response {
  try {
    response.headers.set(CACHE_STATUS_HEADER, status);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(CACHE_STATUS_HEADER, status);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * Drain and run onResponse callbacks registered on the request context.
 * Mirrors the drain semantics of finalizeResponse() in rsc/helpers.ts:
 * callbacks are spliced out so they fire at most once per request.
 */
function drainOnResponseCallbacks(
  response: Response,
  requestCtx:
    | { _onResponseCallbacks: Array<(r: Response) => Response> }
    | undefined,
): Response {
  if (!requestCtx || requestCtx._onResponseCallbacks.length === 0) {
    return response;
  }
  const callbacks = requestCtx._onResponseCallbacks;
  requestCtx._onResponseCallbacks = [];
  let result = response;
  for (const callback of callbacks) {
    result = callback(result) ?? result;
  }
  return result;
}

// ============================================================================
// Document Cache Middleware
// ============================================================================

export interface DocumentCacheOptions<TEnv = any> {
  /**
   * Skip caching for specific paths (e.g., API routes)
   */
  skipPaths?: string[];

  /**
   * Custom cache key generator.
   *
   * Replaces the default `router id + host + pathname + search` key entirely.
   * On a multi-domain deployment served by one function you MUST include
   * `url.host` (or an equivalent tenant discriminator) yourself — the default
   * key is host-namespaced, but a custom generator's output is used verbatim,
   * so omitting host bleeds one hostname's cached response to another. The
   * same goes for the router: two routers that share a cache store and can
   * serve one host and path (a `hostOverride` cookie) need a generator that
   * tells them apart.
   */
  keyGenerator?: (url: URL) => string;

  /**
   * Callback to determine if caching should be enabled for this request.
   * Receives the middleware context and returns true to enable caching.
   * If not provided, caching is enabled by default.
   *
   * @example
   * ```typescript
   * createDocumentCacheMiddleware({
   *   isEnabled: (ctx) => !ctx.request.headers.has('x-skip-cache'),
   * })
   * ```
   */
  isEnabled?: (ctx: MiddlewareContext<TEnv>) => boolean | Promise<boolean>;

  /**
   * Enable debug logging for cache operations.
   * Logs HIT, MISS, STALE, and REVALIDATED events.
   * Defaults to false.
   */
  debug?: boolean;
}

/**
 * Create document cache middleware
 *
 * Add this middleware to your router to enable document-level caching.
 * It uses the cache store's getResponse/putResponse methods for caching.
 * Routes opt-in by setting Cache-Control headers with s-maxage.
 *
 * @example
 * ```typescript
 * // Add middleware to router
 * const router = createRouter<AppEnv>()
 *   .use(createDocumentCacheMiddleware({
 *     isEnabled: (ctx) => ctx.url.pathname !== '/admin',
 *   }))
 *   .route("home", (ctx) => {
 *     ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
 *     return <HomePage />;
 *   });
 * ```
 */
export function createDocumentCacheMiddleware<TEnv = any>(
  options: DocumentCacheOptions<TEnv> = {},
): MiddlewareFn<TEnv> {
  const { skipPaths = [], keyGenerator, isEnabled, debug = false } = options;

  const log = debug ? (message: string) => console.log(message) : () => {};

  return async function documentCacheMiddleware(
    ctx: MiddlewareContext<TEnv>,
    next: () => Promise<Response>,
  ): Promise<Response> {
    const url = ctx.url;

    // Use the original request URL for _rsc* param detection and cache key
    // differentiation. ctx.url is stripped of _rsc* params by the middleware
    // pipeline (stripInternalParams), so _rsc_partial, _rsc_segments, etc.
    // are not visible on ctx.url in production.
    const rawUrl = new URL(ctx.request.url);
    const isFragmentRecovery =
      requestHeaders(ctx.request).get(SEGMENT_FRAGMENT_RECOVERY_HEADER) === "1";

    // Only cache GET requests — mutations and other methods must not be cached
    if (ctx.request.method !== "GET") {
      return next();
    }

    // Skip RSC action requests (mutations shouldn't be cached)
    if (rawUrl.searchParams.has("_rsc_action")) {
      return next();
    }

    // Skip loader requests (have their own caching)
    if (rawUrl.searchParams.has("_rsc_loader")) {
      return next();
    }

    // Skip fill and stale partial requests: never served from a stored body,
    // never stored. A fill renders against what one client holds. A stale
    // request (sent during an action's flight, on a Back/Forward revalidation,
    // or holding no segments) may follow a write the key cannot see. Partial
    // only: _rsc params leave the key, so a document GET carrying them must not
    // force an origin render.
    if (
      rawUrl.searchParams.has("_rsc_partial") &&
      (rawUrl.searchParams.has(FILL_PARAM) ||
        rawUrl.searchParams.get(STALE_PARAM) === "true")
    ) {
      return next();
    }

    // Skip configured paths
    if (skipPaths.some((path) => url.pathname.startsWith(path))) {
      return next();
    }

    // Check if caching is enabled for this request
    if (isEnabled) {
      const enabled = await isEnabled(ctx);
      if (!enabled) {
        return next();
      }
    }

    // Get request context and cache store
    const requestCtx = getRequestContext();
    const store = requestCtx?._cacheStore;

    // Skip if no cache store or store doesn't support response caching
    if (!store?.getResponse || !store?.putResponse) {
      return next();
    }

    // The write gate's start (#977) and the entry's stamp (#1068): the
    // request's, not this middleware's, also for a stale refresh. A
    // middleware ahead of this one can read tagged data the document bakes,
    // and a stale refresh re-runs the handler over what they set.
    const start = requestCtx._requestStart ?? executionStart();

    // Determine request type for cache key differentiation.
    // Uses rawUrl for _rsc* param checks and mayNeedSSR for Accept-based
    // detection. Full-document RSC fetches must not share the HTML cache slot.
    const isPartial = rawUrl.searchParams.has("_rsc_partial");
    const isRscRequest = !mayNeedSSR(ctx.request, rawUrl);
    const typeLabel = isRscRequest ? "RSC" : "HTML";

    // Track whether next() has been called so the catch block knows
    // whether it is safe to fall through to the handler.
    let handlerCalled = false;

    try {
      // Generate cache key inside try so a throwing keyGenerator degrades
      // gracefully to the origin handler instead of rejecting the request.
      // This is a deliberate fail-open-to-origin policy: the fallback is
      // "serve uncached from origin", not "use a different cache key".
      const clientSegments = rawUrl.searchParams.get("_rsc_segments") || "";
      const segmentHash =
        isPartial && clientSegments ? `:${hashSegmentIds(clientSegments)}` : "";
      // Fragment envelopes require a capable Rango decoder. Keep that wire
      // variant out of the context-less/legacy partial slot; this middleware
      // returns hits before request classification and cannot rely on the
      // match-time capability gate.
      const fragmentSuffix =
        isPartial &&
        (requestHeaders(ctx.request).get(SEGMENT_FRAGMENT_CAPABILITY_HEADER) ===
          "1" ||
          isFragmentRecovery)
          ? ":fragments"
          : "";
      const typeSuffix = isRscRequest ? ":rsc" : ":html";

      // Default key rides the shared host-namespaced base (cacheKeyBase) so the
      // segment tier (cache-scope.ts) and this document tier cannot drift on the
      // host-namespacing rule -- see the contract on cacheKeyBase.
      // The keyGenerator branch is left untouched: a consumer-supplied generator
      // owns its own namespacing (auto-prefixing host would silently change their
      // existing keys and double any host they already include).
      const cacheKey = keyGenerator
        ? keyGenerator(url) + segmentHash + fragmentSuffix + typeSuffix
        : requestKeyBase(
            requestCtx,
            url.host,
            url.pathname,
            url.searchParams,
            undefined,
            requestCtx?._searchParamsFilter,
          ) +
          segmentHash +
          fragmentSuffix +
          typeSuffix;
      // 1. Check cache
      // Recovery must reach CacheScope's server decoder so it can evict the bad
      // segment. Treat it as a miss, then let the ordinary write path replace
      // the corrupt fragment-capable response with the valid fallback bytes.
      // A router.prerender() warm is a miss too: it renders and replaces.
      const cached =
        isFragmentRecovery || isWarmReplace(requestCtx)
          ? null
          : await store.getResponse(cacheKey);
      // Every path past the lookup either returns a fresh HIT, which renders
      // nothing, or renders a response this cache may store.
      requestCtx._documentCacheRender = true;

      if (cached && cached.response.status === 200) {
        if (!cached.shouldRevalidate) {
          // Fresh hit - return immediately
          log(`[DocumentCache] HIT ${typeLabel}: ${url.pathname}`);
          return drainOnResponseCallbacks(
            addCacheStatusHeader(cached.response, "HIT"),
            requestCtx,
          );
        }

        // Stale hit - return cached response, revalidate in background
        log(
          `[DocumentCache] STALE ${typeLabel}: ${url.pathname} (revalidating)`,
        );

        runBackground(requestCtx, async () => {
          try {
            // Re-establish the request-context ALS around the whole background
            // task: next() re-runs the full handler pipeline, and on workerd a
            // waitUntil task runs detached from the request's I/O context, so a
            // handler/component reading getRequestContext() would otherwise
            // throw. Same fix as the route-level/use-cache background
            // revalidation paths. The rango.background span (kind=
            // document-revalidation) wraps the re-render AND the store write so
            // the task's spans — the re-run's own rango.* set and the drain/put
            // platform spans — nest under one explanatory parent instead of
            // dangling under the ended foreground phases. Running the put
            // inside the ALS matches the MISS path, where putResponse already
            // executes within the foreground request context.
            await runWithRequestContext(requestCtx, () =>
              observePhase(
                PHASES.background("document-revalidation"),
                async () => {
                  const fresh = await next();
                  const directives = shouldCacheResponse(fresh, requestCtx);

                  if (!directives || !fresh.body) return;

                  // Background revalidation: nothing streams to a client, so
                  // drain the fresh render fully before snapshotting tags
                  // (same render-complete barrier as the miss path).
                  const body = await new Response(fresh.body).arrayBuffer();
                  throwIfRenderErrored(requestCtx);
                  // Not written when one of its tags was invalidated since
                  // the render started (#977).
                  const tags = collectRequestTags(requestCtx);
                  if (await predatesInvalidation(store, tags, start)) return;
                  await store.putResponse!(
                    cacheKey,
                    markResponseStart(new Response(body, fresh), start),
                    directives.sMaxAge!,
                    directives.staleWhileRevalidate,
                    tags,
                  );
                  noteWarmWrite(requestCtx, "response");
                  noteWarmDocument(requestCtx, "stored");
                  log(
                    `[DocumentCache] REVALIDATED ${typeLabel}: ${url.pathname}`,
                  );
                },
              ),
            );
          } catch (error) {
            // The route now rewrites (route middleware): nothing to refresh
            // this entry with.
            if (isRewrite(error)) return;
            // Pass requestCtx explicitly: this runs in a detached waitUntil task
            // where the ALS context is gone, so onError only fires if we hand it
            // the captured context (reportCacheError falls back to _getRequestContext
            // otherwise, which is null here).
            reportCacheError(
              error,
              "cache-write",
              "[DocumentCache] revalidation",
              requestCtx,
            );
          }
        });

        return drainOnResponseCallbacks(
          addCacheStatusHeader(cached.response, "STALE"),
          requestCtx,
        );
      }

      // 2. Cache miss - run handler
      handlerCalled = true;
      const originalResponse = await next();

      // 3. Cache if response has appropriate headers
      const directives = shouldCacheResponse(originalResponse, requestCtx);

      if (directives) {
        log(
          `[DocumentCache] MISS ${typeLabel}: ${url.pathname} (caching with s-maxage=${directives.sMaxAge})`,
        );

        // If the response has no body (e.g., 200 with empty body), skip caching
        if (!originalResponse.body) {
          return originalResponse;
        }

        // Tee the body so we can return one stream and cache the other
        const [returnStream, cacheStream] = originalResponse.body.tee();

        // Clone response for caching (non-blocking)
        runBackground(requestCtx, async () => {
          try {
            // Drain the cache copy fully BEFORE snapshotting tags. Tags from
            // Suspense-streamed "use cache"/cacheTag and loaders are recorded as
            // each value resolves during the RSC/HTML render, which completes
            // only when the stream ends - the handler-settlement barrier is too
            // early. Buffering the body (the client streams the other tee branch,
            // unaffected) is the render-complete barrier that keeps the cached
            // body and its tag set consistent.
            const body = await new Response(cacheStream).arrayBuffer();
            throwIfRenderErrored(requestCtx);
            // Not written when one of its tags was invalidated since the
            // render started (#977).
            const tags = collectRequestTags(requestCtx);
            if (await predatesInvalidation(store, tags, start)) return;
            await store.putResponse!(
              cacheKey,
              markResponseStart(new Response(body, originalResponse), start),
              directives.sMaxAge!,
              directives.staleWhileRevalidate,
              tags,
            );
            noteWarmWrite(requestCtx, "response");
            noteWarmDocument(requestCtx, "stored");
          } catch (error) {
            // Detached waitUntil task — pass the captured requestCtx so onError
            // fires even though the ALS context is gone (see the revalidation
            // catch above).
            reportCacheError(
              error,
              "cache-write",
              "[DocumentCache] cache write",
              requestCtx,
            );
          }
        });

        return addCacheStatusHeader(
          new Response(returnStream, originalResponse),
          "MISS",
        );
      }

      // No cache headers - pass through
      noteWarmDocument(requestCtx, "not-cacheable");
      return originalResponse;
    } catch (error) {
      // A rewrite() thrown downstream re-dispatches the request.
      if (isRewrite(error)) throw error;
      reportCacheError(error, "cache-read", "[DocumentCache] middleware");
      if (handlerCalled) {
        // Post-handler failure (e.g. body.tee()): do not call next() again
        // as that would re-run handler side effects.
        throw error;
      }
      // Pre-handler failure (cache lookup): degrade gracefully to origin
      return next();
    }
  };
}
