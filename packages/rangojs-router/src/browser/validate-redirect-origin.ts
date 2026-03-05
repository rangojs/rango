/**
 * Validate that a redirect URL from an RSC header (X-RSC-Redirect, X-RSC-Reload)
 * targets the same origin as the current page. Prevents open-redirect attacks
 * via crafted response headers.
 *
 * @returns The validated URL string, or null if the origin doesn't match.
 */
export function validateRedirectOrigin(
  headerValue: string,
  currentOrigin: string,
): string | null {
  try {
    const target = new URL(headerValue, currentOrigin);
    if (target.origin !== currentOrigin) {
      console.error(
        `[rango] Redirect blocked: origin mismatch (${target.origin})`,
      );
      return null;
    }
    return headerValue;
  } catch {
    console.error(`[rango] Redirect blocked: invalid URL "${headerValue}"`);
    return null;
  }
}
