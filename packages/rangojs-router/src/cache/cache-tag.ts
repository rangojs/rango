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

export function normalizeTag(tag: string): string | null {
  // Trim and return the canonical (trimmed) form, not the raw tag. Both the
  // write path (cacheTag) and the invalidate path (updateTag/revalidateTag)
  // route through here, and matching is exact-string: returning the untrimmed
  // tag made cacheTag(" products ") and updateTag("products") two different
  // logical tags, a silent failure-to-invalidate (stale data served forever).
  const trimmed = tag?.trim();
  return trimmed ? trimmed : null;
}

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
