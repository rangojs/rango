import { MemorySegmentCacheStore } from "@rangojs/router/cache";

// One store for both apps, as a deployed multi-router worker's KV-backed store
// is. With the hostOverride cookie both apps serve the same host and path, so
// nothing but the router keeps their entries apart (issue #1065).
export const cacheStore = new MemorySegmentCacheStore();
