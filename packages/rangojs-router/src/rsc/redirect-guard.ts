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
 * reach this guard. They are resolved at construction time via
 * `resolveSoftRedirectUrl` (same shared rules) so unsafe targets never leave
 * the server; client validators remain defense-in-depth.
 *
 * Behavior on a `Location` header:
 * - same-origin / relative  -> passes through unchanged
 * - `redirect(url, { external: true })` (out-of-band brand present) and an
 *   http(s) target -> allowed (explicit, auditable, unforgeable opt-in)
 * - branded but a non-http(s) target (e.g. `javascript:`) -> neutralized: the
 *   opt-in waives the same-origin rule, NOT scheme safety
 * - cross-origin without the brand -> Location rewritten to the basename root
 *   (a safe same-origin landing, the document analog of the client's "stay put");
 *   dev logs the blocked target and points to `{ external: true }`.
 *
 * The opt-in is an out-of-band brand on the Response object (isExternalRedirect),
 * never a wire header: a header is forgeable by an attacker-controlled upstream
 * response a proxy-style response route copies through, which would defeat the
 * guard without app code ever opting in. The reserved header name is stripped
 * defensively so a forged value can never reach the browser.
 */

import { isRedirectResponse } from "../response-utils.js";
import {
  resolveSameOriginRedirect,
  resolveExternalRedirect,
  isExternalRedirect,
  safeSameOriginLanding,
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

  // The reserved marker is never a trust signal. Strip any value -- forged by a
  // proxied upstream or otherwise -- so it can never reach the browser. Trust
  // comes solely from the out-of-band brand below.
  try {
    response.headers.delete(EXTERNAL_REDIRECT_MARKER);
  } catch {
    // Some platform responses carry immutable headers; the header is inert on
    // the browser, so a failed strip is harmless.
  }

  // isRedirectResponse guarantees a truthy Location.
  const location = response.headers.get("Location")!;

  // Explicit opt-in via redirect(url, { external: true }): allow an off-host
  // target, but only an http(s) one. external waives the same-origin rule, not
  // scheme safety -- a branded javascript:/data: target falls through to be
  // neutralized so it can never become a scriptable navigation downstream.
  if (isExternalRedirect(response)) {
    if (resolveExternalRedirect(location, requestOrigin) !== null) {
      return response;
    }
  } else if (resolveSameOriginRedirect(location, requestOrigin) !== null) {
    return response;
  }

  // Cross-origin (or unsafe-scheme external): neutralize to a safe same-origin
  // landing.
  const safeTarget = safeSameOriginLanding(basename);
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
