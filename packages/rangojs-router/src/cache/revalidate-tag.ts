/**
 * Cache Tag Invalidation API
 *
 * Provides revalidateTag() for on-demand cache invalidation.
 * Invalidates across all stores that have received tagged writes,
 * including explicit per-scope stores from cache({ store: ... }).
 */

import { getRequestContext } from "../server/request-context.js";
import { getTaggedStores } from "./tag-store-registry.js";

/**
 * Invalidate all cache entries tagged with the given tag.
 *
 * Typically called from server actions after data mutations.
 * The invalidation runs asynchronously via waitUntil() so it
 * does not block the response.
 *
 * Invalidates across all stores that have received tagged entries,
 * including explicit per-scope stores from cache({ store: ... }).
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

  // Collect all stores that need invalidation
  const stores = new Set<{ revalidateTag(tag: string): Promise<void> }>();

  // App-level store from request context
  if (ctx?._cacheStore?.revalidateTag) {
    stores.add(ctx._cacheStore as { revalidateTag(tag: string): Promise<void> });
  }

  // All stores that have received tagged writes (includes explicit per-scope stores)
  for (const store of getTaggedStores()) {
    if (store.revalidateTag) {
      stores.add(store as { revalidateTag(tag: string): Promise<void> });
    }
  }

  if (stores.size === 0) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[revalidateTag] No cache store with tag support available. ` +
          `Tag "${tag}" was not invalidated.`,
      );
    }
    return;
  }

  if (ctx?.waitUntil) {
    ctx.waitUntil(async () => {
      await Promise.all(
        [...stores].map((store) => store.revalidateTag(tag)),
      );
    });
  } else {
    // No waitUntil (e.g. outside request context): run as best-effort
    Promise.all(
      [...stores].map((store) => store.revalidateTag(tag)),
    ).catch(() => {});
  }
}
