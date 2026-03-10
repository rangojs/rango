/**
 * Origin Guard
 *
 * Cross-origin request protection for server actions, loader fetches, and
 * progressive enhancement form submissions. Validates that the Origin header
 * (or Referer fallback) matches the request Host before executing.
 *
 * Requests without an Origin or Referer header are allowed — same-origin
 * navigations, bookmarks, and non-browser clients don't send Origin.
 */

/**
 * Validate that the request origin matches the server host.
 * Returns null when the origin is valid (or absent), or a 403 Response
 * when a cross-origin mismatch is detected.
 */
export function validateRequestOrigin(
  request: Request,
  url: URL,
): Response | null {
  // 1. Read Origin header (present on all cross-origin requests and
  //    same-origin POST/PUT/PATCH/DELETE in modern browsers)
  let requestOrigin = request.headers.get("origin");

  // 2. Fallback to Referer if Origin is absent (some proxies strip it)
  if (!requestOrigin) {
    const referer = request.headers.get("referer");
    if (referer) {
      try {
        requestOrigin = new URL(referer).origin;
      } catch {
        // Malformed referer — treat as absent
      }
    }
  }

  // 3. No Origin or Referer — allow (can't be browser-initiated CSRF)
  if (!requestOrigin) return null;

  // "null" origin comes from privacy-sensitive contexts (data: URLs,
  // sandboxed iframes, cross-origin redirects). Reject it.
  if (requestOrigin === "null") {
    return createForbiddenResponse(request);
  }

  // 4. Determine expected host: prefer X-Forwarded-Host (proxy/CDN),
  //    fall back to Host header, then url.host
  const expectedHost =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    url.host;

  // 5. Determine expected protocol: prefer X-Forwarded-Proto
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const expectedProtocol = forwardedProto ? `${forwardedProto}:` : url.protocol;

  // 6. Build expected origin and compare (case-insensitive)
  const expectedOrigin = `${expectedProtocol}//${expectedHost}`;

  if (requestOrigin.toLowerCase() !== expectedOrigin.toLowerCase()) {
    return createForbiddenResponse(request);
  }

  return null;
}

function createForbiddenResponse(request: Request): Response {
  const isDev = process.env.NODE_ENV !== "production";
  const body = isDev
    ? "Forbidden: Origin mismatch. The request origin does not match the server host. " +
      `Set originCheck: false in createRouter() to disable this check. ` +
      `(Origin: ${request.headers.get("origin") ?? "none"}, ` +
      `Host: ${request.headers.get("host") ?? "none"})`
    : "Forbidden";

  return new Response(body, {
    status: 403,
    headers: { "X-Rango-Origin-Check": "failed" },
  });
}

/**
 * Configuration-aware origin check dispatcher.
 *
 * - `false` — disabled (always allows)
 * - `true` or `undefined` — built-in validation (default, secure-by-default)
 * - function — custom validation returning true to allow, false to reject
 */
export type OriginCheckConfig =
  | boolean
  | ((request: Request, url: URL) => boolean | Promise<boolean>);

export async function checkRequestOrigin(
  request: Request,
  url: URL,
  config: OriginCheckConfig | undefined,
): Promise<Response | null> {
  // Disabled by explicit opt-out
  if (config === false) return null;

  // Custom function
  if (typeof config === "function") {
    const allowed = await config(request, url);
    if (allowed) return null;
    return new Response("Forbidden", { status: 403 });
  }

  // Default: built-in validation (config === true or undefined)
  return validateRequestOrigin(request, url);
}
