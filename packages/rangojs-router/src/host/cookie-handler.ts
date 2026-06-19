import type { HostOverrideConfig } from "./types.js";
import type { RouterRequestInput } from "../router/router-interfaces.js";
import { matchPattern, parseRequest } from "./pattern-matcher.js";
import {
  HostOverrideNotAllowedError,
  InvalidHostnameError,
  HostValidationError,
} from "./errors.js";
import { parseCookiesFromHeader } from "../server/cookie-parse.js";

export function parseCookies(request: Request): Record<string, string> {
  return parseCookiesFromHeader(request.headers.get("cookie"));
}

export function getCookie(request: Request, name: string): string | undefined {
  const cookies = parseCookies(request);
  return cookies[name];
}

export function createDeleteCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly`;
}

export function createCookieErrorResponse(
  cookieName: string,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      error: message,
      message: `The ${cookieName} cookie has been cleared`,
    }),
    {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": createDeleteCookieHeader(cookieName),
      },
    },
  );
}

export function isHostAllowed(
  request: Request,
  allowedHosts: string[],
): boolean {
  const { hostname, pathname, parts } = parseRequest(request);

  for (const pattern of allowedHosts) {
    if (matchPattern(pattern, hostname, pathname, parts)) {
      return true;
    }
  }

  return false;
}

export function handleCookieOverride(
  request: Request,
  config: HostOverrideConfig | undefined,
  input: RouterRequestInput<any>,
): string {
  if (!config) {
    const { hostname } = parseRequest(request);
    return hostname;
  }

  const { cookieName, allowedHosts, validate } = config;
  const cookieValue = getCookie(request, cookieName);
  const { hostname: originalHostname } = parseRequest(request);

  if (!cookieValue) {
    return originalHostname;
  }

  const allowed = isHostAllowed(request, allowedHosts);

  if (!allowed) {
    throw new HostOverrideNotAllowedError(originalHostname, cookieName, {
      cause: { cookieValue, currentHost: originalHostname },
    });
  }

  if (validate) {
    try {
      const validatedHostname = validate(request, cookieValue, input);
      return validatedHostname;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HostValidationError(message, error);
    }
  }

  // URL.hostname ASCII-lowercases the host, so compare the cookie value against
  // its canonical lowercase form (a mixed-case host is valid) and reject only
  // when it carries a path/port. Return the canonical host so downstream
  // matching, which assumes lowercase, sees a consistent value.
  try {
    const testUrl = new URL(`https://${cookieValue}`);

    if (testUrl.hostname !== cookieValue.toLowerCase()) {
      throw new InvalidHostnameError(cookieValue, {
        cause: { original: cookieValue, normalized: testUrl.hostname },
      });
    }

    return testUrl.hostname;
  } catch (error) {
    if (error instanceof InvalidHostnameError) {
      throw error;
    }
    throw new InvalidHostnameError(cookieValue, { cause: error });
  }
}
