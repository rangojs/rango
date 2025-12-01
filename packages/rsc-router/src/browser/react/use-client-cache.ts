"use client";

import { useContext, useCallback } from "react";
import { NavigationStoreContext } from "./context.js";

/**
 * Return type for useClientCache hook
 */
export interface ClientCacheControls {
  /**
   * Clear the client-side navigation cache.
   * Call this after data changes that happen outside of server actions
   * (e.g., REST API calls, WebSocket updates, etc.)
   *
   * This will also broadcast to other tabs to clear their caches.
   */
  clear: () => void;
}

/**
 * Hook to access client-side cache controls
 *
 * Use this when you need to manually invalidate the navigation cache
 * after data changes that happen outside of server actions.
 *
 * Server actions automatically clear the cache, so you only need this for:
 * - REST API mutations
 * - WebSocket-driven updates
 * - Other non-RSC data changes
 *
 * @example
 * ```tsx
 * function DataEditor() {
 *   const { clear } = useClientCache();
 *
 *   async function handleSave() {
 *     await fetch('/api/data', { method: 'POST', body: JSON.stringify(data) });
 *     // Clear cache so back/forward navigation shows fresh data
 *     clear();
 *   }
 *
 *   return <button onClick={handleSave}>Save</button>;
 * }
 * ```
 */
export function useClientCache(): ClientCacheControls {
  const ctx = useContext(NavigationStoreContext);

  const clear = useCallback(() => {
    if (ctx?.store) {
      ctx.store.clearHistoryCache();
    }
  }, [ctx]);

  return { clear };
}
