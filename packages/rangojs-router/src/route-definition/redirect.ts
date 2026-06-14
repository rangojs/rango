import type { LocationStateEntry } from "../browser/react/location-state-shared.js";
import {
  requireRequestContext,
  getRequestContext,
  _getRequestContext,
} from "../server/request-context.js";
import { EXTERNAL_REDIRECT_MARKER } from "../redirect-origin.js";

/**
 * Create a soft redirect Response for middleware short-circuit
 *
 * Returns a Response that signals a client-side navigation to the target URL.
 * Unlike Response.redirect() which causes a full page reload, this redirect
 * is handled by the router for SPA-style navigation.
 *
 * Supports an optional state parameter to carry location state through the
 * redirect. On the target page, state can be read via useLocationState()
 * (use { flash: true } in createLocationState for read-once flash messages).
 *
 * @param url - The URL to redirect to
 * @param statusOrOptions - HTTP status code (default: 302) or options object
 *
 * @example
 * ```typescript
 * // Simple redirect
 * middleware((ctx, next) => {
 *   if (!ctx.get('user')) {
 *     return redirect('/login');
 *   }
 *   next();
 * })
 *
 * // Redirect with state
 * return redirect('/dashboard', {
 *   state: [Flash({ text: "Item saved!" })],
 * });
 *
 * // Redirect with custom status and state
 * return redirect('/login', {
 *   status: 303,
 *   state: [Flash({ text: "Session expired" })],
 * });
 *
 * // Off-host redirect (opt out of the same-origin guard). Without
 * // `external: true`, a cross-origin target is blocked and replaced with the
 * // app root, matching the client's open-redirect protection.
 * return redirect('https://accounts.example.com/oauth', { external: true });
 * ```
 */
export function redirect(url: string, status?: number): Response;
export function redirect(
  url: string,
  options: {
    status?: number;
    state?: LocationStateEntry | LocationStateEntry[];
    external?: boolean;
  },
): Response;
export function redirect(
  url: string,
  statusOrOptions?:
    | number
    | {
        status?: number;
        state?: LocationStateEntry | LocationStateEntry[];
        external?: boolean;
      },
): Response {
  const status =
    typeof statusOrOptions === "number"
      ? statusOrOptions
      : (statusOrOptions?.status ?? 302);
  const state =
    typeof statusOrOptions === "object" ? statusOrOptions?.state : undefined;
  const external =
    typeof statusOrOptions === "object" ? statusOrOptions?.external : undefined;

  if (state) {
    const ctx = requireRequestContext();
    ctx.setLocationState(state);

    if (process.env.NODE_ENV !== "production") {
      const reqCtx = getRequestContext();
      // Warn only on true full-page SSR loads. SPA partial requests and server
      // actions both deliver state through Flight payloads, so suppress for those.
      if (
        reqCtx &&
        !reqCtx.originalUrl.searchParams.has("_rsc_partial") &&
        !reqCtx.request.headers.has("rsc-action") &&
        !reqCtx.originalUrl.searchParams.has("_rsc_action")
      ) {
        console.warn(
          `[Router] redirect() with state during a full-page (SSR) request to "${url}". ` +
            "Location state is only delivered during SPA navigations and will be lost on this request.",
        );
      }
    }
  }

  // Auto-prefix root-relative URLs with basename for app-local redirects.
  // Treat the URL as already-prefixed when the basename is followed by a path
  // separator, a query, a fragment, or end-of-string, so "/admin?tab=x" and
  // "/admin#frag" are not double-prefixed into "/admin/admin?tab=x".
  const bn = _getRequestContext()?._basename;
  let resolvedUrl = url;
  if (
    bn &&
    url.startsWith("/") &&
    url !== bn &&
    !url.startsWith(bn + "/") &&
    !url.startsWith(bn + "?") &&
    !url.startsWith(bn + "#")
  ) {
    resolvedUrl = url === "/" ? bn : bn + url;
  }

  const headers: Record<string, string> = {
    Location: resolvedUrl,
    "X-RSC-Redirect": "soft",
  };
  // Mark an explicit off-host redirect so the same-origin guard
  // (rsc/redirect-guard.ts) lets it through. The marker is internal and is
  // stripped before the response leaves the server.
  if (external) {
    headers[EXTERNAL_REDIRECT_MARKER] = "1";
  }

  return new Response(null, { status, headers });
}
