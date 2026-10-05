/**
 * The store scope `router.prerender()` gates a warm on
 * (prerender/create-prerender-trigger.ts). See
 * docs/design/prerender-every-route.md, "The store declaration".
 */

import type { CacheStoreScope, SegmentCacheStore } from "./types.js";
import { MemorySegmentCacheStore } from "./memory-segment-store.js";

/**
 * True under the Vite dev server: only its routes-manifest virtual module sets
 * the dev origin (vite/discovery/virtual-module-codegen.ts). A build, a preview
 * server and a test runner answer false.
 */
export function isViteDevServer(): boolean {
  return typeof globalThis.__PRERENDER_DEV_URL === "string";
}

/**
 * The scope a warm treats `store` as having: its own declaration, with none
 * or an unknown value being `"local"`.
 *
 * One exception: under the Vite dev server a MemorySegmentCacheStore answers
 * `"global"`, because that one process serves every request. Production reads
 * the class's own `scope` (`"local"`): changing that declaration is what
 * would admit it there.
 */
export function resolveWarmStoreScope(
  store: SegmentCacheStore<any>,
  devServer: boolean = isViteDevServer(),
): CacheStoreScope {
  const declared = store.scope;
  if (declared === "global" || declared === "regional") return declared;
  if (devServer && store instanceof MemorySegmentCacheStore) return "global";
  return "local";
}
