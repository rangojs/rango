/**
 * Server-side open-redirect guard.
 *
 * Applied to the FINAL handler response (the single top-level return in
 * `handler.ts`) so every browser-followed redirect honors the same same-origin
 * rule the client enforces (`browser/validate-redirect-origin.ts`), via the one
 * shared resolver in `redirect-origin.ts`. This is the server half of the
 * client's existing guard: the client can only validate redirects its own JS
 * navigates to (the SPA/fetch channel), so document-native redirects -- a no-JS
 * PE form POST, a full-page GET `match.redirect`, a middleware `redirect()`
 * short-circuit, a response-route 3xx -- reach the browser with no client in the
 * loop. They all funnel through one handler return, so guarding there covers
 * every one and any future redirect exit.
 *
 * Soft (SPA/Flight) redirects are 200/204 responses (`X-RSC-Redirect` header or
 * `metadata.redirect` payload) and are NOT redirect Responses, so they never
 * reach this guard -- they stay validated client-side.
 *
 * Behavior on a `Location` header:
 * - same-origin / relative  -> passes through unchanged
 * - `redirect(url, { external: true })` (marker present) -> marker stripped, the
 *   off-host target is allowed (explicit, auditable opt-in)
 * - cross-origin without the marker -> Location rewritten to the basename root
 *   (a safe same-origin landing, the document analog of the client's "stay put");
 *   dev logs the blocked target and points to `{ external: true }`.
 */

import { isRedirectResponse } from "../response-utils.js";
import {
  resolveSameOriginRedirect,
  EXTERNAL_REDIRECT_MARKER,
} from "../redirect-origin.js";
import { carryOverRedirectHeaders } from "./helpers.js";

export function guardOutgoingRedirect(
  response: Response,
  requestOrigin: string,
  basename: string | undefined,
): Response {
  // Only 3xx + Location responses (document-native redirects) are guarded.
  if (!isRedirectResponse(response)) {
    return response;
  }

  // Explicit opt-in via redirect(url, { external: true }): strip the internal
  // marker and let the off-host target through.
  if (response.headers.get(EXTERNAL_REDIRECT_MARKER) !== null) {
    try {
      response.headers.delete(EXTERNAL_REDIRECT_MARKER);
    } catch {
      // Some platform responses carry immutable headers. The marker is internal
      // and inert on the browser, so a failed strip is harmless.
    }
    return response;
  }

  // isRedirectResponse guarantees a truthy Location.
  const location = response.headers.get("Location")!;
  if (resolveSameOriginRedirect(location, requestOrigin) !== null) {
    return response;
  }

  // Cross-origin without opt-in: neutralize to a safe same-origin landing.
  const safeTarget = basename && basename !== "/" ? basename : "/";
  if (process.env.NODE_ENV !== "production") {
    console.error(
      `[rango] Blocked cross-origin redirect to "${location}"; sent to ` +
        `"${safeTarget}" instead. To redirect off-host on purpose, use ` +
        `redirect(url, { external: true }).`,
    );
  }

  const blocked = new Response(null, {
    status: response.status,
    headers: { Location: safeTarget },
  });
  // Preserve cookies and any other headers (Set-Cookie, Server-Timing, ...);
  // carryOverRedirectHeaders intentionally skips Location.
  carryOverRedirectHeaders(response, blocked);
  return blocked;
}
