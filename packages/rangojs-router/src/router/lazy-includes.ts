import { registerRouteMap } from "../route-map-builder.js";
import { extractStaticPrefix } from "./pattern-matching.js";
import {
  type EntryData,
  RSCRouterContext,
  runWithPrefixes,
  getIsolatedLazyParent,
} from "../server/context";
import type { UrlPatterns } from "../urls.js";
import type { AllUseItems, IncludeItem } from "../route-types.js";
import type { ResolvedRouteMap, RouteEntry, TrailingSlashMode } from "../types";

export interface LazyEvalDeps<TEnv = any> {
  routesEntries: RouteEntry<TEnv>[];
  mergedRouteMap: Record<string, string>;
  nextMountIndex: () => number;
  getPrecomputedByPrefix: () => Map<string, Record<string, string>> | null;
  routerId?: string;
}

// Detect lazy includes in handler result and create placeholder entries
// Lazy includes are IncludeItem with lazy: true and _lazyContext
// Moved to outer scope so it can be reused by evaluateLazyEntry for nested includes
export function findLazyIncludes<TEnv = any>(
  items: AllUseItems[],
): Array<{
  prefix: string;
  patterns: UrlPatterns<TEnv>;
  context: {
    urlPrefix: string;
    namePrefix: string | undefined;
    parent: unknown;
    rootScoped?: boolean;
  };
}> {
  const lazyItems: Array<{
    prefix: string;
    patterns: UrlPatterns<TEnv>;
    context: {
      urlPrefix: string;
      namePrefix: string | undefined;
      parent: unknown;
      rootScoped?: boolean;
    };
  }> = [];

  for (const item of items) {
    if (!item) continue;
    if (item.type === "include") {
      const includeItem = item as IncludeItem;
      if (includeItem.lazy === true && includeItem._lazyContext) {
        lazyItems.push({
          prefix: includeItem.prefix,
          patterns: includeItem.patterns as UrlPatterns<TEnv>,
          context: includeItem._lazyContext,
        });
      }
    }
    // Recursively check nested items (in layouts, etc.)
    if ((item as any).uses && Array.isArray((item as any).uses)) {
      lazyItems.push(...findLazyIncludes((item as any).uses));
    }
  }

  return lazyItems;
}

/**
 * Evaluate a lazy entry's patterns and populate its routes
 * This runs the lazy patterns handler and updates the entry in-place
 * Also detects nested lazy includes and registers them as new entries
 */
export function evaluateLazyEntry<TEnv = any>(
  entry: RouteEntry<TEnv>,
  deps: LazyEvalDeps<TEnv>,
): void {
  if (!entry.lazy || entry.lazyEvaluated || !entry.lazyPatterns) {
    return;
  }

  // Check for pre-computed routes from build-time data.
  // Only leaf nodes (no nested includes) are precomputed, so entries with
  // nested lazy includes fall through to the handler below.
  // When multiple entries share the same staticPrefix (e.g., several
  // include("/", ...) calls), the precomputed data merges all their routes
  // into one entry. Assigning that merged set to the first matching entry
  // causes findMatch to pick the wrong handler for routes belonging to a
  // different include. Skip the shortcut when the prefix is shared.
  const currentPrecomputed = deps.getPrecomputedByPrefix();
  if (currentPrecomputed) {
    const routes = currentPrecomputed.get(entry.staticPrefix);
    if (routes) {
      const prefixIsShared =
        deps.routesEntries.filter((e) => e.staticPrefix === entry.staticPrefix)
          .length > 1;
      if (!prefixIsShared) {
        entry.lazyEvaluated = true;
        entry.routes = routes as ResolvedRouteMap<any>;
        for (const [name, pattern] of Object.entries(routes)) {
          deps.mergedRouteMap[name] = pattern;
        }
        registerRouteMap(deps.mergedRouteMap);
        return;
      }
    }
  }

  // Mark as evaluated immediately to prevent concurrent evaluation.
  // JS is single-threaded but handlers.handler() could theoretically yield,
  // and the while-loop in findMatch retries after evaluation.
  entry.lazyEvaluated = true;

  const lazyPatterns = entry.lazyPatterns as UrlPatterns<TEnv>;
  const lazyContext = entry.lazyContext;

  // Create a new context for evaluating the lazy patterns
  const manifest = new Map<string, EntryData>();
  const patterns = new Map<string, string>();
  const patternsByPrefix = new Map<string, Map<string, string>>();
  const trailingSlashMap = new Map<string, TrailingSlashMode>();

  // Capture the handler result to detect nested lazy includes
  let handlerResult: AllUseItems[] = [];

  // Merge captured counters from include() to maintain consistent
  // shortCode indices with sibling entries from pattern extraction
  const lazyCounters: Record<string, number> = {};
  if (lazyContext?.counters) {
    for (const [key, value] of Object.entries(lazyContext.counters)) {
      lazyCounters[key] = value;
    }
  }

  RSCRouterContext.run(
    {
      manifest,
      patterns,
      patternsByPrefix,
      trailingSlash: trailingSlashMap,
      namespace: "lazy",
      parent: getIsolatedLazyParent(lazyContext?.parent as EntryData | null),
      counters: lazyCounters,
      cacheProfiles: lazyContext?.cacheProfiles,
      rootScoped: lazyContext?.rootScoped,
      includeScope: lazyContext?.includeScope,
    },
    () => {
      // Run the lazy patterns handler with the original context prefixes
      // The prefix comes from the IncludeItem stored in lazyPatterns
      const includePrefix = (entry as any)._lazyPrefix || "";
      const fullPrefix = (lazyContext?.urlPrefix || "") + includePrefix;

      if (fullPrefix || lazyContext?.namePrefix) {
        runWithPrefixes(fullPrefix, lazyContext?.namePrefix, () => {
          handlerResult = lazyPatterns.handler() as AllUseItems[];
        });
      } else {
        handlerResult = lazyPatterns.handler() as AllUseItems[];
      }
    },
  );

  // Populate the entry's routes from the patterns
  const routesObject: Record<string, string> = {};
  for (const [name, pattern] of patterns.entries()) {
    routesObject[name] = pattern;
    // Also add to merged route map for reverse() support
    const existingPattern = deps.mergedRouteMap[name];
    if (existingPattern !== undefined && existingPattern !== pattern) {
      console.warn(
        `[@rangojs/router] Route name conflict: "${name}" already maps to "${existingPattern}", ` +
          `overwriting with "${pattern}" (from lazy include). Use unique route names to avoid this.`,
      );
    }
    deps.mergedRouteMap[name] = pattern;
  }

  // Update the entry in-place
  entry.routes = routesObject as ResolvedRouteMap<any>;

  // Note: Do NOT clear lazyPatterns/lazyContext here.
  // loadManifest() needs them on every request to re-run the handler
  // in the correct AsyncLocalStorage context (Store.manifest).

  // Update trailing slash config if available
  if (trailingSlashMap.size > 0) {
    entry.trailingSlash = Object.fromEntries(trailingSlashMap);
  }

  // Detect nested lazy includes and register them as new entries
  const nestedLazyIncludes = findLazyIncludes(handlerResult);
  for (const lazyInclude of nestedLazyIncludes) {
    // Compute the full URL prefix (combining parent prefix if any)
    const fullPrefix = lazyInclude.context.urlPrefix
      ? lazyInclude.context.urlPrefix + lazyInclude.prefix
      : lazyInclude.prefix;

    const nestedEntry: RouteEntry<TEnv> & { _lazyPrefix?: string } = {
      prefix: "",
      staticPrefix: extractStaticPrefix(fullPrefix),
      routes: {} as ResolvedRouteMap<any>, // Empty until first match
      trailingSlash: entry.trailingSlash,
      handler: (lazyInclude.patterns as UrlPatterns<TEnv>).handler,
      mountIndex: deps.nextMountIndex(),
      routerId: deps.routerId,
      // Lazy evaluation fields
      lazy: true,
      lazyPatterns: lazyInclude.patterns,
      lazyContext: lazyInclude.context,
      lazyEvaluated: false,
      // Store the include prefix for evaluation
      _lazyPrefix: lazyInclude.prefix,
    };
    // Insert nested lazy entry before any entry whose staticPrefix is a
    // prefix of (but shorter than) this lazy entry's staticPrefix.
    // This ensures more specific lazy includes are matched before
    // less specific eager entries (e.g., "/href/nested" before "/href/:id").
    const nestedPrefix = nestedEntry.staticPrefix;
    let insertIndex = deps.routesEntries.length;
    if (nestedPrefix) {
      for (let i = 0; i < deps.routesEntries.length; i++) {
        const existing = deps.routesEntries[i]!;
        if (
          nestedPrefix.startsWith(existing.staticPrefix) &&
          nestedPrefix.length > existing.staticPrefix.length
        ) {
          insertIndex = i;
          break;
        }
      }
    }
    deps.routesEntries.splice(insertIndex, 0, nestedEntry);
  }

  // Re-register route map for runtime reverse() usage
  registerRouteMap(deps.mergedRouteMap);
}
