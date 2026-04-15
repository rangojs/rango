import type { AllUseItems, IncludeItem } from "../route-types.js";
import {
  getContext,
  runWithPrefixes,
  getUrlPrefix,
  getNamePrefix,
} from "../server/context";
import {
  INTERNAL_INCLUDE_SCOPE_PREFIX,
  validateUserRouteName,
} from "../route-name.js";
import type { UrlPatterns, IncludeOptions } from "./pattern-types.js";
import type { IncludeFn } from "./path-helper-types.js";

function hasExplicitNameOption(options: IncludeOptions | undefined): boolean {
  return !!options && Object.prototype.hasOwnProperty.call(options, "name");
}

function allocateInternalIncludeScopeId(
  counters: Record<string, number>,
): string {
  const key = "__include_scope__";
  const index = counters[key] ?? 0;
  counters[key] = index + 1;
  return `${INTERNAL_INCLUDE_SCOPE_PREFIX}${index}`;
}

/**
 * Process an IncludeItem by executing its nested patterns with prefixes
 * This expands the include into actual route registrations
 */
function processIncludeItem(item: IncludeItem): AllUseItems[] {
  const { prefix, patterns } = item;
  const namePrefix =
    (item as IncludeItem & { _lazyContext?: { namePrefix?: string } })
      ._lazyContext?.namePrefix ?? item.options?.name;

  // Execute the nested patterns' handler with URL and name prefixes
  // The urlPrefix being set tells nested urls() to skip RootLayout wrapping
  return runWithPrefixes(prefix, namePrefix, () => {
    // Call the nested patterns' handler - this registers routes with prefixed patterns/names
    return (patterns as UrlPatterns).handler();
  });
}

/**
 * Recursively process items, expanding any IncludeItems
 * Returns items with IncludeItems expanded into actual route items
 *
 * Lazy includes are kept as-is (not expanded) for the router to handle later.
 */
export function processItems(items: readonly AllUseItems[]): AllUseItems[] {
  const result: AllUseItems[] = [];

  for (const item of items) {
    if (!item) continue;

    if (item.type === "include") {
      const includeItem = item as IncludeItem & {
        _expanded?: AllUseItems[];
        lazy?: boolean;
      };

      // Lazy includes are NOT expanded here - kept for router to handle
      if (includeItem.lazy) {
        result.push(item);
        continue;
      }

      // Eager includes are already expanded during include() call
      if (includeItem._expanded) {
        // Items were expanded immediately - just process them recursively
        result.push(...processItems(includeItem._expanded));
      } else {
        // Fallback for legacy include items without _expanded
        const expanded = processIncludeItem(item as IncludeItem);
        result.push(...processItems(expanded));
      }
    } else if (item.type === "layout" && (item as any).uses) {
      // Process nested items in layout
      const layoutItem = item as any;
      layoutItem.uses = processItems(layoutItem.uses);
      result.push(layoutItem);
    } else {
      result.push(item);
    }
  }

  return result;
}

/**
 * Create include() helper for composing URL patterns
 *
 * By default, include() IMMEDIATELY expands the nested patterns. This ensures
 * that routes from included patterns inherit the correct parent context
 * (the layout they're included in).
 *
 * With `lazy: true`, patterns are NOT expanded at definition time. Instead,
 * they're evaluated on first request that matches the prefix. This improves
 * cold start time for apps with many routes.
 */
export function createIncludeHelper<TEnv>(): IncludeFn<TEnv> {
  return (
    prefix: string,
    patterns: UrlPatterns<TEnv>,
    options?: IncludeOptions,
  ): IncludeItem => {
    const store = getContext();
    const ctx = store.getStore();
    if (!ctx) throw new Error("include() must be called inside urls()");

    const explicitName = options?.name;
    const hasExplicitName = hasExplicitNameOption(options);
    if (hasExplicitName && explicitName) {
      validateUserRouteName(explicitName);
    }
    const name = `$include_${prefix.replace(/[/:*?]/g, "_")}`;

    // Capture context for deferred evaluation
    const capturedUrlPrefix = getUrlPrefix();
    const capturedNamePrefix = getNamePrefix();
    const capturedParent = ctx.parent;
    const fullPrefix = capturedUrlPrefix
      ? capturedUrlPrefix.endsWith("/") && prefix.startsWith("/")
        ? capturedUrlPrefix + prefix.slice(1)
        : capturedUrlPrefix + prefix
      : prefix;
    const internalScope = !hasExplicitName
      ? allocateInternalIncludeScopeId(ctx.counters)
      : undefined;
    const nextSegment = hasExplicitName ? explicitName : internalScope;
    const fullNamePrefix =
      nextSegment !== undefined && nextSegment !== ""
        ? capturedNamePrefix
          ? `${capturedNamePrefix}.${nextSegment}`
          : nextSegment
        : capturedNamePrefix;

    // Track this include for build-time manifest generation
    if (ctx.trackedIncludes) {
      ctx.trackedIncludes.push({
        prefix,
        fullPrefix,
        namePrefix: fullNamePrefix,
        patterns,
        lazy: true,
      });
    }

    // Allocate an include-scope token for this include() call. The token is
    // appended to the parent's shortCode prefix whenever the include's
    // direct-descendant shortCodes are generated (see getShortCode in
    // context.ts), partitioning the parent's counter namespace so routes
    // inside an include cannot collide with siblings declared outside it.
    //
    // Scopes compose: a nested include inside an outer include with scope
    // "I0" allocates against the `${parent.shortCode}I0_include` counter
    // and produces scope "I0I0", "I0I1", etc.
    const parentScope = ctx.includeScope ?? "";
    let includeScope = parentScope;
    if (capturedParent?.shortCode) {
      const includeCounterKey = `${capturedParent.shortCode}${parentScope}_include`;
      ctx.counters[includeCounterKey] ??= 0;
      const includeIdx = ctx.counters[includeCounterKey];
      ctx.counters[includeCounterKey] = includeIdx + 1;
      includeScope = `${parentScope}I${includeIdx}`;
    }

    // Snapshot parent's counters AFTER allocating the include scope so lazy
    // manifest generation starts with the same counter state this include
    // observed — its descendants still get fresh per-scope counters because
    // they key off `${parent.shortCode}${includeScope}_*` (not shared with
    // siblings outside the include).
    const capturedCounters = { ...ctx.counters };

    // Compute rootScoped at capture time, mirroring the logic in runWithPrefixes.
    // This ensures lazy evaluation restores the correct scope state.
    const parentRootScoped = ctx.rootScoped;
    const capturedRootScoped =
      nextSegment === ""
        ? (parentRootScoped ?? true)
        : nextSegment !== undefined
          ? (parentRootScoped ?? false)
          : parentRootScoped;

    // All includes are lazy - patterns are evaluated on first matching request
    // This improves cold start time significantly for large route sets
    return {
      type: "include",
      name,
      prefix,
      patterns,
      options,
      lazy: true,
      _lazyContext: {
        urlPrefix: capturedUrlPrefix,
        namePrefix: fullNamePrefix,
        parent: capturedParent,
        counters: capturedCounters,
        cacheProfiles: ctx.cacheProfiles,
        rootScoped: capturedRootScoped,
        includeScope,
      },
    } as IncludeItem;
  };
}
