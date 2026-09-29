/**
 * Full (initial-load / document) RSC payload builder.
 *
 * Extracted from rsc-rendering.ts so both the foreground render AND the PPR
 * background shell capture (shell-capture.ts) build the SAME payload shape over
 * their own handle store. `resume` requires the captured tree to match the served
 * tree; building an identical payload over the same replayed segments is what
 * makes that hold. Keep this byte-identical to the normal full-render path.
 */

import type { MatchResult } from "../types.js";
import type { RscPayload } from "./types.js";
import type { HandlerContext } from "./handler-context.js";
import type { RequestContext } from "../server/request-context.js";
import type { HandleStore } from "../server/handle-store.js";
import type { Theme } from "../theme/types.js";
import { gateTransitions } from "./transition-gate.js";
import { resolvedHandleStream } from "../handles/deferred-resolution.js";

/**
 * Build the metadata payload for a full (non-partial) document render.
 *
 * @param handleStore - the store whose resolved handle stream feeds the payload;
 *   the foreground passes reqCtx's store, the background capture passes its fresh
 *   derived-context store.
 */
export function buildFullPayload(
  m: MatchResult,
  // env is opaque here (the payload never reads it); `any` avoids the invariance
  // friction of HandlerContext<TEnv> vs the ambient RequestContext env at the two
  // call sites (foreground render + background capture).
  ctx: HandlerContext<any>,
  url: URL,
  reqCtx: RequestContext<any>,
  handleStore: HandleStore,
): RscPayload {
  return {
    metadata: {
      pathname: url.pathname,
      routerId: ctx.router.id,
      basename: ctx.router.basename,
      segments: gateTransitions(m.segments, reqCtx, ctx.router.onError),
      matched: m.matched,
      diff: m.diff,
      resolvedIds: m.resolvedIds,
      params: m.params,
      isPartial: false,
      interceptTargets: m.interceptTargets,
      rootLayout: ctx.router.rootLayout,
      // Full render: resolve deferred handle values server-side so SSR markup and
      // the first sync useHandle read see resolved values. Partial payloads
      // (rsc-rendering.ts) keep streaming (handleStore.stream()).
      handles: resolvedHandleStream(handleStore),
      // Post-handler-barrier pushes (streaming loader ctx.handle() writes)
      // stream here; the client applies them after hydration. Instantly
      // complete when the loader lane is idle — including PPR shell capture,
      // where masked loaders never run.
      handlesLate: handleStore.streamLate(),
      version: ctx.version,
      prefetchCacheTTL: ctx.router.prefetchCacheTTL,
      prefetchCacheSize: ctx.router.prefetchCacheSize,
      prefetchConcurrency: ctx.router.prefetchConcurrency,
      defaultPrefetch: ctx.router.defaultPrefetch,
      stateCookieName: ctx.router.resolvedStateCookieName,
      themeConfig: ctx.router.themeConfig,
      // Carry warmupEnabled on the initial full-render payload so the client
      // respects warmup:false from first load. The 404 and PE payloads already
      // include it; without it here warmup could never be disabled on the
      // normal full-load path (partial payloads omit it by design).
      warmupEnabled: ctx.router.warmupEnabled,
      // Carry strictMode on the initial full-render payload so the browser
      // entry knows whether to wrap hydration in React.StrictMode. Partial
      // (navigation) payloads omit it by design; StrictMode is decided once.
      strictMode: ctx.router.strictMode,
      initialTheme: payloadInitialTheme(reqCtx),
    },
  };
}

/**
 * The theme a document payload carries as `metadata.initialTheme` (the
 * ThemeProvider's first state), read with no identity guard: it is the
 * router's own read, not handler code (#971).
 *
 * A shell capture carries the no-cookie default, not the capturing visitor's
 * theme. The shell and its ShellCacheEntry.initialTheme serve every visitor,
 * and ThemeProvider re-syncs only from an explicitly stored theme, so a
 * visitor with none kept the capturer's `useTheme().theme` for the page's
 * lifetime. A visitor with a stored theme gets it pre-paint (theme script)
 * and in the provider after mount.
 */
export function payloadInitialTheme(
  reqCtx: Pick<
    RequestContext<any>,
    "_themeConfig" | "_shellCaptureRun" | "_readTheme"
  >,
): Theme | undefined {
  const config = reqCtx._themeConfig;
  if (!config) return undefined;
  return reqCtx._shellCaptureRun ? config.defaultTheme : reqCtx._readTheme();
}
