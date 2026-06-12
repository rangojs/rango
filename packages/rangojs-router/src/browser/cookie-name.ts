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
  return { version: decodeURIComponent(raw.slice(0, colon)), timestamp };
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
