import type { AllUseItems, IncludeItem } from "../route-types.js";
import {
  getContext,
  runWithPrefixes,
  getUrlPrefix,
  getNamePrefix,
} from "../server/context";
import { INTERNAL_INCLUDE_SCOPE_PREFIX } from "../route-name.js";
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

    // Snapshot parent's counters so lazy manifest generation starts
    // at the correct index, preventing shortCode collisions with
    // sibling entries (e.g., BlogLayout and ArticlesLayout under NavLayout).
    const capturedCounters = { ...ctx.counters };

    // Reserve a layout slot in the parent's counter so sibling lazy includes
    // produce different shortCode indices for their root layout.
    // Without this, consecutive include() calls capture identical counters
    // and their first child layouts get the same shortCode (e.g., both M0L0L0),
    // causing the client partial-update diff to see no changes on navigation.
    if (capturedParent?.shortCode) {
      const layoutCounterKey = `${capturedParent.shortCode}_layout`;
      ctx.counters[layoutCounterKey] ??= 0;
      ctx.counters[layoutCounterKey]++;
    }

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
      },
    } as IncludeItem;
  };
}
