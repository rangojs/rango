/**
 * Deterministic param hashing for prerender storage keys.
 * Used at build time and runtime; both must produce identical hashes.
 * DJB2-based; works in all JS environments without crypto imports.
 */

import { encodeKV } from "../encode-kv.js";

// For static routes (no params), returns "_".
export function hashParams(params: Record<string, string>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return "_";

  // Byte-order sort + encodeURIComponent join (see encodeKV); output is
  // byte-identical to the prior inline implementation, so build-time and
  // runtime hashes stay stable.
  return djb2Hex(encodeKV(entries, { sort: true }));
}

/**
 * DJB2 hash returning an 8-char hex string.
 * Deterministic across all JS runtimes.
 *
 * 32-bit output: per-route collision probability hits ~50% near ~77k distinct
 * param sets (birthday bound). The production store keys solely on
 * routeName/paramHash and does not verify the canonical param string, so a
 * collision serves the surviving entry for both param sets. Benign for typical
 * catalogs; revisit (wider hash or stored-param verification) before
 * pre-rendering hundreds of thousands of pages per route.
 */
function djb2Hex(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
