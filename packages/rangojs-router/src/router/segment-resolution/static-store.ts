/**
 * Static Store
 *
 * Lazy-initialized static store for production Static handler interception.
 * Manages the build-time static manifest lookup for pre-rendered components.
 */

import type { ReactNode } from "react";
import { _getRequestContext } from "../../server/request-context.js";
import type { StaticStore } from "../../prerender/store.js";
import type { SegmentHandleData } from "../../cache/types.js";

// Lazy-initialized static store for production Static handler interception.
// undefined = not yet checked; null = checked, no manifest (dev mode, or an
// app without Static handlers) — a permanent SYNCHRONOUS fast path: no await
// may ever run on that path (an await per lookup disrupts AsyncLocalStorage
// in workerd/Cloudflare runtime).
//
// The check happens on the FIRST LOOKUP, not at module eval: the manifest
// loader global (__loadStaticManifestModule, bundle-postprocess.ts) is
// assigned by the RSC entry's BODY, which runs after hoisted module imports
// evaluate this file — an eval-time read here could never see it. The
// pre-#760 eager `import "./__static-manifest.js"` existed precisely to beat
// that hoisting; deferring the manifest module keeps its O(#Static handlers)
// thunk table off the worker's cold-start path.
let _staticStore: StaticStore | null | undefined = undefined;
let _deserializeComponent: ((encoded: string) => Promise<unknown>) | undefined;
let _decodeHandleValue:
  | typeof import("../../cache/handle-snapshot.js").decodeHandleValue
  | undefined;

async function ensureStaticDeps(): Promise<void> {
  if (_staticStore === undefined) {
    // Evaluate the deferred manifest module (it assigns __STATIC_MANIFEST);
    // support a pre-set __STATIC_MANIFEST too (tests, non-postprocess embeds).
    if (
      !globalThis.__STATIC_MANIFEST &&
      globalThis.__loadStaticManifestModule
    ) {
      await globalThis.__loadStaticManifestModule();
    }
    if (!globalThis.__STATIC_MANIFEST) {
      _staticStore = null;
      return;
    }
    const { createStaticStore } = await import("../../prerender/store.js");
    _staticStore = createStaticStore();
  }
  if (!_deserializeComponent && _staticStore) {
    const { deserializeComponent } =
      await import("../../cache/segment-codec.js");
    _deserializeComponent = deserializeComponent;
    const { decodeHandleValue } =
      await import("../../cache/handle-snapshot.js");
    _decodeHandleValue = decodeHandleValue;
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
  // Fast path: no manifest available (dev mode or no Static handlers).
  // Latched SYNCHRONOUSLY — including on the very first call — so this path
  // never awaits (an await here disrupts AsyncLocalStorage in
  // workerd/Cloudflare runtime).
  if (
    _staticStore === undefined &&
    !globalThis.__STATIC_MANIFEST &&
    !globalThis.__loadStaticManifestModule
  ) {
    _staticStore = null;
  }
  if (_staticStore === null) return undefined;
  await ensureStaticDeps();
  if (!_staticStore || !_deserializeComponent) return undefined;
  const entry = await _staticStore.get(handlerId);
  if (!entry) return undefined;

  // Replay handle data captured during build-time rendering. entry.handles is a
  // Flight-encoded string ("" when none) — decode before replay so
  // Promise/ReactNode handle values are revived. The data was keyed by handlerId
  // at build time; replay under segmentId so it matches the segment order used
  // by useHandle on the client.
  if (entry.handles && _decodeHandleValue) {
    const handleStore = _getRequestContext()?._handleStore;
    if (handleStore) {
      const segHandles = await _decodeHandleValue<SegmentHandleData>(
        entry.handles,
      );
      if (segHandles) {
        handleStore.replaySegmentData(segmentId, segHandles);
      }
    }
  }

  return _deserializeComponent(entry.encoded) as Promise<ReactNode>;
}
