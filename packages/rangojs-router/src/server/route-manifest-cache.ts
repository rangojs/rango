/**
 * Route Manifest Cache
 *
 * Three-tier caching strategy for route manifest data:
 * 1. In-memory (same isolate) - instant
 * 2. SegmentCacheStore (caches.default on Cloudflare) - ~1-2ms
 * 3. Generate on-demand (cache miss) - ~98ms
 *
 * Benefits:
 * - Removes 725KB bundled manifest from worker code
 * - Typical cold start: 0-2ms (cache hit)
 * - Worst case: ~98ms (first request per colo)
 */

import type { SegmentCacheStore, CachedEntryData } from "../cache/types.js";
import type { GeneratedManifest } from "../build/generate-manifest.js";
import { setCachedManifest, hasCachedManifest } from "../route-map-builder.js";

/**
 * Cached route data structure
 */
interface CachedRouteData {
  /** Route name → pattern mapping for href() */
  routeManifest: Record<string, string>;
  /** Version string for cache invalidation */
  version: string;
}

// ============================================================================
// Tier 1: In-memory singleton (same isolate - instant)
// ============================================================================

let memoryManifest: CachedRouteData | null = null;

/**
 * Options for getRouteManifestData
 */
export interface GetRouteManifestOptions {
  /** Cache store implementation (e.g., CFCacheStore). If omitted, memory-only caching is used. */
  store?: SegmentCacheStore;
  /** Optional function to schedule non-blocking cache write (e.g., ctx.waitUntil) */
  waitUntil?: (promise: Promise<void>) => void;
}

/**
 * Get route manifest data with caching:
 * 1. In-memory (same isolate) - instant
 * 2. SegmentCacheStore (if provided, e.g., CFCacheStore on Cloudflare) - ~1-2ms
 * 3. Generate on-demand (cache miss) - ~98ms
 *
 * When no store is provided, only in-memory caching is used (memory-only mode).
 * This is suitable for development or when external cache is not available.
 *
 * @param generateFn - Function to generate manifest on cache miss
 * @param version - Version string for cache invalidation
 * @param options - Optional cache store and waitUntil function
 * @returns Cached or freshly generated route data
 */
export async function getRouteManifestData(
  generateFn: () => GeneratedManifest,
  version: string,
  options?: GetRouteManifestOptions
): Promise<CachedRouteData> {
  const { store, waitUntil } = options ?? {};
  const cacheKey = `route-manifest:${version}`;

  const startTime = performance.now();

  // 1. In-memory check (same isolate) - instant
  if (memoryManifest?.version === version) {
    console.log("[route-manifest] HIT memory cache (same isolate)");
    return memoryManifest;
  }

  // 2. Cache store check (if store provided) - ~1-2ms
  if (store) {
    try {
      const cached = await store.get(cacheKey);
      if (cached?.data) {
        // Extract manifest from the CachedEntryData wrapper
        const manifest = (cached.data as unknown as { manifest: CachedRouteData }).manifest;
        if (manifest?.version === version) {
          memoryManifest = manifest;
          setCachedManifest(memoryManifest.routeManifest);
          const duration = (performance.now() - startTime).toFixed(2);
          console.log(`[route-manifest] HIT edge cache (${duration}ms, ${Object.keys(manifest.routeManifest).length} routes)`);
          return memoryManifest;
        }
      }
    } catch (error) {
      // Cache miss or error - fall through to generation
      console.warn("[route-manifest] Edge cache read failed:", error);
    }
  }

  // 3. Generate on cache miss - ~98ms
  const generated = generateFn();
  memoryManifest = {
    routeManifest: generated.routeManifest,
    version,
  };
  // Make available to getGlobalRouteMap() for href()
  setCachedManifest(memoryManifest.routeManifest);
  const duration = (performance.now() - startTime).toFixed(2);
  console.log(`[route-manifest] MISS - generated fresh (${duration}ms, ${Object.keys(generated.routeManifest).length} routes)`);

  // Store in cache for other isolates (only if store provided)
  // OFF RENDERING PATH via waitUntil
  if (store) {
    console.log("[route-manifest] Writing to edge cache (via waitUntil)...");
    const cachePromise = (async () => {
      try {
        // Wrap in CachedEntryData format expected by SegmentCacheStore
        const data: CachedEntryData = {
          segments: [],
          handles: {},
          expiresAt: Date.now() + 31536000 * 1000, // 1 year
        };
        // Store manifest in a custom field
        (data as unknown as { manifest: CachedRouteData }).manifest = memoryManifest!;
        await store.set(cacheKey, data, 31536000); // 1 year TTL
        console.log("[route-manifest] Edge cache write complete");
      } catch (error) {
        console.warn("[route-manifest] Edge cache write failed:", error);
      }
    })();

    if (waitUntil) {
      // Non-blocking: cache write happens after response is sent
      waitUntil(cachePromise);
    } else {
      // Fallback: blocking write (dev mode or no waitUntil available)
      await cachePromise;
    }
  }

  return memoryManifest;
}

/**
 * Sync access to in-memory manifest (for href())
 * Returns null if not yet loaded
 *
 * @returns The route manifest or null if not loaded
 */
export function getRouteManifestSync(): Record<string, string> | null {
  return memoryManifest?.routeManifest ?? null;
}

/**
 * Clear in-memory cache (for testing)
 */
export function clearRouteManifestCache(): void {
  memoryManifest = null;
}

/**
 * Check if manifest is loaded in memory
 *
 * @returns true if manifest is available synchronously
 */
export function isManifestLoaded(): boolean {
  return memoryManifest !== null;
}

/**
 * Get the current cached version (for debugging)
 *
 * @returns The version string or null if not loaded
 */
export function getManifestVersion(): string | null {
  return memoryManifest?.version ?? null;
}
