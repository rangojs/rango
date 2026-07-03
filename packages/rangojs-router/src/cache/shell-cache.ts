/**
 * PPR Shell Cache Middleware
 *
 * Axis 2 of the two-axis render model (see docs/design/ppr-shell-resume.md).
 * Opt-in middleware that caches the rendered HTML *shell* (React's `prelude`
 * plus the `postponed` state from a static `prerender` abort) and, on a later
 * request, serves those bytes immediately and resumes fizz for just the live
 * holes. The browser sees one ordinary streamed document.
 *
 * The middleware owns only the cheap URL/method gating and the stream
 * composition. The RENDER layer (rsc-rendering, integrated by a later stage) is
 * the final authority on whether a resume actually happens: it reads
 * requestCtx._shellResume, calls the resume strategy, and marks the response
 * with the internal `x-rango-shell-resumed` header ONLY when it truly resumed.
 * This middleware composes the cached prelude in front of the live response ONLY
 * when that marker is present; everything else (redirects, 404s, error renders,
 * nonce/allReady bypasses) flows through untouched — every non-resumed path
 * fails open to axis 1.
 *
 * Flow (the middleware calls next() EXACTLY ONCE on every path — the executor's
 * per-entry next() is a single-use latch, so a second call throws):
 * 1. Bypass matrix (non-GET, _rsc_* params, RSC request, skipPaths, isEnabled,
 *    store lacks the shell family) → plain next(), axis 1.
 * 2. getShell(key) HIT + reactVersion matches → arm _shellResume, await next()
 *    once. On a stale (SWR) hit, ALSO set the _shellCapture descriptor before
 *    that same next() so the render layer schedules a background recapture.
 *    - marker present → strip it, prepend prelude bytes, x-rango-shell: HIT.
 *    - marker absent → render layer did not resume; return untouched.
 * 3. MISS (or reactVersion mismatch) → set the _shellCapture descriptor before
 *    the single next(), stream the live response to the user with
 *    x-rango-shell: MISS. The render layer reads the descriptor after building the
 *    response and schedules a BACKGROUND capture (via router.match under a derived
 *    context — NOT a second next()); see rsc-rendering.ts + shell-capture.ts.
 * The descriptor is cleared in a finally so it never leaks into a reused ctx.
 */

import React from "react";
import type { MiddlewareFn, MiddlewareContext } from "../router/middleware.js";
import {
  getRequestContext,
  type RequestContext,
} from "../server/request-context.js";
import { mayNeedSSR } from "../rsc/ssr-setup.js";
import type { SegmentCacheStore } from "./types.js";
import { sortedSearchString } from "./cache-key-utils.js";
import { reportCacheError } from "./cache-error.js";

/** Debug/status header the browser (and e2e assertions) can read: HIT | MISS. */
const SHELL_STATUS_HEADER = "x-rango-shell";

/**
 * Internal marker the render layer sets on the live response when — and only
 * when — it actually resumed a cached shell. The middleware composes the prelude
 * in front of the body iff this header is present, then strips it before the
 * response leaves. It is the whole handshake between the middleware (which arms
 * _shellResume optimistically) and the render layer (the final authority).
 */
const SHELL_RESUMED_MARKER_HEADER = "x-rango-shell-resumed";

/**
 * React version captured at prerender time is the invalidation gate: a stored
 * shell whose reactVersion differs from the running React cannot be resumed (the
 * postponed blob is build-coupled), so it is treated as a miss. Read once at
 * module load — React.version is stable for the process lifetime.
 */
const REACT_VERSION = React.version;

/** Decode a base64 prelude back into bytes for stream composition. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Compose the served response: prelude bytes first, then the live (resumed) body.
 * React relies on HTML-parser foster-parenting for content streamed after the
 * prelude's closing `</body></html>`, so plain byte concatenation is the correct
 * composition (POC item 6) — do not try to reopen or splice the document.
 *
 * Status and headers come from the LIVE next() response: Set-Cookie and friends
 * are per-request and belong to the live pass, not the frozen shell. The internal
 * marker is stripped and x-rango-shell: HIT is added.
 */
function composeShellResponse(
  response: Response,
  preludeBase64: string,
): Response {
  const preludeBytes = base64ToBytes(preludeBase64);
  const body = response.body;
  const composed = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(preludeBytes);
      if (body) {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      controller.close();
    },
    cancel(reason) {
      // Propagate downstream cancellation to the live body so it does not leak.
      return body?.cancel(reason);
    },
  });

  const headers = new Headers(response.headers);
  headers.delete(SHELL_RESUMED_MARKER_HEADER);
  headers.set(SHELL_STATUS_HEADER, "HIT");
  return new Response(composed, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Clone a response with the x-rango-shell status header added. */
function withShellStatus(response: Response, status: "HIT" | "MISS"): Response {
  const headers = new Headers(response.headers);
  headers.set(SHELL_STATUS_HEADER, status);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Options for the PPR shell-cache middleware.
 */
export interface ShellCacheOptions<TEnv = any> {
  /**
   * Cache store to use. Defaults to the request context's `_cacheStore`
   * (the app-level store wired via the router's cache config).
   */
  store?: SegmentCacheStore<TEnv>;

  /**
   * Shell time-to-live in seconds. Defaults to 300.
   */
  ttlSeconds?: number;

  /**
   * Stale-while-revalidate window in seconds. On a stale hit the cached shell is
   * still served and a background recapture is scheduled.
   */
  swrSeconds?: number;

  /**
   * Custom cache key generator. Receives the cleaned request URL. The middleware
   * appends its own `:shell` namespace suffix, so the returned key never collides
   * with a document-cache key.
   *
   * A custom generator owns the FULL key identity, including host scoping: the
   * default key incorporates `url.host` so shells can never leak across tenants
   * in multi-host deployments — include it in custom keys too unless the store
   * is provably single-host.
   */
  keyGenerator?: (url: URL) => string;

  /**
   * Callback to decide whether shell caching is enabled for this request.
   * Return false to fall through to a normal HTML render (axis 1).
   */
  isEnabled?: (ctx: MiddlewareContext<TEnv>) => boolean | Promise<boolean>;

  /**
   * Skip shell caching for specific path prefixes (e.g. admin, API routes).
   */
  skipPaths?: string[];

  /**
   * Enable debug logging for shell cache operations (HIT / MISS / CAPTURED).
   * Defaults to false.
   */
  debug?: boolean;
}

/**
 * Create the PPR shell-cache middleware.
 *
 * Add it to a router (or a route subtree) to cache the HTML shell and resume
 * fizz for just the live holes on subsequent requests. Personalization must live
 * in loaders/holes — the shell is shared per URL key (the shell-manifest
 * pattern). Actions, progressive enhancement, formState, and per-request nonce
 * always take axis 1.
 *
 * @example
 * ```typescript
 * const router = createRouter<AppEnv>()
 *   .use(createShellCacheMiddleware({ ttlSeconds: 600, swrSeconds: 60 }))
 *   .route("home", (ctx) => <HomePage />);
 * ```
 */
export function createShellCacheMiddleware<TEnv = any>(
  options: ShellCacheOptions<TEnv> = {},
): MiddlewareFn<TEnv> {
  const {
    ttlSeconds = 300,
    swrSeconds,
    keyGenerator,
    isEnabled,
    skipPaths = [],
    debug = false,
  } = options;

  const log = debug ? (message: string) => console.log(message) : () => {};

  return async function shellCacheMiddleware(
    ctx: MiddlewareContext<TEnv>,
    next: () => Promise<Response>,
  ): Promise<Response> {
    const url = ctx.url;
    // ctx.url is stripped of _rsc_* params by the pipeline (stripInternalParams);
    // read the raw request URL for internal-param detection, like document-cache.
    const rawUrl = new URL(ctx.request.url);

    // --- Bypass matrix (each bypass = plain next(), axis 1) ---

    // Mutations are dynamic — never resume/capture a shell for them.
    if (ctx.request.method !== "GET") return next();
    // RSC action / loader / partial requests are not HTML document requests.
    if (rawUrl.searchParams.has("_rsc_action")) return next();
    if (rawUrl.searchParams.has("_rsc_loader")) return next();
    if (rawUrl.searchParams.has("_rsc_partial")) return next();
    // RSC (Flight) request — the Flight path is untouched by PPR.
    if (!mayNeedSSR(ctx.request, rawUrl)) return next();
    // Consumer opt-outs.
    if (skipPaths.some((path) => url.pathname.startsWith(path))) return next();
    if (isEnabled) {
      const enabled = await isEnabled(ctx);
      if (!enabled) return next();
    }

    const requestCtx = getRequestContext();
    const store = options.store ?? requestCtx?._cacheStore;

    // Store must implement the shell family — otherwise fail open to axis 1.
    if (!store?.getShell || !store?.putShell) return next();

    // Track whether next() has been called so the catch block knows whether it is
    // safe to fall through to the handler (mirrors document-cache). cacheKey is
    // assigned inside the try (a throwing keyGenerator must degrade, not 500).
    let handlerCalled = false;
    let cacheKey = "";

    /**
     * Build the "capture wanted" descriptor. Set on the request context BEFORE
     * the single next() so the render layer can read it after building the
     * response and schedule the background capture (via router.match under a
     * derived context — NOT a second next()). `store` is the SAME store this
     * middleware resolved for getShell, so a store-attached middleware writes
     * captures where it reads them. `tags` is intentionally omitted: the capture
     * collects the shell's own non-loader tags from its derived render.
     */
    const captureDescriptor = (): NonNullable<
      RequestContext["_shellCapture"]
    > => ({
      key: cacheKey,
      ttl: ttlSeconds,
      swr: swrSeconds,
      store,
    });

    try {
      // Namespace the key with a `:shell` suffix (mirrors document-cache's
      // `:html`/`:rsc` suffix) so it can never collide with a document-cache key;
      // the store further isolates the shell family internally. Built inside the
      // try so a throwing keyGenerator degrades to a full render, not a 500.
      //
      // The default key includes the request HOST: in a multi-tenant host-router
      // deployment (one worker, one shared KV/runtime-cache store) a host-less
      // key would serve tenant A's captured shell to tenant B's users. The CF
      // document family fixed this exact class at the store tier (toDocKVHost);
      // the shell family fixes it at the key tier so every store is safe.
      let searchSuffix = "";
      if (!keyGenerator) {
        const sorted = sortedSearchString(url.searchParams);
        if (sorted) searchSuffix = `?${sorted}`;
      }
      cacheKey = keyGenerator
        ? `${keyGenerator(url)}:shell`
        : `${url.host}${url.pathname}${searchSuffix}:shell`;

      const cached = await store.getShell(cacheKey);
      const validHit =
        cached != null && cached.entry.reactVersion === REACT_VERSION;

      if (cached && !validHit) {
        // reactVersion mismatch: the postponed blob is build-coupled and cannot
        // be resumed by the running React. There is no deleteShell primitive in
        // v1, so we simply treat it as a MISS — the recapture below overwrites
        // the same key, and the entry otherwise ages out via TTL.
        log(
          `[ShellCache] MISS ${url.pathname} (reactVersion ${cached.entry.reactVersion} != ${REACT_VERSION})`,
        );
      }

      if (validHit) {
        // Arm the resume optimistically. The render layer is the final authority
        // (nonce/formState/allReady bypass); it engages resume and marks the
        // response only when it actually resumed.
        if (requestCtx) {
          requestCtx._shellResume = { postponed: cached!.entry.postponed };
          // SWR: on a stale hit, also request a background recapture by setting
          // the descriptor before this single next(). Resume (foreground) and
          // capture-request (background) legitimately coexist now — the render
          // layer schedules the recapture off the descriptor after building the
          // resumed response. A fresh hit leaves the descriptor unset.
          if (cached!.shouldRevalidate) {
            requestCtx._shellCapture = captureDescriptor();
          }
        }
        handlerCalled = true;
        let response: Response;
        try {
          response = await next();
        } finally {
          // Always disarm both single-request flags. A next() throw here (resume
          // failure) propagates to the outer catch and rethrows; the
          // version-keyed entry self-heals via axis 1 + recapture on the next
          // request (v1 has no deleteShell to eagerly remove it).
          if (requestCtx) {
            requestCtx._shellResume = undefined;
            requestCtx._shellCapture = undefined;
          }
        }

        if (response.headers.has(SHELL_RESUMED_MARKER_HEADER)) {
          log(`[ShellCache] HIT ${url.pathname}`);
          return composeShellResponse(response, cached!.entry.prelude);
        }

        // Marker absent: the render layer did NOT resume (redirect, 404, error
        // render, per-request nonce, or allReady buffering). Fail open to axis 1
        // — return the live response untouched. Note: no manual onResponse-
        // callback drain is needed here (or on any path in this middleware),
        // because every path runs a full next() pipeline pass, which already
        // drains those callbacks — unlike document-cache, which serves a fully
        // cached response bypassing next() and must drain them itself.
        log(`[ShellCache] PASS ${url.pathname} (resume not engaged)`);
        return response;
      }

      // --- MISS (no entry, or reactVersion mismatch) ---
      // Set the "capture wanted" descriptor before the single next(). The render
      // layer reads it after building the response and, if the response is a
      // servable 200 HTML document, schedules a BACKGROUND capture (router.match
      // under a derived context — never a second next()). The descriptor's mere
      // presence does not change the foreground render (loader masking keys off
      // _shellCaptureRun, which only the background derived context sets).
      if (requestCtx) requestCtx._shellCapture = captureDescriptor();
      handlerCalled = true;
      let response: Response;
      try {
        response = await next();
      } finally {
        // Clear the descriptor so it never leaks into a reused ctx. The render
        // layer already read it (synchronously, inside next()) and captured its
        // own reference for the background task, so clearing here is safe.
        if (requestCtx) requestCtx._shellCapture = undefined;
      }

      log(`[ShellCache] MISS ${url.pathname}`);
      return withShellStatus(response, "MISS");
    } catch (error) {
      reportCacheError(error, "cache-read", "[ShellCache] middleware");
      if (handlerCalled) {
        // Post-handler failure (resume/render throw, or a stream error): do not
        // call next() again — that would re-run handler side effects.
        throw error;
      }
      // Pre-handler failure (cache lookup / key generation): degrade to a full
      // render.
      return next();
    }
  };
}
