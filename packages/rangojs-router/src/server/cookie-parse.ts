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
  const cookies: Record<string, string> = {};

  if (cookieHeader) {
    for (const pair of cookieHeader.split(";")) {
      const [name, ...rest] = pair.trim().split("=");
      if (name) {
        const raw = rest.join("=");
        let value: string;
        try {
          value = decodeURIComponent(raw);
        } catch {
          // Malformed percent-encoding: fall back to raw value
          value = raw;
        }
        setCookie(cookies, name, value);
      }
    }
  }

  // Null prototype (#1109): cookie names come from the request, so a lookup
  // must never answer `constructor` or `toString` with an inherited member.
  // Set once at the end: Object.create(null) starts in dictionary mode, which
  // makes a spread of the jar several times slower.
  Object.setPrototypeOf(cookies, null);
  return cookies;
}

/** `cookies[name] = value`, a cookie named `__proto__` as an own key too. */
function setCookie(
  cookies: Record<string, string>,
  name: string,
  value: string,
): void {
  if (name === "__proto__") {
    Object.defineProperty(cookies, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    cookies[name] = value;
  }
}
