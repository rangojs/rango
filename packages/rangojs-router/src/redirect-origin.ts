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
 * Internal marker header set by `redirect(url, { external: true })` to opt a
 * single redirect out of the same-origin guard. The server guard strips it
 * before the response leaves; it is never sent to the browser.
 */
export const EXTERNAL_REDIRECT_MARKER: string = "x-rango-redirect-external";
