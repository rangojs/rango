/**
 * Static Store
 *
 * Lazy-initialized static store for production Static handler interception.
 * Manages the build-time static manifest lookup for pre-rendered components.
 */

import type { ReactNode } from "react";
import { getRequestContext } from "../../server/request-context.js";
import type { StaticStore } from "../../prerender/store.js";

// Lazy-initialized static store for production Static handler interception.
// Remains undefined until first check; null means checked but no manifest.
// When no __STATIC_MANIFEST exists (dev mode), set to null eagerly to avoid
// the dynamic import() in ensureStaticDeps() which disrupts AsyncLocalStorage
// in workerd/Cloudflare runtime.
let _staticStore: StaticStore | null | undefined =
  typeof globalThis !== "undefined" && globalThis.__STATIC_MANIFEST
    ? undefined
    : null;
let _deserializeComponent: ((encoded: string) => Promise<unknown>) | undefined;

async function ensureStaticDeps(): Promise<void> {
  if (_staticStore === undefined) {
    const { createStaticStore } = await import("../../prerender/store.js");
    _staticStore = createStaticStore();
  }
  if (!_deserializeComponent && _staticStore) {
    const { deserializeComponent } =
      await import("../../cache/segment-codec.js");
    _deserializeComponent = deserializeComponent;
  }
}

/**
 * Try to load a pre-rendered Static component from the build-time store.
 * Returns the deserialized React element, or undefined if not available.
 * Also replays any handle data captured at build time into the request's HandleStore.
 *
 * @param handlerId - The handler's $$id used to look up the static store entry.
 * @param segmentId - The runtime segment shortCode. Handle data is replayed under
 *   this key so that useHandle's segmentOrder matching works correctly.
 */
export async function tryStaticLookup(
  handlerId: string,
  segmentId: string,
): Promise<ReactNode | undefined> {
  // Fast path: already checked and no manifest available (dev mode or no Static handlers).
  // Avoids await which can disrupt AsyncLocalStorage in workerd/Cloudflare runtime.
  if (_staticStore === null) return undefined;
  await ensureStaticDeps();
  if (!_staticStore || !_deserializeComponent) return undefined;
  const entry = await _staticStore.get(handlerId);
  if (!entry) return undefined;

  // Replay handle data captured during build-time rendering.
  // The data was keyed by handlerId at build time; replay under segmentId
  // so it matches the segment order used by useHandle on the client.
  if (entry.handles && Object.keys(entry.handles).length > 0) {
    const handleStore = getRequestContext()?._handleStore;
    if (handleStore) {
      handleStore.replaySegmentData(segmentId, entry.handles);
    }
  }

  return _deserializeComponent(entry.encoded) as Promise<ReactNode>;
}
