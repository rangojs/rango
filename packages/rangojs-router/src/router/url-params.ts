/**
 * URL param encode/decode at the route boundary.
 *
 * Extraction (decode): regex/trie matchers keep param values URL-encoded;
 * `safeDecodeURIComponent` turns them back into raw strings so `ctx.params`
 * matches the contract apps expect (Express/React Router/Fastify/Koa) and
 * round-trips through reverse stay stable. Malformed %-encoding is
 * preserved as-is so a broken URL doesn't crash matching.
 *
 * Reversal (encode): `encodePathSegment` escapes only what RFC 3986
 * requires for a path segment — `/`, `?`, `#`, space, control chars,
 * non-ASCII — and leaves pchar sub-delims (`@ : $ & + , ; =` and friends)
 * readable. `encodeURIComponent` over-encodes for path segments, which
 * makes generated URLs harder for humans to read in the address bar
 * (e.g. mailbox IDs like `ivo@example.com` would become
 * `ivo%40example.com` even though `@` is path-legal).
 */

export function safeDecodeURIComponent(raw: string): string {
  if (raw === "" || raw.indexOf("%") === -1) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// encodeURIComponent over-encodes for path segments. After running it,
// un-encode the pchar sub-delims + (`:` / `@`) so the resulting URL
// keeps human-readable characters that are legal in a path segment.
// Everything dangerous — `/ ? # %` and space/control/non-ASCII — stays
// encoded.
const PATH_SAFE_ESCAPES: Record<string, string> = {
  "%3A": ":",
  "%40": "@",
  "%24": "$",
  "%26": "&",
  "%2B": "+",
  "%2C": ",",
  "%3B": ";",
  "%3D": "=",
};

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /%(?:3A|40|24|26|2B|2C|3B|3D)/gi,
    (match) => PATH_SAFE_ESCAPES[match.toUpperCase()] ?? match,
  );
}
