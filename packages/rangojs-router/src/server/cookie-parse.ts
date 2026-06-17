/**
 * Canonical inbound-Cookie-header parser.
 *
 * Kept as a dependency-free leaf so any consumer (request-context, the host
 * dispatcher, tests) can share one implementation without pulling a heavier
 * module's graph. A duplicate copy in middleware-cookies.ts was removed; the
 * host copy in cookie-handler.ts was collapsed onto this one. Not part of the
 * public export surface.
 */
export function parseCookiesFromHeader(
  cookieHeader: string | null,
): Record<string, string> {
  if (!cookieHeader) return {};

  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(";");

  for (const pair of pairs) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) {
      const raw = rest.join("=");
      try {
        cookies[name] = decodeURIComponent(raw);
      } catch {
        // Malformed percent-encoding: fall back to raw value
        cookies[name] = raw;
      }
    }
  }

  return cookies;
}
