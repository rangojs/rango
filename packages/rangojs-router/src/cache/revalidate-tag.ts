/**
 * Cache Tag Invalidation API
 *
 * Provides revalidateTag() for on-demand cache invalidation.
 * Accesses the cache store via RequestContext and delegates
 * deletion to the store's revalidateTag() implementation.
 */

import { getRequestContext } from "../server/request-context.js";

/**
 * Invalidate all cache entries tagged with the given tag.
 *
 * Typically called from server actions after data mutations.
 * The invalidation runs asynchronously via waitUntil() so it
 * does not block the response.
 *
 * Requires a cache store that implements revalidateTag().
 * MemorySegmentCacheStore supports this; CFCacheStore logs a warning.
 *
 * @example
 * ```typescript
 * async function updateProduct(formData) {
 *   "use server";
 *   await db.updateProduct(formData);
 *   revalidateTag("products");
 * }
 * ```
 */
export function revalidateTag(tag: string): void {
  const ctx = getRequestContext();
  if (!ctx?._cacheStore?.revalidateTag) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[revalidateTag] No cache store with tag support available. ` +
          `Tag "${tag}" was not invalidated.`,
      );
    }
    return;
  }
  const store = ctx._cacheStore;
  ctx.waitUntil(async () => {
    await store.revalidateTag!(tag);
  });
}
