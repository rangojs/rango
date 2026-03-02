/**
 * Cache Tag Invalidation API
 *
 * Provides revalidateTag() for on-demand cache invalidation.
 * Invalidates across the app-level store and any explicit per-scope
 * stores from cache({ store: ... }) that belong to this handler.
 */

import { getRequestContext } from "../server/request-context.js";

/**
 * Invalidate all cache entries tagged with the given tag.
 *
 * Typically called from server actions after data mutations.
 * The invalidation runs asynchronously via waitUntil() so it
 * does not block the response.
 *
 * Invalidates across the app-level store and any explicit per-scope
 * stores registered by this handler's cache({ store }) boundaries.
 * In multi-router deployments, only the current handler's stores
 * are affected.
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

  // Collect all stores that need invalidation (deduplicated via Set)
  const stores = new Set<{ revalidateTag(tag: string): Promise<void> }>();

  // App-level store from request context
  if (ctx?._cacheStore?.revalidateTag) {
    stores.add(
      ctx._cacheStore as { revalidateTag(tag: string): Promise<void> },
    );
  }

  // Explicit per-scope stores scoped to this handler
  if (ctx?._explicitTaggedStores) {
    for (const store of ctx._explicitTaggedStores) {
      if (store.revalidateTag) {
        stores.add(store as { revalidateTag(tag: string): Promise<void> });
      }
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
      await Promise.all([...stores].map((store) => store.revalidateTag(tag)));
    });
  } else {
    // No waitUntil (e.g. outside request context): run as best-effort
    Promise.all([...stores].map((store) => store.revalidateTag(tag))).catch(
      () => {},
    );
  }
}
