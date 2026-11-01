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
 * The fresh-reads cookie: the state cookie PREFIX plus this suffix
 * (`rango-state-fresh` by default). A response whose request ran
 * updateTag()/revalidateTag() sets it (HttpOnly, SameSite=Lax, Path=/,
 * Max-Age = the stores' longest memo staleness), and the same user's requests
 * carrying it skip the stores' isolate memos (src/cache/isolate-tag-memo.ts).
 * Keyed by prefix, not by router, so a mutation through one router also
 * reaches the memos another router on the host reads (they often share a
 * store); a router with its own `stateCookiePrefix` gets its own cookie.
 */
const FRESH_READS_COOKIE_SUFFIX = "-fresh";

/**
 * The fresh-reads cookie name for a router's resolved state cookie name
 * (`{prefix}_{routerId}`; the prefix never contains `_`, see
 * router/state-cookie-name.ts).
 */
export function freshReadsCookieName(stateCookieName: string): string {
  const cut = stateCookieName.indexOf("_");
  const prefix = cut < 0 ? stateCookieName : stateCookieName.slice(0, cut);
  return `${prefix}${FRESH_READS_COOKIE_SUFFIX}`;
}

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
 * Encode a state value for the wire: `encodeURIComponent(version):timestamp`,
 * plus `:write` when the write part is not 0. Only the build-derived version
 * is encoded (it is arbitrary); the `:` separators and the numeric parts stay
 * raw, so the shape survives and `:` is a legal cookie-value octet. A value no
 * server action has bumped keeps the two-part shape it had before the write
 * part existed.
 */
export function encodeStateValue(
  version: string,
  timestamp: number,
  write = 0,
): string {
  const base = `${encodeURIComponent(version)}:${timestamp}`;
  return write === 0 ? base : `${base}:${write}`;
}

/**
 * Parsed state value. `version` is decoded; `timestamp` (the invalidation
 * part) and `write` are the raw integers. `write` is 0 for a two-part value.
 */
export interface StateValue {
  version: string;
  timestamp: number;
  write: number;
}

/**
 * Decode a wire value back into `{version, timestamp, write}`. Accepts the
 * two-part `{version}:{timestamp}` (a value no action bumped, or one an open
 * tab wrote before the write part existed) and the three-part
 * `{version}:{timestamp}:{write}`. Returns null for a malformed value (no `:`,
 * empty version, a non-numeric part, or more parts) so callers mint fresh
 * instead of trusting garbage.
 */
export function decodeStateValue(raw: string): StateValue | null {
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const parts = raw.slice(colon + 1).split(":");
  if (parts.length > 2) return null;
  const timestamp = parseStatePart(parts[0]!);
  const write = parts.length === 2 ? parseStatePart(parts[1]!) : 0;
  if (timestamp === null || write === null) return null;
  let version: string;
  try {
    version = decodeURIComponent(raw.slice(0, colon));
  } catch {
    // A malformed percent-escape (e.g. "%:1") must mint fresh, not throw —
    // a thrown URIError here would 500 the server seat or fail client boot.
    return null;
  }
  return { version, timestamp, write };
}

function parseStatePart(part: string): number | null {
  if (part === "") return null;
  const value = Number(part);
  return Number.isFinite(value) ? value : null;
}

/**
 * The `{version}:{timestamp}` part of a wire value: what every in-memory
 * comparison on the client reads (the prefetch cache keys, the action
 * fence's rotation check, the external-rotation observer). A change to it is
 * a hard invalidation (a deploy, or invalidateClientCache() on either seat);
 * a change to the write part alone is a server action's write, which marks
 * caches stale and flushes nothing. The full value, write part included, is
 * what requests send as `X-Rango-State`, so the browser HTTP cache (Vary)
 * misses after every write. A raw cut, no decode: the version is
 * percent-encoded, so the second `:` is always the write separator.
 */
export function stateEpoch(raw: string): string {
  const first = raw.indexOf(":");
  if (first < 0) return raw;
  const second = raw.indexOf(":", first + 1);
  return second < 0 ? raw : raw.slice(0, second);
}

/**
 * Mint a fresh state value whose timestamp is strictly greater than the previous
 * one, so a re-mint inside the same millisecond (or a backward clock step) still
 * differs from the current value. `prevRaw` is the current wire value (the
 * client's in-memory mirror, or the server's inbound header/cookie) or null; its
 * timestamp is the floor. The write part starts over (left out): the new
 * timestamp alone makes the value one no response was cached under. Shared by
 * both seats so the monotonic guard lives once.
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
 * Bump the write part of `prevRaw`, keeping its timestamp: what the response
 * of a server action without a directive sets. The new write part is strictly
 * greater than the previous one (and at least the current time, so two tabs'
 * writes from the same value rarely meet), so every write gives a value no
 * response was cached under. Returns null when `prevRaw` is absent or
 * malformed: a client with no state value sends no `X-Rango-State` and has
 * nothing in the HTTP cache keyed by one.
 */
export function bumpStateWrite(
  version: string,
  prevRaw: string | null,
): string | null {
  const prev = prevRaw ? decodeStateValue(prevRaw) : null;
  if (!prev) return null;
  const write = Math.max(Date.now(), prev.write + 1);
  return encodeStateValue(version, prev.timestamp, write);
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
