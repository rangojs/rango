/**
 * Debug utilities for manifest inspection and comparison
 */

import type { EntryData } from "./server/context";

/**
 * Serialized entry for debug output
 */
export interface SerializedEntry {
  id: string;
  shortCode: string;
  type: string;
  parentShortCode: string | null;
  pattern?: string;
  hasLoader: boolean;
  hasMiddleware: boolean;
  hasErrorBoundary: boolean;
  parallelCount: number;
  interceptCount: number;
}

/**
 * Serialized manifest structure
 */
export interface SerializedManifest {
  routes: Record<string, SerializedEntry>;
  layouts: Record<string, SerializedEntry>;
  totalRoutes: number;
  totalLayouts: number;
}

/**
 * Serialize a manifest Map into a JSON-friendly structure
 */
export function serializeManifest(
  manifest: Map<string, EntryData>
): SerializedManifest {
  const routes: Record<string, SerializedEntry> = {};
  const layouts: Record<string, SerializedEntry> = {};

  // Collect all entries including parents
  const allEntries = new Map<string, EntryData>();

  for (const [key, entry] of manifest.entries()) {
    allEntries.set(key, entry);

    // Walk up parent chain to collect all layouts
    let parent = entry.parent;
    while (parent) {
      if (!allEntries.has(parent.id)) {
        allEntries.set(parent.id, parent);
      }
      parent = parent.parent;
    }
  }

  for (const [key, entry] of allEntries.entries()) {
    const serialized: SerializedEntry = {
      id: entry.id,
      shortCode: entry.shortCode,
      type: entry.type,
      parentShortCode: entry.parent?.shortCode ?? null,
      hasLoader: entry.loader?.length > 0,
      hasMiddleware: entry.middleware?.length > 0,
      hasErrorBoundary: entry.errorBoundary?.length > 0,
      parallelCount: entry.parallel?.length ?? 0,
      interceptCount: entry.intercept?.length ?? 0,
    };

    if (entry.type === "route" && "pattern" in entry) {
      serialized.pattern = entry.pattern;
    }

    if (entry.type === "route") {
      routes[key] = serialized;
    } else if (entry.type === "layout" || entry.type === "cache") {
      layouts[key] = serialized;
    }
  }

  return {
    routes,
    layouts,
    totalRoutes: Object.keys(routes).length,
    totalLayouts: Object.keys(layouts).length,
  };
}

/**
 * Compare two manifests and return differences
 */
export function compareManifests(
  oldManifest: SerializedManifest,
  newManifest: SerializedManifest
): {
  addedRoutes: string[];
  removedRoutes: string[];
  changedRoutes: Array<{
    key: string;
    field: string;
    old: any;
    new: any;
  }>;
  addedLayouts: string[];
  removedLayouts: string[];
  changedLayouts: Array<{
    key: string;
    field: string;
    old: any;
    new: any;
  }>;
} {
  const addedRoutes: string[] = [];
  const removedRoutes: string[] = [];
  const changedRoutes: Array<{ key: string; field: string; old: any; new: any }> = [];
  const addedLayouts: string[] = [];
  const removedLayouts: string[] = [];
  const changedLayouts: Array<{ key: string; field: string; old: any; new: any }> = [];

  // Compare routes
  const oldRouteKeys = new Set(Object.keys(oldManifest.routes));
  const newRouteKeys = new Set(Object.keys(newManifest.routes));

  for (const key of newRouteKeys) {
    if (!oldRouteKeys.has(key)) {
      addedRoutes.push(key);
    }
  }

  for (const key of oldRouteKeys) {
    if (!newRouteKeys.has(key)) {
      removedRoutes.push(key);
    } else {
      // Compare fields
      const oldEntry = oldManifest.routes[key];
      const newEntry = newManifest.routes[key];
      for (const field of Object.keys(oldEntry) as (keyof SerializedEntry)[]) {
        if (oldEntry[field] !== newEntry[field]) {
          changedRoutes.push({
            key,
            field,
            old: oldEntry[field],
            new: newEntry[field],
          });
        }
      }
    }
  }

  // Compare layouts
  const oldLayoutKeys = new Set(Object.keys(oldManifest.layouts));
  const newLayoutKeys = new Set(Object.keys(newManifest.layouts));

  for (const key of newLayoutKeys) {
    if (!oldLayoutKeys.has(key)) {
      addedLayouts.push(key);
    }
  }

  for (const key of oldLayoutKeys) {
    if (!newLayoutKeys.has(key)) {
      removedLayouts.push(key);
    } else {
      const oldEntry = oldManifest.layouts[key];
      const newEntry = newManifest.layouts[key];
      for (const field of Object.keys(oldEntry) as (keyof SerializedEntry)[]) {
        if (oldEntry[field] !== newEntry[field]) {
          changedLayouts.push({
            key,
            field,
            old: oldEntry[field],
            new: newEntry[field],
          });
        }
      }
    }
  }

  return {
    addedRoutes,
    removedRoutes,
    changedRoutes,
    addedLayouts,
    removedLayouts,
    changedLayouts,
  };
}

/**
 * Format manifest diff as a human-readable string
 */
export function formatManifestDiff(
  diff: ReturnType<typeof compareManifests>
): string {
  const lines: string[] = [];

  if (diff.addedRoutes.length > 0) {
    lines.push("Added routes:");
    diff.addedRoutes.forEach((r) => lines.push(`  + ${r}`));
  }

  if (diff.removedRoutes.length > 0) {
    lines.push("Removed routes:");
    diff.removedRoutes.forEach((r) => lines.push(`  - ${r}`));
  }

  if (diff.changedRoutes.length > 0) {
    lines.push("Changed routes:");
    diff.changedRoutes.forEach((c) =>
      lines.push(`  ~ ${c.key}.${c.field}: ${c.old} -> ${c.new}`)
    );
  }

  if (diff.addedLayouts.length > 0) {
    lines.push("Added layouts:");
    diff.addedLayouts.forEach((l) => lines.push(`  + ${l}`));
  }

  if (diff.removedLayouts.length > 0) {
    lines.push("Removed layouts:");
    diff.removedLayouts.forEach((l) => lines.push(`  - ${l}`));
  }

  if (diff.changedLayouts.length > 0) {
    lines.push("Changed layouts:");
    diff.changedLayouts.forEach((c) =>
      lines.push(`  ~ ${c.key}.${c.field}: ${c.old} -> ${c.new}`)
    );
  }

  return lines.length > 0 ? lines.join("\n") : "No differences found";
}
