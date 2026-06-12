import { DEFAULT_STATE_COOKIE_PREFIX } from "../browser/cookie-name.js";

/**
 * Resolve the rango state cookie name once, server-side, at router init. The
 * resolved string is shipped in payload metadata and the client reads it
 * verbatim, so composition happens in exactly one place.
 *
 * Shape: `{sanitizedPrefix}_{sanitizedRouterId}`. The prefix charset excludes
 * `_` so the FIRST `_` is always the prefix/routerId boundary; that keeps the
 * name injective even though a routerId may legitimately contain `_` (the
 * counter fallback is `router_{n}`). Without that exclusion, prefix
 * `rango-state` + id `router_0` and prefix `rango-state_router` + id `0` would
 * both resolve to `rango-state_router_0` and silently share a cache key.
 */

// Prefix excludes `_` so it can never collide with the separator.
function sanitizePrefix(prefix: string): string {
  return prefix.replace(/[^A-Za-z0-9-]/g, "");
}

// routerId keeps `_` (so `router_0` survives); other illegal chars are dropped.
function sanitizeRouterId(routerId: string): string {
  return routerId.replace(/[^A-Za-z0-9_-]/g, "");
}

export function resolveStateCookieName(
  prefix: string | undefined,
  routerId: string,
): string {
  const sanitized = sanitizePrefix(prefix ?? DEFAULT_STATE_COOKIE_PREFIX);
  const finalPrefix = sanitized || DEFAULT_STATE_COOKIE_PREFIX;
  return `${finalPrefix}_${sanitizeRouterId(routerId)}`;
}
