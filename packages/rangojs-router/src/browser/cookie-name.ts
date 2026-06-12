/**
 * Rango state cookie: value codec and attribute serialization.
 *
 * Shared by the client (the document.cookie writer in rango-state.ts) and the
 * server (the Set-Cookie writer in invalidateClientCache). Environment-agnostic:
 * no window/document access and no name composition.
 *
 * Name RESOLUTION deliberately lives elsewhere (router init, see
 * router/state-cookie-name.ts). Keeping composition out of this shared module
 * is what lets the client read the server-resolved name verbatim and compose
 * nothing.
 */

/** Default prefix when `stateCookiePrefix` is unset or empty after sanitization. */
export const DEFAULT_STATE_COOKIE_PREFIX = "rango-state";

/** Internal response header carrying the keepClientCache() directive. */
export const KEEP_CACHE_HEADER = "x-rango-keep-cache";

/**
 * True for a per-client signal that must never be stored in a SHARED response
 * cache (Finding #3): a `Set-Cookie` (a rango state rotation, or any cookie a
 * loader set) or the keepClientCache() directive header. Strip-all-Set-Cookie
 * is deliberate — a shared store has no request context and cannot know the
 * resolved cookie name, and a cacheable document carrying any per-client cookie
 * is the hazard regardless of which cookie it is.
 */
export function isPerClientSignalHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "set-cookie" || lower === KEEP_CACHE_HEADER;
}

/**
 * Encode a state value for the wire: `encodeURIComponent(version):timestamp`.
 * Only the build-derived version is encoded (it is arbitrary); the `:`
 * separator and numeric timestamp stay raw, so the `{version}:{timestamp}`
 * shape survives and `:` is a legal cookie-value octet.
 */
export function encodeStateValue(version: string, timestamp: number): string {
  return `${encodeURIComponent(version)}:${timestamp}`;
}

/** Parsed state value. `version` is decoded; `timestamp` is the raw integer. */
export interface StateValue {
  version: string;
  timestamp: number;
}

/**
 * Decode a wire value back into `{version, timestamp}`. Returns null for a
 * malformed value (no `:`, empty version, or non-numeric timestamp) so callers
 * mint fresh instead of trusting garbage.
 */
export function decodeStateValue(raw: string): StateValue | null {
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const timestamp = Number(raw.slice(colon + 1));
  if (!Number.isFinite(timestamp)) return null;
  let version: string;
  try {
    version = decodeURIComponent(raw.slice(0, colon));
  } catch {
    // A malformed percent-escape (e.g. "%:1") must mint fresh, not throw —
    // a thrown URIError here would 500 the server seat or fail client boot.
    return null;
  }
  return { version, timestamp };
}

/**
 * Attribute string for the state cookie. Session cookie (no Max-Age/Expires),
 * Path=/ (whole app), SameSite=Lax (sent on top-level navigations), and Secure
 * only on https so the document.cookie write does not silently fail on plain
 * http dev. Never HttpOnly (the client reads and writes it).
 */
export function stateCookieAttributes(secure: boolean): string {
  return `; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Serialize a full `name=value` cookie string with the state attributes. */
export function serializeStateCookie(
  name: string,
  value: string,
  secure: boolean,
): string {
  return `${name}=${value}${stateCookieAttributes(secure)}`;
}
