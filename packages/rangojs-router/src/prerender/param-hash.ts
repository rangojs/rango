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

  const sorted = entries.sort(([a], [b]) => a.localeCompare(b));
  const str = sorted.map(([k, v]) => `${k}=${v}`).join("&");
  return djb2Hex(str);
}

/**
 * DJB2 hash returning an 8-char hex string.
 * Deterministic across all JS runtimes.
 */
function djb2Hex(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
