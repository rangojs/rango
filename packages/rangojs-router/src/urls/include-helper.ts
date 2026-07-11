import type { AllUseItems, IncludeItem } from "../route-types.js";
import {
  getUrlPrefix,
  getNamePrefix,
  requireDslContext,
} from "../server/context";
import {
  INTERNAL_INCLUDE_SCOPE_PREFIX,
  validateUserRouteName,
} from "../route-name.js";
import type { UrlPatterns, IncludeOptions } from "./pattern-types.js";
import type { IncludeProvider } from "./include-provider.js";
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
 * Recursively walk items, recursing into layout children.
 *
 * All includes are lazy and kept as-is; the router expands them on the first
 * matching request.
 */
export function processItems(items: readonly AllUseItems[]): AllUseItems[] {
  const result: AllUseItems[] = [];

  for (const item of items) {
    if (!item) continue;

    if (item.type === "include") {
      result.push(item);
    } else if (item.type === "layout" && (item as any).uses) {
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
 * All includes are lazy: the nested patterns are NOT expanded at definition
 * time. Instead they are evaluated on the first request that matches the
 * prefix, which improves cold start time for apps with many routes.
 */
export function createIncludeHelper<TEnv>(): IncludeFn<TEnv> {
  return (
    prefix: string,
    // A `urls()` value (eager) OR an async provider thunk
    // (`() => import("./routes")`) whose evaluation is deferred to the first
    // request matching `prefix`. The provider is stored unevaluated and
    // resolved by the runtime lazy-include expansion / build-time discovery.
    patterns: UrlPatterns<TEnv> | IncludeProvider<TEnv>,
    options?: IncludeOptions,
  ): IncludeItem => {
    const { ctx } = requireDslContext("include() must be called inside urls()");

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
    const nextSegment = hasExplicitName
      ? explicitName
      : allocateInternalIncludeScopeId(ctx.counters);
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
      includeScope = `${parentScope}I${ctx.counters[includeCounterKey]++}`;
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
        routerId: ctx.routerId,
        includeScope,
      },
    } as IncludeItem;
  };
}
