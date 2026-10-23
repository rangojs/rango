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
import {
  pathKey,
  rendersForSharedAudience,
  rewriteTrail,
  visitorUrl,
} from "../server/rewrite-trail.js";
import { attachTransitionWhen } from "./attach-transition-when.js";
import { publicRouteName } from "../route-name.js";
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
      ...payloadLocation(reqCtx, url),
      routerId: ctx.router.id,
      basename: ctx.router.basename,
      segments: attachTransitionWhen(m.segments, reqCtx),
      matched: m.matched,
      diff: m.diff,
      resolvedIds: m.resolvedIds,
      params: m.params,
      routeName: publicRouteName(m.routeName),
      isPartial: false,
      interceptTargets: m.interceptTargets,
      rootLayout: ctx.router.rootLayout,
      // Full render: resolve deferred handle values server-side so SSR markup and
      // the first sync useHandle read see resolved values. Partial payloads
      // (rsc-rendering.ts) keep streaming (handleStore.stream()). A shell
      // capture renders from what its record keeps (resolvedHandleStream).
      handles: resolvedHandleStream(
        handleStore,
        reqCtx._shellCaptureState?.run === true,
      ),
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
 * The URL a render shows as the page's location (payload `pathname`, the SSR
 * search and origin seed). For a request middleware rewrote, the visitor's
 * URL, so the server markup and the hydrating client (which reads the address
 * bar) agree on `usePathname()` and `useSearchParams()`. A render other
 * visitors may be served shows `url`, the target, as a direct visit does: a
 * shell capture, and a render the document cache stores (its key is the
 * target), except a visitor-keyed shell capture, whose key covers the
 * visitor's URL. Any other render that shows the visitor's URL marks
 * `_payloadVisitorLocation`, and the document cache does not store it.
 */
export function renderedLocation(
  reqCtx:
    | Pick<
        RequestContext<any>,
        | "_variables"
        | "_shellCaptureState"
        | "_documentCacheRender"
        | "_payloadVisitorLocation"
        | "res"
      >
    | undefined,
  url: URL,
): URL {
  if (!reqCtx || !rewriteTrail(reqCtx)) return url;
  if (rendersForSharedAudience(reqCtx)) {
    return reqCtx._shellCaptureState?.forVisitor
      ? visitorUrl(reqCtx, url)
      : url;
  }
  reqCtx._payloadVisitorLocation = true;
  return visitorUrl(reqCtx, url);
}

/**
 * A payload's `pathname` (renderedLocation) and, when middleware rewrote the
 * request, `rewriteTarget`: the path and search the route rendered (the
 * trail's last URL). The browser keeps it per history entry and sends it
 * back as `_rsc_rt`, so the next request from the page diffs against the
 * route that rendered it (navigation-snapshot.ts resolveNavigation, #1144).
 */
export function payloadLocation(
  reqCtx: Parameters<typeof renderedLocation>[0],
  url: URL,
): { pathname: string; rewriteTarget?: string } {
  const pathname = renderedLocation(reqCtx, url).pathname;
  const trail = rewriteTrail(reqCtx);
  return trail
    ? { pathname, rewriteTarget: pathKey(new URL(trail[trail.length - 1]!)) }
    : { pathname };
}

/**
 * The theme a document payload carries as `metadata.initialTheme` (the
 * ThemeProvider's first state), read with no identity guard: it is the
 * router's own read, not handler code (#971).
 *
 * A render other visitors may be served carries the no-cookie default, not
 * the rendering visitor's theme: a shell capture, and a render the document
 * cache runs whose response opted in before next() (documentCacheStoresRender,
 * #978). The shell, its ShellCacheEntry.initialTheme and the stored document
 * serve every visitor, and ThemeProvider re-syncs only from an explicitly
 * stored theme, so a visitor with none kept the first visitor's
 * `useTheme().theme` for the page's lifetime. A visitor with a stored theme
 * gets it pre-paint (theme script) and in the provider after mount.
 *
 * Any other render carries the visitor's theme (the unmatched-route 404 reads
 * it without this function, rsc/handler.ts); when that differs from the
 * default it marks `_payloadVisitorTheme`, and the document cache does not
 * store the response.
 */
export function payloadInitialTheme(
  reqCtx: Pick<
    RequestContext<any>,
    | "_themeConfig"
    | "_shellCaptureState"
    | "_readTheme"
    | "_documentCacheRender"
    | "_payloadVisitorTheme"
    | "res"
  >,
): Theme | undefined {
  const config = reqCtx._themeConfig;
  if (!config) return undefined;
  if (rendersForSharedAudience(reqCtx)) return config.defaultTheme;
  const theme = reqCtx._readTheme();
  if (theme !== config.defaultTheme) reqCtx._payloadVisitorTheme = true;
  return theme;
}
