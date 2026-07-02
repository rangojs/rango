import { registerRouteMap } from "../route-map-builder.js";
import { extractStaticPrefix, joinPrefix } from "./pattern-matching.js";
import {
  type EntryData,
  RangoContext,
  runWithPrefixes,
  getIsolatedLazyParent,
} from "../server/context";
import type { UrlPatterns } from "../urls.js";
import type { AllUseItems, IncludeItem } from "../route-types.js";
import type { ResolvedRouteMap, RouteEntry, TrailingSlashMode } from "../types";
import {
  isIncludeProvider,
  resolveIncludeModule,
} from "../urls/include-provider.js";

export interface LazyEvalDeps<TEnv = any> {
  routesEntries: RouteEntry<TEnv>[];
  mergedRouteMap: Record<string, string>;
  nextMountIndex: () => number;
  getPrecomputedByPrefix: () => Map<string, Record<string, string>> | null;
  routerId?: string;
}

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
): void | Promise<void> {
  if (!entry.lazy || entry.lazyEvaluated || !entry.lazyPatterns) {
    return;
  }

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

  // Async provider (`() => import("./routes")`): the route module is evaluated
  // off the startup path, on the first request reaching this prefix. Concurrent
  // first-hits share one in-flight promise so the import + expansion run exactly
  // once. The eager path below stays fully synchronous (no Promise), so the
  // per-entry match loop pays no microtask for normal includes.
  const lazyPatterns = entry.lazyPatterns;
  if (isIncludeProvider(lazyPatterns)) {
    const inflight = (entry as { _lazyInflight?: Promise<void> })._lazyInflight;
    if (inflight) return inflight;
    const work = (async () => {
      const resolved = resolveIncludeModule(
        await lazyPatterns(),
        entry.staticPrefix,
      );
      // Cache the resolved patterns: any later re-entry expands synchronously.
      entry.lazyPatterns = resolved as unknown as UrlPatterns<TEnv>;
      runExpansion(entry, deps, resolved as UrlPatterns<TEnv>);
    })();
    (entry as { _lazyInflight?: Promise<void> })._lazyInflight = work;
    const clear = () => {
      (entry as { _lazyInflight?: Promise<void> })._lazyInflight = undefined;
    };
    // On failure, clear the flag (lazyEvaluated stays false) so a later request
    // can retry the import rather than wedging the route permanently.
    work.then(clear, clear);
    return work;
  }

  runExpansion(entry, deps, lazyPatterns as UrlPatterns<TEnv>);
}

/**
 * Synchronously expand a lazy entry's (already-resolved) patterns into routes
 * and splice any nested lazy includes as new entries. Runs once per entry.
 */
function runExpansion<TEnv = any>(
  entry: RouteEntry<TEnv>,
  deps: LazyEvalDeps<TEnv>,
  lazyPatterns: UrlPatterns<TEnv>,
): void {
  // lazyEvaluated is set at the END, only after the handler ran and the routes
  // (and any nested includes) were spliced. Setting it up-front would mark the
  // entry done even if the handler throws mid-expansion: the async provider
  // path clears _lazyInflight on rejection so a later request can retry, but a
  // premature lazyEvaluated=true would make evaluateLazyEntry short-circuit
  // (line ~77) forever, wedging the route at 404 until the isolate restarts.
  const lazyContext = entry.lazyContext;

  const manifest = new Map<string, EntryData>();
  const patterns = new Map<string, string>();
  const patternsByPrefix = new Map<string, Map<string, string>>();
  const trailingSlashMap = new Map<string, TrailingSlashMode>();

  let handlerResult: AllUseItems[] = [];

  const lazyCounters: Record<string, number> = lazyContext?.counters
    ? { ...lazyContext.counters }
    : {};

  RangoContext.run(
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
      const includePrefix = (entry as any)._lazyPrefix || "";
      const fullPrefix = joinPrefix(lazyContext?.urlPrefix, includePrefix);

      if (fullPrefix || lazyContext?.namePrefix) {
        runWithPrefixes(fullPrefix, lazyContext?.namePrefix, () => {
          handlerResult = lazyPatterns.handler() as AllUseItems[];
        });
      } else {
        handlerResult = lazyPatterns.handler() as AllUseItems[];
      }
    },
  );

  const routesObject: Record<string, string> = {};
  for (const [name, pattern] of patterns.entries()) {
    routesObject[name] = pattern;
    const existingPattern = deps.mergedRouteMap[name];
    if (existingPattern !== undefined && existingPattern !== pattern) {
      console.warn(
        `[@rangojs/router] Route name conflict: "${name}" already maps to "${existingPattern}", ` +
          `overwriting with "${pattern}" (from lazy include). Use unique route names to avoid this.`,
      );
    }
    deps.mergedRouteMap[name] = pattern;
  }

  entry.routes = routesObject as ResolvedRouteMap<any>;

  if (trailingSlashMap.size > 0) {
    entry.trailingSlash = Object.fromEntries(trailingSlashMap);
  }

  const nestedLazyIncludes = findLazyIncludes(handlerResult);
  for (const lazyInclude of nestedLazyIncludes) {
    const fullPrefix = joinPrefix(
      lazyInclude.context.urlPrefix,
      lazyInclude.prefix,
    );

    const nestedEntry: RouteEntry<TEnv> & { _lazyPrefix?: string } = {
      prefix: "",
      staticPrefix: extractStaticPrefix(fullPrefix),
      routes: {} as ResolvedRouteMap<any>,
      trailingSlash: entry.trailingSlash,
      // include entries don't invoke their own handler (real handlers come from
      // the expanded routes); use the parent's placeholder. A provider has no
      // `.handler` until resolved, so never read it here.
      handler: isIncludeProvider(lazyInclude.patterns)
        ? entry.handler
        : (lazyInclude.patterns as UrlPatterns<TEnv>).handler,
      mountIndex: deps.nextMountIndex(),
      routerId: deps.routerId,
      lazy: true,
      lazyPatterns: lazyInclude.patterns,
      lazyContext: lazyInclude.context,
      lazyEvaluated: false,
      _lazyPrefix: lazyInclude.prefix,
    };
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

  registerRouteMap(deps.mergedRouteMap);

  // Expansion fully succeeded (handler ran, routes + nested includes spliced) —
  // mark done now so a mid-expansion throw above leaves lazyEvaluated=false and
  // the entry retriable.
  entry.lazyEvaluated = true;
}
