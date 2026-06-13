/**
 * Cache Tag API
 *
 * Provides cacheTag() for tagging cached entries at runtime inside "use cache"
 * functions. Tags are scoped via AsyncLocalStorage; calling cacheTag() outside
 * a "use cache" execution throws.
 *
 * The runtime (cache-runtime.ts) wraps "use cache" execution in
 * runWithCacheTagScope(), collects the runtime tags, and merges them with the
 * profile/DSL tags before storing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  _getRequestContext,
  type RequestContext,
} from "../server/request-context.js";

const cacheTagStorage = new AsyncLocalStorage<Set<string>>();

/**
 * Normalize a tag for storage.
 *
 * Returns the tag unchanged if usable, or null if it is empty/whitespace-only
 * (dropped consistently in every environment - an empty tag matches nothing).
 *
 * Backend-specific constraints are intentionally NOT enforced here so the tag
 * primitive stays backend-agnostic. In particular, the CFCacheStore
 * encodeURIComponent's tags at serialization time so commas/spaces/non-Latin1
 * characters cannot corrupt the comma-delimited Cloudflare Cache-Tag header or
 * the HTTP marker header (it does not reject them). Keep tags short and
 * low-cardinality: a tag's KV marker key must stay under Cloudflare's 512-byte
 * limit, and a Cache-Tag value under 1024 bytes. The in-memory store has no
 * such limitations.
 *
 * @internal
 */
export function normalizeTag(tag: string): string | null {
  if (!tag || !tag.trim()) return null;
  return tag;
}

/**
 * Normalize a tag collection: drop empty/whitespace-only tags so the WRITE path
 * matches the invalidate path (updateTag/revalidateTag/cacheTag all normalize).
 * Does not deduplicate - callers that need that wrap with a Set.
 *
 * @internal
 */
export function normalizeTags(tags: Iterable<string>): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized !== null) out.push(normalized);
  }
  return out;
}

/**
 * Tag the current "use cache" entry for later invalidation via
 * updateTag() / revalidateTag().
 *
 * Must be called inside a function marked with "use cache".
 * Tags are additive - multiple calls accumulate.
 *
 * @example
 * ```typescript
 * async function getProduct(ctx) {
 *   "use cache";
 *   cacheTag(`product:${ctx.params.id}`, "products");
 *   return db.getProduct(ctx.params.id);
 * }
 * ```
 */
export function cacheTag(...tags: string[]): void {
  const store = cacheTagStorage.getStore();
  if (!store) {
    throw new Error('cacheTag() must be called inside a "use cache" function.');
  }
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized === null) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[cacheTag] Ignoring empty or whitespace-only tag.`);
      }
      continue;
    }
    store.add(normalized);
  }
}

/**
 * Record `tags` into the request-scoped tag set (ctx._requestTags), the union of
 * every cache tag resolved while producing the response. The document cache reads
 * this after the render settles so a full-page entry is tagged with everything its
 * content used, making it invalidatable by updateTag()/revalidateTag().
 *
 * Called at the tag-resolution sites: "use cache" stores (cache-runtime, both the
 * miss and read/hit paths), loader cache (cache-policy/loader-cache), and segment
 * cache() (cache-scope). Writes the field directly (not via ctx.set()) so it does
 * not trip the cache-scope side-effect guard, mirroring cacheTag() itself.
 *
 * @internal
 */
export function recordRequestTags(
  tags: Iterable<string> | undefined,
  ctx: RequestContext | undefined = _getRequestContext(),
): void {
  if (!tags) return;
  const set = ctx?._requestTags;
  if (!set) return;
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized !== null) set.add(normalized);
  }
}

/**
 * Run a function within a cache tag scope. Any cacheTag() calls inside `fn`
 * accumulate into the returned Set.
 *
 * The returned Set is the LIVE reference - the caller must await `result`
 * before reading `tags`, because an async cached function may call cacheTag()
 * after an await boundary.
 *
 * @internal Used by cache-runtime.ts to wrap "use cache" execution.
 */
export function runWithCacheTagScope<T>(fn: () => T): {
  result: T;
  tags: Set<string>;
} {
  const tagSet = new Set<string>();
  const result = cacheTagStorage.run(tagSet, fn);
  return { result, tags: tagSet };
}
