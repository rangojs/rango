"use cache";

// File-level "use cache" — all exports are wrapped by the transform.
// These data functions return plain objects (non-JSX).

/**
 * Basic cached timestamp — no args, cache key is just the function ID.
 */
export async function getBasicTimestamp(): Promise<{
  ts: number;
  rand: number;
}> {
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * Cached by category — the category arg becomes part of the cache key.
 * Different categories produce different cache entries.
 */
export async function getDataForCategory(
  category: string,
): Promise<{ category: string; ts: number; rand: number }> {
  return { category, ts: Date.now(), rand: Math.random() };
}
