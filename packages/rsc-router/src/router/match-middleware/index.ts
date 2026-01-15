/**
 * Match Middleware
 *
 * Async generator middleware for the match pipeline.
 * Each middleware transforms or enriches the segment stream.
 */

export { withCacheLookup } from "./cache-lookup.js";
export { withSegmentResolution } from "./segment-resolution.js";
export { withInterceptResolution } from "./intercept-resolution.js";
export { withCacheStore } from "./cache-store.js";
export { withBackgroundRevalidation } from "./background-revalidation.js";
export type { GeneratorMiddleware } from "./cache-lookup.js";
