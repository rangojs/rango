/**
 * Shared key=value serialization core.
 *
 * One encode+join rule shared by every deterministic query-string serializer
 * in the codebase (cache keys, route-param strings, search-param strings,
 * prerender param hashes). Each call site differs only in how it pre-filters
 * and orders the pairs it hands in, plus whether it sorts; the encoding itself
 * (`encodeURIComponent(k)=encodeURIComponent(v)` joined by `&`) is identical.
 *
 * Dependency-free leaf module so any layer (build-time prerender hashing,
 * runtime cache keys, client search-param serialization) can import it without
 * pulling in cache/router internals.
 */

export interface EncodeKVOptions {
  /**
   * Sort pairs by key in codepoint (byte) order before joining. Byte order via
   * the `<` operator, NOT localeCompare, so the result is identical across
   * Node, Workers, and browsers regardless of runtime locale.
   *
   * Defaults to false (insertion order preserved).
   */
  sort?: boolean;
}

/**
 * Serialize an array of [key, value] pairs to a deterministic query string
 * (no leading `?`). Both key and value are passed through encodeURIComponent
 * so a key/value containing `&` or `=` cannot collide with a structurally
 * different pair set.
 *
 * Callers are responsible for any filtering (e.g. dropping reserved params) and
 * any value coercion (e.g. String(v), skipping null/undefined) BEFORE calling.
 * This function never inspects or skips values; it encodes exactly what it is
 * given so each call site keeps its own existing output.
 */
export function encodeKV(
  pairs: Iterable<readonly [string, string]>,
  options: EncodeKVOptions = {},
): string {
  const list = [...pairs];
  if (list.length === 0) return "";
  if (options.sort) {
    list.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return list
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
