import {
  resolveSameOriginRedirect,
  resolveExternalRedirect,
} from "../redirect-origin.js";

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

/**
 * Validate an explicit off-origin redirect (`redirect(url, { external: true })`)
 * the client is about to hard-navigate to via `window.location.assign()`.
 *
 * Thin wrapper over the shared {@link resolveExternalRedirect} rule (also used by
 * the server guard in `rsc/redirect-guard.ts`) so client and server enforce the
 * identical contract: `external` allows an off-origin target but only an
 * http(s) scheme. This stops a forged or mistaken external payload carrying a
 * `javascript:`/`data:` URL from turning `location.assign` into a scriptable
 * navigation. Adds the client-side `console.error` on a block; the resolver
 * itself stays pure.
 *
 * @returns The normalized URL string on success, or null if blocked.
 */
export function validateExternalRedirect(
  url: string,
  currentOrigin: string,
): string | null {
  const resolved = resolveExternalRedirect(url, currentOrigin);
  if (resolved === null) {
    console.error(
      `[rango] External redirect blocked: non-http(s) target "${url}"`,
    );
  }
  return resolved;
}
