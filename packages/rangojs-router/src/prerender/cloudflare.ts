/**
 * Cloudflare KV writable prerender store (`@rangojs/router/prerender/cloudflare`).
 *
 * Backs the durable overlay for on-demand prerender on Cloudflare. Self-contained
 * (no CFCacheStore construction constraints): entries are stored under the
 * build-scoped key `prerender:{routerId}:{buildId}:{routeName}:{paramHash}`, and
 * tag invalidation uses the same timestamp-marker technique as the runtime cache
 * — a per-tag KV marker holding the ms epoch of the last invalidation; a read
 * treats the entry as stale (never deleted) when any of its tags' markers is at
 * or after the entry's storedAt.
 *
 * Key design constraints (see docs/design/ondemand-prerender.md, Store Model):
 * - staleAt is SOFT metadata; entries are written with NO KV expirationTtl. Hard
 *   expiry would delete the entry SWR needs and re-expose older bundled-manifest
 *   content below the overlay.
 * - Prerender keys are route + params + variant only — never host-namespaced, so
 *   a refresh from a different host than the serve request still hits.
 * - Invalidation is mark-stale, not delete (deleting would re-expose the manifest
 *   entry as the result of an "invalidation").
 * - Tag markers use a prerender-specific prefix, separate from the runtime cache's
 *   `updateTag()`/`revalidateTag()` namespace.
 */

import type { KVNamespace } from "../cache/cf/cf-cache-types.js";
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

/** Prerender tag markers live in their own namespace, separate from the runtime cache. */
const PRERENDER_TAG_MARKER_PREFIX = "__rango_pr_tag__/";

export interface KVPrerenderStoreOptions {
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Create a {@link WritablePrerenderStore} backed by a Cloudflare KV namespace.
 *
 * @example
 * ```ts
 * import { createKVPrerenderStore } from "@rangojs/router/prerender/cloudflare";
 *
 * createRouter<Env>({
 *   prerender: (env) => ({
 *     store: createKVPrerenderStore(env.PRERENDER_KV),
 *     defaultTtl: 3600,
 *     swr: true,
 *     onRevalidate: (target, e) => e.PRERENDER_QUEUE.send({ target }),
 *   }),
 * });
 * ```
 */
export function createKVPrerenderStore(
  kv: KVNamespace,
  options: KVPrerenderStoreOptions = {},
): WritablePrerenderStore {
  const now = options.now ?? (() => Date.now());

  async function readTagMarker(tag: string): Promise<number | null> {
    const raw = await kv.get(PRERENDER_TAG_MARKER_PREFIX + tag);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  return {
    async get(
      key: PrerenderKey,
      meta: PrerenderLookupMeta,
    ): Promise<PrerenderStoredEntry | null> {
      const raw = await kv.get(serializePrerenderKey(key));
      if (!raw) return null;

      let stored: PrerenderStoredEntry;
      try {
        stored = JSON.parse(raw) as PrerenderStoredEntry;
      } catch {
        // Corrupt entry: treat as a miss rather than crash the serve path.
        return null;
      }

      // Verify-on-read: version + canonical params (8-hex DJB2 collision guard).
      if (!isStoredEntryValidFor(stored, key, meta)) return null;

      // Tag invalidation is mark-stale: if any tag was invalidated at or after
      // this entry was written, force it stale so SWR schedules a refresh — the
      // entry still serves this request.
      if (stored.meta.tags?.length) {
        const markers = await Promise.all(stored.meta.tags.map(readTagMarker));
        const invalidated = markers.some(
          (m) => m != null && m >= stored.meta.storedAt,
        );
        if (
          invalidated &&
          (stored.meta.staleAt == null ||
            stored.meta.staleAt > stored.meta.storedAt)
        ) {
          stored.meta.staleAt = stored.meta.storedAt;
        }
      }

      return stored;
    },

    async set(
      key: PrerenderKey,
      entry: PrerenderEntry,
      setOptions: PrerenderSetOptions,
    ): Promise<void> {
      const envelope = composeStoredEntry(key, entry, setOptions, now());
      // No expirationTtl: staleAt is soft metadata (see file header).
      await kv.put(serializePrerenderKey(key), JSON.stringify(envelope));
    },

    async delete(key: PrerenderKey): Promise<void> {
      await kv.delete(serializePrerenderKey(key));
    },

    async invalidateTags(tags: string[]): Promise<void> {
      if (tags.length === 0) return;
      const marker = String(now());
      await Promise.all(
        tags.map((tag) => kv.put(PRERENDER_TAG_MARKER_PREFIX + tag, marker)),
      );
    },
  };
}
