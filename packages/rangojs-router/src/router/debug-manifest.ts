import { type EntryData, getContext } from "../server/context";
import { serializeManifest, type SerializedManifest } from "../debug.js";
import { createRouteHelpers } from "../route-definition.js";
import MapRootLayout from "../server/root-layout.js";
import type { RouteEntry, TrailingSlashMode } from "../types";

/**
 * Build a serialized manifest from all route entries for debug inspection.
 * Used by the `debugManifest()` method on the router instance.
 */
export async function buildDebugManifest<TEnv = any>(
  routesEntries: RouteEntry<TEnv>[],
): Promise<SerializedManifest> {
  const manifest = new Map<string, EntryData>();

  for (const entry of routesEntries) {
    const Store = {
      manifest,
      namespace: `debug.M${entry.mountIndex}`,
      parent: null as EntryData | null,
      counters: {} as Record<string, number>,
      mountIndex: entry.mountIndex,
      patterns: new Map<string, string>(),
      trailingSlash: new Map<string, TrailingSlashMode>(),
    };

    await getContext().runWithStore(
      Store,
      `debug.M${entry.mountIndex}`,
      null,
      async () => {
        const helpers = createRouteHelpers();

        // Wrap handler execution in root layout (same as loadManifest)
        let promiseResult: Promise<any> | null = null;
        helpers.layout(MapRootLayout, () => {
          const result = entry.handler();
          if (result instanceof Promise) {
            promiseResult = result;
            return [];
          }
          return result;
        });

        if (promiseResult !== null) {
          const load = await (promiseResult as Promise<any>);
          if (load && typeof load === "object" && "default" in load) {
            // Promise<{ default: fn }> — e.g. dynamic import
            const useItems = load.default;
            if (typeof useItems === "function") {
              useItems(helpers);
            }
          } else if (typeof load === "function") {
            // Promise<fn>
            load(helpers);
          }
          // Promise<Array> — routes already registered by the handler call
        }
      },
    );
  }

  return serializeManifest(manifest);
}
