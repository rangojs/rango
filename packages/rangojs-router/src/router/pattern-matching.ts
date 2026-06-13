/**
 * Router Pattern Matching
 *
 * Route pattern compilation and matching utilities.
 */

import type { RouteEntry, TrailingSlashMode } from "../types";
import type { EntryData } from "../server/context";
import { debugLog, isRouterDebugEnabled } from "./logging.js";
import { safeDecodeURIComponent } from "./url-params.js";

/**
 * Parsed segment info
 */
export interface ParsedSegment {
  type: "static" | "param" | "wildcard";
  value: string; // static text, param name, or "*"
  optional: boolean;
  constraint?: string[]; // enum values like ["en", "gb"]
  suffix?: string; // literal text after param in same segment (e.g., ".html")
}

/**
 * Parse a route pattern into segments
 *
 * Supports:
 * - Static: /blog, /about
 * - Params: /:slug, /:id
 * - Optional: /:locale?, /:page?
 * - Constrained: /:locale(en|gb), /:type(post|page)
 * - Optional + Constrained: /:locale(en|gb)?
 * - Wildcard: /*
 */
export function parsePattern(pattern: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const segmentRegex =
    /\/(:([a-zA-Z_][a-zA-Z0-9_]*)(\(([^)]+)\))?(\?)?([^/]*)|(\*)|([^/]+))/g;

  let match;
  while ((match = segmentRegex.exec(pattern)) !== null) {
    const [
      ,
      ,
      paramName,
      ,
      constraint,
      optional,
      suffix,
      wildcard,
      staticText,
    ] = match;

    if (wildcard) {
      segments.push({ type: "wildcard", value: "*", optional: false });
    } else if (paramName) {
      segments.push({
        type: "param",
        value: paramName,
        optional: optional === "?",
        constraint: constraint ? constraint.split("|") : undefined,
        suffix: suffix || undefined,
      });
    } else if (staticText) {
      segments.push({ type: "static", value: staticText, optional: false });
    }
  }

  return segments;
}

/**
 * Compiled pattern result containing regex, param metadata, and trailing slash info.
 */
export interface CompiledPattern {
  regex: RegExp;
  paramNames: string[];
  hasTrailingSlash: boolean;
  /**
   * Param-name → allowed values for constrained params (e.g. `:lang(en|gb)`).
   * Validated against the **decoded** param value after regex extraction so
   * a URL like `/en%20GB` still matches `:lang(en GB)` — matching the trie
   * path's behavior (trie-matching.ts:validateAndBuild).
   */
  constraints?: Record<string, string[]>;
}

// Module-level cache for compiled patterns. Route patterns are a finite set
// defined at build time, so this map is bounded by the number of routes.
const compiledPatternCache = new Map<string, CompiledPattern>();

/**
 * Get a compiled pattern from cache or compile and cache it.
 * Avoids O(routes) regex compilations per request in the fallback path.
 */
export function getCompiledPattern(pattern: string): CompiledPattern {
  let compiled = compiledPatternCache.get(pattern);
  if (compiled) return compiled;
  compiled = compilePattern(pattern);
  compiledPatternCache.set(pattern, compiled);
  return compiled;
}

/**
 * Return the current size of the compiled pattern cache.
 * Exposed for testing.
 */
export function getPatternCacheSize(): number {
  return compiledPatternCache.size;
}

/**
 * Clear the compiled pattern cache.
 * Exposed for testing.
 */
export function clearPatternCache(): void {
  compiledPatternCache.clear();
}

/**
 * Compile a route pattern to regex
 *
 * Supports:
 * - Static segments: /blog, /about
 * - Dynamic params: /:slug, /:id
 * - Optional params: /:locale?, /:page?
 * - Constrained params: /:locale(en|gb)
 * - Optional + constrained: /:locale(en|gb)?
 * - Wildcard: /*
 *
 * @example
 * compilePattern("/blog/:slug")           // matches /blog/hello
 * compilePattern("/:locale?/blog")        // matches /blog or /en/blog
 * compilePattern("/:locale(en|gb)/blog")  // matches /en/blog or /gb/blog
 * compilePattern("/:locale(en|gb)?/blog") // matches /blog, /en/blog, or /gb/blog
 */
export function compilePattern(pattern: string): CompiledPattern {
  // Detect if pattern has trailing slash (but not just "/")
  const hasTrailingSlash = pattern.length > 1 && pattern.endsWith("/");
  // Remove trailing slash for parsing (we'll add it back to regex if needed)
  const normalizedPattern = hasTrailingSlash ? pattern.slice(0, -1) : pattern;

  const segments = parsePattern(normalizedPattern);
  const paramNames: string[] = [];
  let constraints: Record<string, string[]> | undefined;

  let regexPattern = "";

  for (const segment of segments) {
    if (segment.type === "wildcard") {
      paramNames.push("*");
      regexPattern += "/(.*)";
    } else if (segment.type === "param") {
      paramNames.push(segment.value);
      const suffixPattern = segment.suffix ? escapeRegex(segment.suffix) : "";
      // Constrained params capture anything here; the allowed values are
      // checked post-decode in findMatch so URL-encoded constraint values
      // (e.g. `:lang(en GB)` via `/en%20GB`) still match.
      const valuePattern = segment.suffix ? "([^/]+?)" : "([^/]+)";

      if (segment.constraint) {
        (constraints ??= {})[segment.value] = segment.constraint;
      }

      if (segment.optional) {
        // Optional: make the whole /segment optional
        regexPattern += `(?:/${valuePattern}${suffixPattern})?`;
      } else {
        regexPattern += `/${valuePattern}${suffixPattern}`;
      }
    } else {
      // Static segment
      regexPattern += `/${escapeRegex(segment.value)}`;
    }
  }

  if (regexPattern === "") {
    regexPattern = "/";
  }

  // Patterns of only optional segments (e.g. `/:locale?`, `/:a?/:b?`) need
  // an explicit `/` alternative so a bare `/` matches the absent form. The
  // optional template `(?:/X)?` matches `/X` or empty string, but pathnames
  // are never empty. Arises from `include("/:locale?", routes)` + inner
  // `path("/")`. Skip when an explicit trailing slash already anchors the
  // match.
  const hasOnlyOptionalSegments =
    !hasTrailingSlash &&
    segments.length > 0 &&
    segments.every((segment) => segment.type === "param" && segment.optional);
  if (hasOnlyOptionalSegments) {
    regexPattern = `(?:/|${regexPattern})`;
  }

  // Add trailing slash to regex if pattern has one
  if (hasTrailingSlash) {
    regexPattern += "/";
  }

  return {
    regex: new RegExp(`^${regexPattern}$`),
    paramNames,
    hasTrailingSlash,
    ...(constraints ? { constraints } : {}),
  };
}

/**
 * Validate decoded params against a compiled pattern's constraints.
 * Returns false if any constrained param has a non-empty value not in the
 * allowed list. Absent optionals (key missing or `undefined`) are allowed;
 * `""` is also tolerated as "absent" so user-provided params or fixtures
 * that pass empty strings explicitly behave the same way.
 */
function satisfiesConstraints(
  params: Record<string, string>,
  constraints: Record<string, string[]> | undefined,
): boolean {
  if (!constraints) return true;
  for (const name in constraints) {
    const value = params[name];
    if (
      value !== undefined &&
      value !== "" &&
      !constraints[name].includes(value)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the named-params record from a regex match. Optional segments that
 * didn't capture leave the corresponding group `undefined`; we skip those
 * keys so `ctx.params.<name>` reads as `undefined` rather than `""`. This
 * keeps the runtime aligned with the `ExtractParams` type and matches the
 * trie matcher's contract (see `trie-matching.ts:validateAndBuild`).
 */
function buildParamsFromMatch(
  match: RegExpExecArray,
  paramNames: string[],
): Record<string, string> {
  const params: Record<string, string> = {};
  paramNames.forEach((name, index) => {
    const captured = match[index + 1];
    if (captured !== undefined) {
      params[name] = safeDecodeURIComponent(captured);
    }
  });
  return params;
}

/**
 * Extract the static prefix from a route pattern.
 * Returns everything before the first param/wildcard.
 *
 * Called ONCE at registration time, not at match time.
 *
 * Examples:
 * - "/api" → "/api"
 * - "/site/:locale" → "/site"
 * - "/:locale" → ""
 * - "/admin/users/:id" → "/admin/users"
 * - "/api/*" → "/api"
 */
export function extractStaticPrefix(pattern: string): string {
  if (!pattern || pattern === "/") return "";

  const paramIndex = pattern.indexOf(":");
  const wildcardIndex = pattern.indexOf("*");

  let cutIndex = -1;
  if (paramIndex !== -1 && wildcardIndex !== -1) {
    cutIndex = Math.min(paramIndex, wildcardIndex);
  } else if (paramIndex !== -1) {
    cutIndex = paramIndex;
  } else if (wildcardIndex !== -1) {
    cutIndex = wildcardIndex;
  }

  if (cutIndex === -1) {
    return pattern;
  }

  if (cutIndex === 0) {
    return "";
  }

  const lastSlash = pattern.lastIndexOf("/", cutIndex - 1);
  if (lastSlash === -1 || lastSlash === 0) {
    return "";
  }

  return pattern.slice(0, lastSlash);
}

/**
 * Join a URL prefix to a sub-prefix, collapsing the duplicate slash when the
 * base ends with "/" and the sub-prefix starts with "/". This mirrors the
 * canonical join in `include()` (urls/include-helper.ts) and `runWithPrefixes`
 * (server/context.ts) so a nested lazy include's runtime staticPrefix matches
 * the build-time trie's `sp` (e.g. `include("/parent/", …)` containing
 * `include("/child", …)` resolves to `/parent/child`, not `/parent//child`).
 */
export function joinPrefix(base: string | undefined, prefix: string): string {
  if (!base) return prefix;
  return base.endsWith("/") && prefix.startsWith("/")
    ? base + prefix.slice(1)
    : base + prefix;
}

/**
 * Match a pathname against registered routes
 *
 * Note: Optional params that are absent in the path are omitted from the
 * returned `params` (read as `undefined`), matching the trie matcher and
 * the `ExtractParams<"/:locale?/...">` type. Use the pattern definition to
 * determine which keys are optional.
 *
 * Trailing slash handling (priority order):
 * 1. Per-route `trailingSlash` config from route()
 * 2. Pattern-based detection (pattern ending with `/`)
 *
 * Modes:
 * - "never": Redirect to no trailing slash
 * - "always": Redirect to with trailing slash
 * - "ignore": Match both, no redirect
 */
/**
 * Result of a route match
 */
export interface RouteMatchResult<TEnv = any> {
  entry: RouteEntry<TEnv>;
  routeKey: string;
  params: Record<string, string>;
  redirectTo?: string;
  /** Route has pre-rendered data available (from trie) */
  pr?: true;
  /** Passthrough: handler kept for live fallback on unknown params (from trie) */
  pt?: true;
  /** Response type for non-RSC routes (json, text, image, any) */
  responseType?: string;
  /** Negotiate variants: response-type routes sharing this path */
  negotiateVariants?: Array<{ routeKey: string; responseType: string }>;
  /** RSC-first: RSC route was defined before response-type variants */
  rscFirst?: true;
}

/**
 * Result when a lazy entry needs evaluation before matching
 */
export interface LazyEvaluationNeeded<TEnv = any> {
  lazyEntry: RouteEntry<TEnv>;
}

/**
 * Type guard to check if result is a lazy evaluation needed response
 */
export function isLazyEvaluationNeeded<TEnv>(
  result: RouteMatchResult<TEnv> | LazyEvaluationNeeded<TEnv> | null,
): result is LazyEvaluationNeeded<TEnv> {
  return result !== null && "lazyEntry" in result;
}

// Debug stats type for exports
interface MatchDebugStats {
  entriesChecked: number;
  entriesSkipped: number;
  routesChecked: number;
}

// Debug stats for route matching (only in debug mode)
let debugEnabled = false;
let debugStats = { entriesChecked: 0, entriesSkipped: 0, routesChecked: 0 };

export function enableMatchDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function getMatchDebugStats(): MatchDebugStats {
  return {
    entriesChecked: debugStats.entriesChecked,
    entriesSkipped: debugStats.entriesSkipped,
    routesChecked: debugStats.routesChecked,
  };
}

export function findMatch<TEnv>(
  pathname: string,
  routesEntries: RouteEntry<TEnv>[],
): RouteMatchResult<TEnv> | LazyEvaluationNeeded<TEnv> | null {
  const effectiveDebug = debugEnabled || isRouterDebugEnabled();

  if (effectiveDebug) {
    debugStats = { entriesChecked: 0, entriesSkipped: 0, routesChecked: 0 };
    debugLog("findMatch", "start", { pathname, entries: routesEntries.length });
    for (const e of routesEntries) {
      debugLog("findMatch", "entry", {
        prefix: e.prefix,
        staticPrefix: e.staticPrefix,
        routeCount: Object.keys(e.routes).length,
      });
    }
  }

  const pathnameHasTrailingSlash =
    pathname.length > 1 && pathname.endsWith("/");
  // Try alternate pathname for redirect matching
  const alternatePathname = pathnameHasTrailingSlash
    ? pathname.slice(0, -1)
    : pathname + "/";

  for (const entry of routesEntries) {
    if (entry.staticPrefix && !pathname.startsWith(entry.staticPrefix)) {
      if (effectiveDebug) {
        debugStats.entriesSkipped++;
        debugLog("findMatch", "skipped entry", {
          prefix: entry.prefix,
          staticPrefix: entry.staticPrefix,
        });
      }
      continue;
    }

    if (entry.lazy && !entry.lazyEvaluated) {
      if (effectiveDebug) {
        debugLog("findMatch", "lazy entry requires evaluation", {
          staticPrefix: entry.staticPrefix,
        });
      }
      return { lazyEntry: entry };
    }

    if (effectiveDebug) {
      debugStats.entriesChecked++;
    }

    const routeEntries = Object.entries(entry.routes);

    for (const [routeKey, pattern] of routeEntries) {
      if (effectiveDebug) {
        debugStats.routesChecked++;
      }

      let fullPattern: string;
      if (entry.prefix === "" || entry.prefix === "/") {
        fullPattern = pattern;
      } else if (pattern === "/" || pattern === "") {
        fullPattern = entry.prefix;
      } else {
        fullPattern = entry.prefix + pattern;
      }

      const { regex, paramNames, hasTrailingSlash, constraints } =
        getCompiledPattern(fullPattern);

      const trailingSlashMode: TrailingSlashMode | undefined =
        entry.trailingSlash?.[routeKey];

      const prFlag = entry.prerenderRouteKeys?.has(routeKey)
        ? { pr: true as const }
        : {};
      const ptFlag = entry.passthroughRouteKeys?.has(routeKey)
        ? { pt: true as const }
        : {};

      const match = regex.exec(pathname);
      if (match) {
        const params = buildParamsFromMatch(match, paramNames);

        if (!satisfiesConstraints(params, constraints)) {
          continue;
        }

        if (effectiveDebug) {
          debugLog("findMatch", "matched route", {
            routeKey,
            pattern: fullPattern,
            stats: { ...debugStats },
          });
        }

        if (
          trailingSlashMode === "always" &&
          !pathnameHasTrailingSlash &&
          pathname !== "/"
        ) {
          return {
            entry,
            routeKey,
            params,
            redirectTo: pathname + "/",
            ...prFlag,
            ...ptFlag,
          };
        } else if (trailingSlashMode === "never" && pathnameHasTrailingSlash) {
          return {
            entry,
            routeKey,
            params,
            redirectTo: pathname.slice(0, -1),
            ...prFlag,
            ...ptFlag,
          };
        }

        return {
          entry,
          routeKey,
          params,
          ...prFlag,
          ...ptFlag,
        };
      }

      const altMatch = regex.exec(alternatePathname);
      if (altMatch) {
        const params = buildParamsFromMatch(altMatch, paramNames);

        if (!satisfiesConstraints(params, constraints)) {
          continue;
        }

        if (trailingSlashMode === "ignore") {
          return {
            entry,
            routeKey,
            params,
            ...prFlag,
            ...ptFlag,
          };
        } else if (trailingSlashMode === "never") {
          if (pathnameHasTrailingSlash) {
            return {
              entry,
              routeKey,
              params,
              redirectTo: alternatePathname,
              ...prFlag,
              ...ptFlag,
            };
          }
          return {
            entry,
            routeKey,
            params,
            ...prFlag,
            ...ptFlag,
          };
        } else if (trailingSlashMode === "always") {
          if (!pathnameHasTrailingSlash) {
            return {
              entry,
              routeKey,
              params,
              redirectTo: alternatePathname,
              ...prFlag,
              ...ptFlag,
            };
          }
          return {
            entry,
            routeKey,
            params,
            ...prFlag,
            ...ptFlag,
          };
        } else {
          const canonicalPath = hasTrailingSlash
            ? alternatePathname
            : pathname.slice(0, -1);
          return {
            entry,
            routeKey,
            params,
            redirectTo: canonicalPath,
            ...prFlag,
            ...ptFlag,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Traverse from entry to bottom to top, yielding each EntryData
 * e.g. {child -> parent -> grandparent ...}
 */
export function* traverseBack(entry: EntryData): Generator<EntryData> {
  let current: EntryData | null = entry;
  const items = [] as EntryData[];
  while (current !== null) {
    items.push(current);
    current = current.parent;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    yield items[i];
  }
}
