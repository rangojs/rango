/**
 * Deterministic param hashing for prerender storage keys.
 *
 * Used at build time (child process) to generate filenames and at
 * runtime (worker) to look up pre-rendered data. Both environments
 * must produce identical hashes for the same params.
 *
 * Uses a simple DJB2-based hash that works in all JS environments
 * (Node.js, Cloudflare Workers, browsers) without crypto imports.
 */

/**
 * Compute a deterministic hash string from route params.
 * For static routes (no params), returns "_".
 */
export function hashParams(params: Record<string, string>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return "_";

  const sorted = entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const str = sorted
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return djb2Hex(str);
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
