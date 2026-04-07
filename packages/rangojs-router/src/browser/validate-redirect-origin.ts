/**
 * Validate that a client-consumed redirect URL (from headers or Flight payload)
 * targets the same origin as the current page. Prevents open-redirect attacks
 * via crafted responses.
 *
 * @returns The canonical (normalized) URL string on success, or null if blocked.
 */
export function validateRedirectOrigin(
  url: string,
  currentOrigin: string,
): string | null {
  try {
    const target = new URL(url, currentOrigin);
    if (target.origin !== currentOrigin) {
      console.error(
        `[rango] Redirect blocked: origin mismatch (${target.origin})`,
      );
      return null;
    }
    // Return pathname+search+hash for relative inputs, full href for absolute.
    // This normalizes protocol-relative and other ambiguous forms.
    return target.href.startsWith(currentOrigin)
      ? target.href
      : target.pathname + target.search + target.hash;
  } catch {
    console.error(`[rango] Redirect blocked: invalid URL "${url}"`);
    return null;
  }
}
