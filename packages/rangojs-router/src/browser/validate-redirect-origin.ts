import { resolveSameOriginRedirect } from "../redirect-origin.js";

/**
 * Validate that a client-consumed redirect URL (from headers or Flight payload)
 * targets the same origin as the current page. Prevents open-redirect attacks
 * via crafted responses.
 *
 * Thin wrapper over the shared {@link resolveSameOriginRedirect} rule (also used
 * by the server guard in `rsc/redirect-guard.ts`) so client and server enforce
 * the identical same-origin contract. Adds the client-side `console.error` on a
 * block; the resolver itself stays pure.
 *
 * @returns The canonical (normalized) URL string on success, or null if blocked.
 */
export function validateRedirectOrigin(
  url: string,
  currentOrigin: string,
): string | null {
  const resolved = resolveSameOriginRedirect(url, currentOrigin);
  if (resolved === null) {
    console.error(
      `[rango] Redirect blocked: cross-origin or invalid target "${url}"`,
    );
  }
  return resolved;
}
