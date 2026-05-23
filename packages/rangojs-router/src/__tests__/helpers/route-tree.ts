/**
 * Route Tree Test Utilities
 *
 * Builds a route tree from urls() patterns and exposes the manifest,
 * patterns map, and route entries for inspection. Replicates the
 * pattern extraction logic from createRouter.routes() (router.ts)
 * without importing the full router (which depends on virtual modules).
 *
 * Not shipped with the npm package (lives in __tests__/).
 */
import React from "react";
import type { urls } from "../../urls.js";
import {
  RangoContext,
  getParallelEntries,
  getParallelSlotCount,
  runWithPrefixes,
  getIsolatedLazyParent,
  type EntryData,
  type InterceptEntry,
  type LoaderEntry,
} from "../../server/context.js";
import {
  findMatch,
  isLazyEvaluationNeeded,
  type RouteMatchResult,
} from "../../router/pattern-matching.js";
import type { RouteEntry } from "../../types.js";
import type { AllUseItems, IncludeItem } from "../../route-types.js";

// ============================================================================
// Types
// ============================================================================

export type { EntryData, InterceptEntry, LoaderEntry };

export interface SegmentInfo {
  id: string;
  type: EntryData["type"];
  pattern?: string;
}

export interface InterceptInfo {
  slotName: string;
  routeName: string;
  hasWhen: boolean;
  whenCount: number;
  hasLoader: boolean;
  hasMiddleware: boolean;
}

// ============================================================================
// buildRouteTree
// ============================================================================

/**
 * Build a route tree from url patterns for inspection.
 *
 * Executes the urls() handler inside RangoContext and extracts
 * the manifest, patterns, and route entries. Lazy includes are
 * eagerly evaluated so the full tree is available.
 *
 * @example
 * ```ts
 * const tree = buildRouteTree(
 *   urls(({ path, layout }) => [
 *     layout(RootLayout, () => [
 *       path("/", HomePage, { name: "home" }),
 *       path("/about", AboutPage, { name: "about" }),
 *     ]),
 *   ])
 * );
 *
 * // Inspect patterns
 * expect(tree.routes()).toEqual({ home: "/", about: "/about" });
 *
 * // Inspect segment IDs
 * expect(tree.segmentId("home")).toBe("M0L0L0R0");
 *
 * // Match a URL
 * const match = tree.match("/about");
 * expect(match?.routeKey).toBe("about");
 * ```
 */
export function buildRouteTree(
  urlPatterns: ReturnType<typeof urls>,
  options?: { mountIndex?: number },
): RouteTree {
  const manifest = new Map<string, EntryData>();
  const patterns = new Map<string, string>();
  const patternsByPrefix = new Map<string, Map<string, string>>();
  const trailingSlashMap = new Map<string, "never" | "always" | "ignore">();
  const mountIndex = options?.mountIndex ?? 0;

  // Synthetic root layout to match createRouter behavior
  const syntheticMapRoot: EntryData = {
    type: "layout",
    id: `#synthetic-maproot-M${mountIndex}`,
    shortCode: `M${mountIndex}L0`,
    parent: null,
    handler: React.createElement(React.Fragment) as React.ReactNode,
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
  };

  let handlerResult: AllUseItems[] = [];

  RangoContext.run(
    {
      manifest,
      patterns,
      patternsByPrefix,
      trailingSlash: trailingSlashMap,
      namespace: "root",
      parent: syntheticMapRoot,
      counters: {},
      mountIndex,
    },
    () => {
      handlerResult = urlPatterns.handler() as AllUseItems[];
    },
  );

  // Eagerly evaluate lazy includes, including any nested lazy includes
  // discovered while evaluating an outer include's handler.
  const pending = findLazyIncludes(handlerResult);
  while (pending.length > 0) {
    const lazy = pending.shift()!;
    const lazyManifest = new Map<string, EntryData>();
    const lazyPatterns = new Map<string, string>();
    const lazyCounters: Record<string, number> = {};
    if (lazy.context.counters) {
      for (const [key, value] of Object.entries(lazy.context.counters)) {
        lazyCounters[key] = value;
      }
    }

    let lazyResult: AllUseItems[] = [];
    RangoContext.run(
      {
        manifest: lazyManifest,
        patterns: lazyPatterns,
        patternsByPrefix: new Map(),
        trailingSlash: trailingSlashMap,
        namespace: "lazy",
        parent: getIsolatedLazyParent(lazy.context.parent as EntryData | null),
        counters: lazyCounters,
        mountIndex,
        rootScoped: lazy.context.rootScoped,
        includeScope: (lazy.context as any).includeScope,
      },
      () => {
        const fullPrefix = (lazy.context.urlPrefix || "") + lazy.prefix;
        if (fullPrefix || lazy.context.namePrefix) {
          runWithPrefixes(fullPrefix, lazy.context.namePrefix, () => {
            lazyResult = (
              lazy.patterns as ReturnType<typeof urls>
            ).handler() as AllUseItems[];
          });
        } else {
          lazyResult = (
            lazy.patterns as ReturnType<typeof urls>
          ).handler() as AllUseItems[];
        }
      },
    );

    for (const [k, v] of lazyManifest) manifest.set(k, v);
    for (const [k, v] of lazyPatterns) patterns.set(k, v);

    // Discover nested lazy includes produced by this handler and queue them.
    pending.push(...findLazyIncludes(lazyResult));
  }

  // Build route entries for findMatch
  const routesObject: Record<string, string> = {};
  for (const [name, pattern] of patterns.entries()) {
    routesObject[name] = pattern;
  }

  const routeEntries: RouteEntry[] = [
    {
      prefix: "",
      staticPrefix: "",
      routes: routesObject,
      handler: urlPatterns.handler,
      mountIndex,
    },
  ];

  return new RouteTree(manifest, patterns, routeEntries);
}

// ============================================================================
// RouteTree
// ============================================================================

/**
 * Wrapper around the raw manifest/patterns/entries providing
 * convenient inspection methods for route tree, segment IDs,
 * middleware, intercepts, loaders, and parallel slots.
 */
export class RouteTree {
  constructor(
    public readonly manifest: Map<string, EntryData>,
    public readonly patterns: Map<string, string>,
    public readonly routeEntries: RouteEntry[],
  ) {}

  // --- Route patterns ---

  /** Route name -> URL pattern map as a plain object */
  routes(): Record<string, string> {
    return Object.fromEntries(this.patterns);
  }

  /** Get all route names */
  routeNames(): string[] {
    return [...this.patterns.keys()];
  }

  // --- Segment IDs ---

  /** Get the segment ID (shortCode) for a named route */
  segmentId(name: string): string | undefined {
    return this.entry(name)?.shortCode;
  }

  /** Get segment IDs for all named routes */
  segmentIds(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of this.patterns.keys()) {
      const id = this.segmentId(name);
      if (id) result[name] = id;
    }
    return result;
  }

  /**
   * Get the full segment path from root to a named route.
   * Returns an array of { id, type, pattern? } entries.
   */
  segmentPath(name: string): SegmentInfo[] {
    const entry = this.entry(name);
    if (!entry) return [];

    const path: SegmentInfo[] = [];
    let current: EntryData | null = entry;
    while (current) {
      path.unshift({
        id: current.shortCode,
        type: current.type,
        pattern: current.type === "route" ? current.pattern : undefined,
      });
      current = current.parent;
    }
    return path;
  }

  // --- Entry access ---

  /** Get the EntryData for a named route */
  entry(name: string): EntryData | undefined {
    const direct = this.manifest.get(name);
    if (direct) return direct;
    for (const [key, entry] of this.manifest) {
      if (key.endsWith(`.${name}`)) return entry;
    }
    return undefined;
  }

  /** Get the EntryData for a route matching a URL pattern string */
  entryByPattern(pattern: string): EntryData | undefined {
    for (const entry of this.manifest.values()) {
      if (entry.type === "route" && entry.pattern === pattern) {
        return entry;
      }
    }
    return undefined;
  }

  // --- URL matching ---

  /** Match a pathname and return the match result (routeKey, params) */
  match(pathname: string): RouteMatchResult | null {
    const result = findMatch(pathname, this.routeEntries);
    if (!result || isLazyEvaluationNeeded(result)) return null;
    return result;
  }

  // --- Middleware ---

  /** Get middleware functions attached to a named route/layout */
  middleware(name: string): Array<Function> {
    const entry = this.entry(name);
    return entry?.middleware ?? [];
  }

  /** Check if a named route/layout has middleware */
  hasMiddleware(name: string): boolean {
    return this.middleware(name).length > 0;
  }

  /**
   * Collect all middleware in the chain from root to a named route.
   * Returns them in execution order (root first).
   */
  middlewareChain(name: string): Array<{ segmentId: string; count: number }> {
    const entry = this.entry(name);
    if (!entry) return [];

    const chain: Array<{ segmentId: string; count: number }> = [];
    let current: EntryData | null = entry;
    const stack: EntryData[] = [];
    while (current) {
      stack.unshift(current);
      current = current.parent;
    }
    for (const e of stack) {
      if (e.middleware.length > 0) {
        chain.push({ segmentId: e.shortCode, count: e.middleware.length });
      }
    }
    return chain;
  }

  // --- Intercepts ---

  /** Get intercept entries for a named route/layout */
  intercepts(name: string): InterceptInfo[] {
    const entry = this.entry(name);
    if (!entry) return [];
    return entry.intercept.map((i) => ({
      slotName: i.slotName,
      routeName: i.routeName,
      hasWhen: i.when.length > 0,
      whenCount: i.when.length,
      hasLoader: i.loader.length > 0,
      hasMiddleware: i.middleware.length > 0,
    }));
  }

  /** Get raw InterceptEntry objects for a named route/layout */
  interceptEntries(name: string): InterceptEntry[] {
    return this.entry(name)?.intercept ?? [];
  }

  // --- Loaders ---

  /** Get loader entries for a named route/layout */
  loaders(name: string): LoaderEntry[] {
    return this.entry(name)?.loader ?? [];
  }

  /** Check if a named route/layout has loaders */
  hasLoaders(name: string): boolean {
    return this.loaders(name).length > 0;
  }

  // --- Parallel slots ---

  /** Get parallel slot entries (child EntryData with type="parallel") */
  parallelSlots(name: string): EntryData[] {
    return getParallelEntries(this.entry(name)?.parallel);
  }

  /** Get parallel slot names for a named route/layout */
  parallelSlotNames(name: string): string[] {
    const entry = this.entry(name);
    if (!entry) return [];
    // Parallel entry handler is Record<`@${string}`, Handler>
    return getParallelEntries(entry.parallel)
      .map((p) => {
        if (
          p.type === "parallel" &&
          typeof p.handler === "object" &&
          p.handler !== null
        ) {
          return Object.keys(p.handler as Record<string, unknown>);
        }
        return [];
      })
      .flat();
  }

  // --- Error/NotFound boundaries ---

  /** Check if a named route/layout has an error boundary */
  hasErrorBoundary(name: string): boolean {
    return (this.entry(name)?.errorBoundary?.length ?? 0) > 0;
  }

  /** Check if a named route/layout has a not-found boundary */
  hasNotFoundBoundary(name: string): boolean {
    return (this.entry(name)?.notFoundBoundary?.length ?? 0) > 0;
  }

  // --- Cache ---

  /** Check if a named route/layout has cache config */
  hasCache(name: string): boolean {
    return this.entry(name)?.cache !== undefined;
  }

  // --- Loading ---

  /** Check if a named route/layout has a loading component */
  hasLoading(name: string): boolean {
    const entry = this.entry(name);
    if (!entry) return false;
    return "loading" in entry && entry.loading !== undefined;
  }

  // --- Debug ---

  /**
   * Debug print the route tree.
   * Useful for exploring the structure in tests.
   */
  debug(): string {
    const lines: string[] = ["Route Tree:"];
    for (const [name, pattern] of this.patterns) {
      const entry = this.entry(name);
      const segPath = this.segmentPath(name);
      const ids = segPath.map((s) => s.id).join(" > ");
      const extras: string[] = [];
      if (entry && entry.middleware.length > 0)
        extras.push(`mw:${entry.middleware.length}`);
      if (entry && entry.loader.length > 0)
        extras.push(`ld:${entry.loader.length}`);
      if (entry && entry.intercept.length > 0)
        extras.push(`int:${entry.intercept.length}`);
      if (entry && getParallelSlotCount(entry.parallel) > 0)
        extras.push(`par:${getParallelSlotCount(entry.parallel)}`);
      if (entry?.errorBoundary?.length) extras.push("err");
      if (entry?.cache) extras.push("cache");
      const suffix = extras.length > 0 ? ` {${extras.join(", ")}}` : "";
      lines.push(
        `  ${name}: ${pattern} [${entry?.shortCode}] (${ids})${suffix}`,
      );
    }
    return lines.join("\n");
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

function findLazyIncludes(items: AllUseItems[]): Array<{
  prefix: string;
  patterns: unknown;
  context: {
    urlPrefix: string;
    namePrefix: string | undefined;
    parent: unknown;
    counters?: Record<string, number>;
    rootScoped?: boolean;
    includeScope?: string;
  };
}> {
  const result: Array<{
    prefix: string;
    patterns: unknown;
    context: {
      urlPrefix: string;
      namePrefix: string | undefined;
      parent: unknown;
      counters?: Record<string, number>;
      rootScoped?: boolean;
      includeScope?: string;
    };
  }> = [];

  for (const item of items) {
    if (!item) continue;
    if (item.type === "include") {
      const includeItem = item as IncludeItem;
      if (includeItem.lazy === true && includeItem._lazyContext) {
        result.push({
          prefix: includeItem.prefix,
          patterns: includeItem.patterns,
          context: includeItem._lazyContext,
        });
      }
    }
    if ((item as any).uses && Array.isArray((item as any).uses)) {
      result.push(...findLazyIncludes((item as any).uses));
    }
  }

  return result;
}
