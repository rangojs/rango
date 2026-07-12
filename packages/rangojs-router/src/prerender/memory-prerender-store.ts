/**
 * In-memory writable prerender store.
 *
 * Backs the zero-config dev overlay and the `@rangojs/router/testing` fake.
 * A plain Map — no per-isolate null memoization (a later set() must be visible
 * after an earlier miss), no React/RSC deps.
 */

import type { PrerenderEntry } from "./store.js";
import {
  composeStoredEntry,
  isStoredEntryValidFor,
  serializePrerenderKey,
  type PrerenderKey,
  type PrerenderLookupMeta,
  type PrerenderSetOptions,
  type PrerenderStoredEntry,
  type WritablePrerenderStore,
} from "./writable-store.js";

export interface MemoryPrerenderStore extends WritablePrerenderStore {
  delete(key: PrerenderKey): Promise<void>;
  invalidateTags(tags: string[]): Promise<void>;
  /** Read an entry by structured key without the verify-on-read check (tests). */
  peek(key: PrerenderKey): PrerenderStoredEntry | null;
  /** All stored [serializedKey, entry] pairs (tests). */
  entries(): [string, PrerenderStoredEntry][];
  /** Drop every entry. */
  clear(): void;
  readonly size: number;
}

export interface MemoryPrerenderStoreOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Create an in-memory {@link WritablePrerenderStore} with test-inspection
 * helpers. Invalidation is mark-stale (sets `staleAt`), never delete — matching
 * the durable v1 contract so the entry keeps serving until refreshed.
 */
export function createMemoryPrerenderStore(
  options: MemoryPrerenderStoreOptions = {},
): MemoryPrerenderStore {
  const now = options.now ?? (() => Date.now());
  const map = new Map<string, PrerenderStoredEntry>();

  return {
    async get(
      key: PrerenderKey,
      meta: PrerenderLookupMeta,
    ): Promise<PrerenderStoredEntry | null> {
      const stored = map.get(serializePrerenderKey(key));
      if (!stored) return null;
      // Verify-on-read: version + canonical params must match (collision guard).
      if (!isStoredEntryValidFor(stored, key, meta)) return null;
      return stored;
    },

    async set(
      key: PrerenderKey,
      entry: PrerenderEntry,
      setOptions: PrerenderSetOptions,
    ): Promise<void> {
      map.set(
        serializePrerenderKey(key),
        composeStoredEntry(key, entry, setOptions, now()),
      );
    },

    async delete(key: PrerenderKey): Promise<void> {
      map.delete(serializePrerenderKey(key));
    },

    async invalidateTags(tags: string[]): Promise<void> {
      if (tags.length === 0) return;
      const tagSet = new Set(tags);
      const at = now();
      for (const stored of map.values()) {
        if (stored.meta.tags.some((t) => tagSet.has(t))) {
          // Mark-stale: keep serving, but a stale hit schedules a refresh.
          stored.meta.staleAt = at;
        }
      }
    },

    peek(key: PrerenderKey): PrerenderStoredEntry | null {
      return map.get(serializePrerenderKey(key)) ?? null;
    },

    entries(): [string, PrerenderStoredEntry][] {
      return [...map.entries()];
    },

    clear(): void {
      map.clear();
    },

    get size(): number {
      return map.size;
    },
  };
}
