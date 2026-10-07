/**
 * In-memory writable prerender store.
 *
 * Backs the zero-config dev overlay and the `@rangojs/router/testing` fake.
 * A plain Map — no per-isolate null memoization (a later set() must be visible
 * after an earlier miss), no React/RSC deps.
 */

import {
  lowerStoredEntryStaleAt,
  serializePrerenderKey,
  type PrerenderKey,
  type PrerenderStoredEntry,
  type WritablePrerenderStore,
} from "./writable-store.js";

export interface MemoryPrerenderStore extends WritablePrerenderStore {
  delete(key: PrerenderKey): Promise<void>;
  markStale(routerId: string, tags: string[]): Promise<void>;
  /** Synchronous read by structured key (tests). */
  peek(key: PrerenderKey): PrerenderStoredEntry | null;
  /** All stored [serializedKey, entry] pairs (tests). */
  entries(): [string, PrerenderStoredEntry][];
  /** Drop every entry. */
  clear(): void;
  readonly size: number;
}

export interface MemoryPrerenderStoreOptions {
  /** Injectable clock for `markStale` in deterministic tests. Defaults to Date.now. */
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
  // The owning router per entry: the serialized key cannot be split back.
  const map = new Map<
    string,
    { routerId: string; stored: PrerenderStoredEntry }
  >();

  // routerId -> tag -> when markStale() last named it. A held entry is marked
  // in place; this covers a write that was rendered before the mark and set
  // after it.
  const marks = new Map<string, Map<string, number>>();

  return {
    async get(key: PrerenderKey): Promise<PrerenderStoredEntry | null> {
      return map.get(serializePrerenderKey(key))?.stored ?? null;
    },

    async set(key: PrerenderKey, stored: PrerenderStoredEntry): Promise<void> {
      // Strictly after storedAt, unlike the KV read (cloudflare.ts, `>=`): in
      // one process a mark and a render start can share a millisecond with the
      // mark first, which `>=` would read as invalidating that render. KV's
      // marker write is I/O, so a same-millisecond marker there is ambiguous.
      // Marks, never refuses: a stale entry keeps serving.
      const routerMarks = marks.get(key.routerId);
      if (routerMarks) {
        for (const tag of stored.meta.tags) {
          const at = routerMarks.get(tag);
          if (at != null && at > stored.meta.storedAt) {
            lowerStoredEntryStaleAt(stored, at);
          }
        }
      }
      map.set(serializePrerenderKey(key), { routerId: key.routerId, stored });
    },

    async delete(key: PrerenderKey): Promise<void> {
      map.delete(serializePrerenderKey(key));
    },

    async markStale(routerId: string, tags: string[]): Promise<void> {
      if (tags.length === 0) return;
      const tagSet = new Set(tags);
      const at = now();
      let routerMarks = marks.get(routerId);
      if (!routerMarks) marks.set(routerId, (routerMarks = new Map()));
      for (const tag of tags) routerMarks.set(tag, at);
      for (const entry of map.values()) {
        if (
          entry.routerId === routerId &&
          entry.stored.meta.tags.some((t) => tagSet.has(t))
        ) {
          lowerStoredEntryStaleAt(entry.stored, at);
        }
      }
    },

    peek(key: PrerenderKey): PrerenderStoredEntry | null {
      return map.get(serializePrerenderKey(key))?.stored ?? null;
    },

    entries(): [string, PrerenderStoredEntry][] {
      return [...map].map(([k, v]) => [k, v.stored]);
    },

    clear(): void {
      map.clear();
      marks.clear();
    },

    get size(): number {
      return map.size;
    },
  };
}
