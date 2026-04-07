/**
 * Cache Tag API
 *
 * Provides cacheTag() for tagging cached entries at runtime inside "use cache" functions.
 * Tags are scoped via AsyncLocalStorage — calling cacheTag() outside a "use cache"
 * execution throws an error.
 *
 * The runtime (cache-runtime.ts) wraps "use cache" function execution in
 * runWithCacheTagScope(), collects runtime tags, and merges them with profile tags
 * before storing.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const cacheTagStorage = new AsyncLocalStorage<Set<string>>();

/**
 * Tag the current "use cache" entry for later invalidation via revalidateTag().
 *
 * Must be called inside a function marked with "use cache".
 * Tags are additive — multiple calls accumulate tags.
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
    if (process.env.NODE_ENV !== "production") {
      if (!tag || !tag.trim()) {
        console.warn(`[cacheTag] Ignoring empty or whitespace-only tag.`);
        continue;
      }
      if (tag.includes(",")) {
        throw new Error(
          `[cacheTag] Tag "${tag}" contains a comma, which breaks Cloudflare Cache-Tag header round-tripping. Use separate tags instead.`,
        );
      }
    }
    store.add(tag);
  }
}

/**
 * Run a function within a cache tag scope.
 * Any cacheTag() calls inside fn will be captured.
 *
 * @internal Used by cache-runtime.ts to wrap "use cache" function execution.
 */
export function runWithCacheTagScope<T>(fn: () => T): {
  result: T;
  tags: Set<string>;
} {
  const tagSet = new Set<string>();
  const result = cacheTagStorage.run(tagSet, fn);
  // Return the live Set reference — caller must await result before reading tags,
  // since async functions may call cacheTag() after await boundaries.
  return { result, tags: tagSet };
}
