/**
 * Rango State
 *
 * Manages a session-cookie-based state value for HTTP cache invalidation. The
 * value is sent as the `X-Rango-State` header on prefetch and navigation
 * requests; the server responds with `Vary: X-Rango-State`, so the browser HTTP
 * cache keys responses by (URL, X-Rango-State value).
 *
 * Value format: `{buildVersion}:{invalidationTimestamp}`
 * - Build version changes on deploy, busting all cached prefetches at boot.
 * - Timestamp rotates on invalidation (server action, invalidateClientCache).
 *
 * Storage is a session cookie named by the server-resolved name passed to
 * initRangoState (`{prefix}_{routerId}`, default prefix `rango-state`). The
 * cookie jar is shared across tabs, so a per-request read IS the cross-tab
 * value sync — no `storage` event is needed. An in-memory mirror is a
 * write-through copy that is authoritative only when the cookie is unreadable
 * (e.g. a sandboxed frame, or site data blocked wholesale): the failure
 * direction is always toward freshness.
 *
 * Precedence is load-bearing: when `document.cookie` is readable, the
 * per-request read wins; the mirror is a fallback, never a cache of the read.
 * Caching the read across requests would reintroduce the staleness this
 * mechanism removes.
 */

import {
  DEFAULT_STATE_COOKIE_PREFIX,
  decodeStateValue,
  getRawCookieValue,
  mintStateValue,
  serializeStateCookie,
} from "./cookie-name.js";

let cookieName: string = DEFAULT_STATE_COOKIE_PREFIX;

let currentVersion = "0";

let mirror: string | null = null;
let cookieBacked = false;

let externalRotationObserver: ((value: string) => void) | null = null;

/**
 * Register the observer invoked when a read detects an EXTERNAL rotation (a
 * sibling tab, a server `Set-Cookie`, or a cookie clear). Self-rotations
 * (invalidateRangoState) update the mirror synchronously and never fire it.
 */
export function setRangoStateObserver(
  observer: ((value: string) => void) | null,
): void {
  externalRotationObserver = observer;
}

/** Return the resolved cookie name used to namespace cross-tab messages. */
export function getRangoStateCookieName(): string {
  return cookieName;
}

function notifyExternalRotation(value: string): void {
  externalRotationObserver?.(value);
}

interface CookieRead {
  /** False when there is no document or the read threw (sandboxed frame). */
  readable: boolean;
  /** The cookie value, or null when readable but absent. */
  value: string | null;
}

function readCookie(name: string): CookieRead {
  if (typeof document === "undefined") return { readable: false, value: null };
  let raw: string;
  try {
    raw = document.cookie;
  } catch {
    return { readable: false, value: null };
  }
  return { readable: true, value: getRawCookieValue(raw, name) };
}

function writeCookie(name: string, value: string): void {
  if (typeof document === "undefined") return;
  const secure =
    typeof location !== "undefined" && location.protocol === "https:";
  try {
    document.cookie = serializeStateCookie(name, value, secure);
  } catch {}
}

function mintValue(): string {
  return mintStateValue(currentVersion, mirror);
}

/**
 * Initialize the Rango state cookie at app startup. `version` is the build
 * version; `stateCookieName` is the server-resolved cookie name from payload
 * metadata (falls back to the bare default prefix when a payload arrives
 * without it). Keeps an existing matching-version cookie (preserves the cache
 * key across reloads); mints fresh on a version change or a missing cookie.
 */
export function initRangoState(
  version: string,
  stateCookieName?: string,
): void {
  currentVersion = version;
  cookieName = stateCookieName || DEFAULT_STATE_COOKIE_PREFIX;
  cleanupLegacyStorage();

  const read = readCookie(cookieName);
  if (!read.readable) {
    // Cookies unreadable: the mirror is the source of truth for this session.
    mirror = mintValue();
    cookieBacked = false;
    return;
  }
  if (read.value !== null) {
    const decoded = decodeStateValue(read.value);
    if (decoded && decoded.version === version) {
      // Keep: a matching-version cookie survives the reload warm.
      mirror = read.value;
      cookieBacked = true;
      return;
    }
  }
  // Absent, malformed, or a version change (deploy): mint fresh and write.
  mirror = mintValue();
  cookieBacked = false;
  writeCookie(cookieName, mirror);
}

/**
 * Get the current Rango state value, used as the `X-Rango-State` header on
 * prefetch and navigation requests. Reads the cookie every call (the read is
 * the cross-tab sync channel) and reconciles the mirror.
 */
export function getRangoState(): string {
  const read = readCookie(cookieName);

  if (!read.readable) {
    // Mirror authoritative when the jar is unreadable.
    return mirror ?? "0:0";
  }

  if (read.value !== null) {
    if (read.value !== mirror) {
      // External rotation (sibling tab / server Set-Cookie): adopt it. The
      // mirror update makes this idempotent across a burst of reads.
      mirror = read.value;
      cookieBacked = true;
      notifyExternalRotation(read.value);
    } else {
      cookieBacked = true;
    }
    return read.value;
  }

  // Readable but absent.
  if (cookieBacked) {
    // present -> absent: an external clear. Mint fresh, write back, and notify
    // once (cookieBacked flips to false so we don't re-fire on the next read).
    mirror = mintValue();
    cookieBacked = false;
    writeCookie(cookieName, mirror);
    notifyExternalRotation(mirror);
  } else if (mirror === null) {
    // First access with no cookie yet (pre-boot): mint silently — there is
    // nothing to invalidate.
    mirror = mintValue();
    writeCookie(cookieName, mirror);
  }
  return mirror;
}

/**
 * Invalidate the Rango state (self-rotation). Called when the client clears its
 * prefetch caches (e.g. via the server-action bridge). Rotates the timestamp,
 * keeps the version, writes the cookie, and updates the mirror synchronously so
 * the external-rotation observer is NOT triggered by our own write.
 */
export function invalidateRangoState(): void {
  mirror = mintValue();
  cookieBacked = false;
  writeCookie(cookieName, mirror);
}

/** Adopt the state carried by a same-origin cache-invalidation broadcast. */
export function adoptRangoState(value: string): boolean {
  const incoming = decodeStateValue(value);
  if (!incoming || incoming.version !== currentVersion) return false;
  const current = mirror ? decodeStateValue(mirror) : null;
  if (
    current?.version === incoming.version &&
    current.timestamp >= incoming.timestamp
  ) {
    return false;
  }
  mirror = value;
  cookieBacked = false;
  return true;
}

function cleanupLegacyStorage(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === "rango-state" || (key && key.startsWith("rango-state:"))) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch {}
}
