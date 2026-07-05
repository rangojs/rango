/**
 * Runtime-neutral same-origin redirect rule.
 *
 * Shared by the client redirect guard (`browser/validate-redirect-origin.ts`,
 * which validates redirect targets the client JS is about to navigate to) and
 * the server outgoing-redirect guard (`rsc/redirect-guard.ts`, which validates
 * every browser-followed `Location` header before it leaves the handler). Kept
 * at the `src/` root so both layers import the ONE rule and cannot drift -- a
 * cross-origin target blocked on the JS/fetch path is blocked identically on the
 * no-JS (PE) and full-page document paths.
 */

/**
 * Resolve a redirect target against the current origin.
 *
 * Returns the canonical (normalized) same-origin href -- which also collapses
 * protocol-relative (`//evil.com`) and other ambiguous forms -- or `null` when
 * the target resolves to a different origin or is unparseable. Pure: no logging,
 * no side effects.
 */
export function resolveSameOriginRedirect(
  url: string,
  currentOrigin: string,
): string | null {
  try {
    const target = new URL(url, currentOrigin);
    if (target.origin !== currentOrigin) {
      return null;
    }
    return target.href;
  } catch {
    return null;
  }
}

/**
 * Validate an explicit off-origin redirect target (`redirect(url, { external:
 * true })`).
 *
 * `external` opts out of the same-origin rule, but NOT out of scheme safety:
 * only `http:`/`https:` targets are allowed. A redirect ultimately reaches the
 * browser via `window.location.assign()` on the SPA/action client paths, so a
 * forged or mistaken `redirect("javascript:...", { external: true })` would be a
 * scriptable navigation if the scheme were not checked here. Returns the
 * normalized href for an http(s) target (same- or cross-origin), or `null`
 * otherwise. Pure: no logging, no side effects.
 */
export function resolveExternalRedirect(
  url: string,
  currentOrigin: string,
): string | null {
  try {
    const target = new URL(url, currentOrigin);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return null;
    }
    return target.href;
  } catch {
    return null;
  }
}

/**
 * The safe same-origin landing for a blocked redirect.
 *
 * Every guard that neutralizes a cross-origin/unsafe redirect target sends the
 * browser here instead: the app's basename root, or `"/"` when unset. Kept
 * beside the resolvers so the "where does a blocked redirect go" answer lives
 * in ONE place -- the server 3xx guard (`rsc/redirect-guard.ts`) and the
 * shell-HIT degradation path (`rsc/rsc-rendering.ts`) must agree, or a blocked
 * redirect lands differently depending on which exit it took.
 */
export function safeSameOriginLanding(basename: string | undefined): string {
  return basename && basename !== "/" ? basename : "/";
}

/**
 * Out-of-band brand for `redirect(url, { external: true })`.
 *
 * The external opt-in MUST be settable only by app code calling `redirect(...,
 * { external: true })`, never by an attacker. An earlier design carried the
 * opt-in as a wire header (`x-rango-redirect-external`), but a wire header is
 * forgeable: a proxy-style response route that copies an attacker-controlled
 * upstream response's headers would let `302 Location: https://evil` plus that
 * header bypass the same-origin guard without app code ever opting in. So the
 * opt-in is now an out-of-band brand on the Response object itself, tracked in a
 * `WeakSet` that cannot cross the wire. `redirect()` brands the Response; the
 * small set of internal redirect-rebuild paths (middleware `mergeResponse`,
 * `carryOverRedirectHeaders`, the response-route rewrap) transfer the brand onto
 * the rebuilt Response; the guard and the SPA intercept read it. An upstream
 * Response an app proxies is never branded, so its forged header is inert.
 *
 * Fail-closed: if a rebuild path ever drops the brand, the redirect is
 * neutralized to the app root rather than allowed off-host.
 */
const externalRedirects = new WeakSet<Response>();

/** Brand a Response as an explicit `{ external: true }` redirect (out-of-band). */
export function markExternalRedirect(response: Response): void {
  externalRedirects.add(response);
}

/** Read the out-of-band `{ external: true }` brand off a Response. */
export function isExternalRedirect(response: Response): boolean {
  return externalRedirects.has(response);
}

/**
 * Reserved internal header name. No longer a trust signal -- the external
 * opt-in is the out-of-band brand above. It is kept only so the redirect-rebuild
 * paths and the guard can defensively strip any value (e.g. one forged by a
 * proxied upstream) and guarantee it never reaches the browser.
 */
export const EXTERNAL_REDIRECT_MARKER: string = "x-rango-redirect-external";
