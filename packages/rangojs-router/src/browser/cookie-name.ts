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

// Per-client signal headers (lower-case) that a SHARED response cache must never
// store or replay (Finding #3): a `Set-Cookie` (rango state rotation, or any
// cookie a loader set) and the keepClientCache() directive. Strip-all-Set-Cookie
// is deliberate — a shared store can't know the resolved cookie name, and any
// per-client cookie in a cacheable document is the hazard. Single source for the
// predicate, presence check, and strip below.
const PER_CLIENT_SIGNAL_HEADERS: readonly string[] = [
  "set-cookie",
  KEEP_CACHE_HEADER,
];

/** True for a per-client signal header. */
export function isPerClientSignalHeader(name: string): boolean {
  return PER_CLIENT_SIGNAL_HEADERS.includes(name.toLowerCase());
}

/** True if `headers` carries any per-client signal. */
export function hasPerClientSignal(headers: Headers): boolean {
  return PER_CLIENT_SIGNAL_HEADERS.some((name) => headers.has(name));
}

/** Remove every per-client signal header from `headers` in place. */
export function stripPerClientSignals(headers: Headers): void {
  for (const name of PER_CLIENT_SIGNAL_HEADERS) headers.delete(name);
}

/**
 * Read the raw, UNDECODED value of a single cookie from a cookie string (a
 * `document.cookie` jar or a request `Cookie` header). Shared by both seats so
 * the client mirror and the server monotonic-guard read the SAME jar entry —
 * their agreement is the guard's contract. First match wins (the entry the
 * client's mirror holds); exact name boundary via the `=`; an empty value
 * (`name=`) returns null (treated as absent, not a usable prior value).
 */
export function getRawCookieValue(
  cookieString: string | null,
  name: string,
): string | null {
  if (!cookieString) return null;
  const target = name + "=";
  for (const part of cookieString.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      return value === "" ? null : value;
    }
  }
  return null;
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
 * Mint a fresh state value whose timestamp is strictly greater than the previous
 * one, so a re-mint inside the same millisecond (or a backward clock step) still
 * differs from the current value. `prevRaw` is the current wire value (the
 * client's in-memory mirror, or the server's inbound header/cookie) or null; its
 * timestamp is the floor. Shared by both seats so the monotonic guard lives once.
 */
export function mintStateValue(
  version: string,
  prevRaw: string | null,
): string {
  const prevTs = prevRaw ? (decodeStateValue(prevRaw)?.timestamp ?? 0) : 0;
  const ts = Math.max(Date.now(), prevTs + 1);
  return encodeStateValue(version, ts);
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
