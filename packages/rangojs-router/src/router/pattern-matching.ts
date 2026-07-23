/**
 * Router Pattern Matching
 *
 * Route pattern compilation and matching utilities.
 */

import type { RouteEntry, TrailingSlashMode } from "../types";
import type { EntryData } from "../server/context";
import { debugLog, isRouterDebugEnabled } from "./logging.js";
import { escapeRegExp } from "../regex-escape.js";
import { safeDecodeURIComponent } from "./url-params.js";
import { parsePattern, type ParsedSegment } from "./parse-pattern.js";

// `parsePattern`/`ParsedSegment` live in the dependency-free `parse-pattern.ts`
// so the client reverse helper can import them without dragging this module's
// server-only deps into the browser bundle. Re-exported here for existing
// importers (build/route-trie, middleware, tests).
export { parsePattern, type ParsedSegment };

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
  /**
   * The pattern's catch-all param, if any (`*` for bare `/*`, the name for a
   * named `:name+`/`:name*`). A zero-or-more catch-all (`oneOrMore: false`)
   * whose optional group is absent binds "" rather than being omitted — so
   * `/docs` matches `/docs/:slug*` with `slug === ""`. `oneOrMore` keeps the
   * same polarity as `ParsedSegment.oneOrMore` and the trie's `w1`.
   */
  catchAll?: { name: string; oneOrMore: boolean };
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
  let catchAll: { name: string; oneOrMore: boolean } | undefined;

  let regexPattern = "";

  for (const segment of segments) {
    if (segment.type === "wildcard") {
      // Wildcards capture the remainder under `segment.value` ("*" for the bare
      // form, the param name for a named catch-all).
      paramNames.push(segment.value);
      catchAll = { name: segment.value, oneOrMore: Boolean(segment.oneOrMore) };
      if (segment.oneOrMore) {
        // `:name+` — one-or-more, rejects the zero-segment (bare-prefix) case.
        regexPattern += "/(.+)";
      } else {
        // Zero-or-more catch-all: named `:name*` OR the bare `/*` (both parse to
        // `oneOrMore: false`). The whole `/segment` is optional so the bare
        // prefix matches directly, aligning the regex fallback with the trie
        // (which already matches the bare prefix binding "" — trie-matching.ts);
        // buildParamsFromMatch binds "" when the optional group is absent.
        //
        // The bare `/*` previously used a required `/(.*)`, so `/files/*` failed
        // to match `/files` and fell through to trailing-slash normalization,
        // emitting a corrupt `/file` redirect instead of a match (issue #636,
        // parity row C1). It is the same alignment #635 made for named `:name*`.
        regexPattern += "(?:/(.*))?";
      }
    } else if (segment.type === "param") {
      paramNames.push(segment.value);
      const suffixPattern = segment.suffix ? escapeRegExp(segment.suffix) : "";
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
      regexPattern += `/${escapeRegExp(segment.value)}`;
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
    ...(catchAll ? { catchAll } : {}),
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
 * Build the named-params record from a regex match. Optional segments that
 * didn't capture leave the corresponding group `undefined`; we skip those
 * keys so `ctx.params.<name>` reads as `undefined` rather than `""`. This
 * keeps the runtime aligned with the `ExtractParams` type and matches the
 * trie matcher's contract (see `trie-matching.ts:validateAndBuild`).
 *
 * A zero-or-more catch-all (`compiled.catchAll`, `oneOrMore: false`) whose
 * optional group didn't capture binds "" instead of being omitted, so `/docs`
 * matches `/docs/:slug*` with `slug === ""`. Exported so the `renderRoute`
 * testing harness (`matchLeaf`) shares this exact logic instead of forking it.
 */
export function buildParamsFromMatch(
  match: RegExpExecArray,
  paramNames: string[],
  catchAll?: { name: string; oneOrMore: boolean },
): Record<string, string> {
  const params: Record<string, string> = {};
  paramNames.forEach((name, index) => {
    const captured = match[index + 1];
    if (captured !== undefined) {
      // A catch-all remainder decodes identically whether split-per-segment or
      // whole-string (a literal `/` never lives inside a `%XX` escape), so a
      // single decode is correct and cheapest.
      params[name] = safeDecodeURIComponent(captured);
    } else if (catchAll && name === catchAll.name && !catchAll.oneOrMore) {
      // A zero-or-more catch-all (`:name*` or the bare `/*`) whose optional
      // group was absent binds "" rather than being omitted.
      params[name] = "";
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

  // Walk segments and stop at the first that is a real param (`:name`) or a
  // wildcard (`*`). A literal `:` or `*` not at a segment boundary (e.g. the
  // `a:b` in `/a:b/c/:id`, or `tel:+1`) is a STATIC segment and must NOT
  // terminate the prefix — `pattern.indexOf(":")` misread it as a param marker,
  // returning "" and dropping the findMatch fast-skip optimization for that
  // entry on every request. Classification mirrors parsePattern: a leading `:`
  // marks a param, a leading `*` marks a wildcard.
  const hasLeadingSlash = pattern.startsWith("/");
  const body = hasLeadingSlash ? pattern.slice(1) : pattern;
  const segments = body.split("/");

  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(":") || segment.startsWith("*")) {
      break;
    }
    staticSegments.push(segment);
  }

  // No leading static segment (first segment is a param/wildcard) -> no prefix.
  if (staticSegments.length === 0) return "";
  // Every segment was static (no param/wildcard) -> the whole pattern is the
  // prefix. Preserve a trailing slash only when it existed in the input; a
  // split of "/a/b" yields ["a","b"] (no empty tail) so a re-join is exact.
  if (staticSegments.length === segments.length) return pattern;

  const prefix = staticSegments.join("/");
  return hasLeadingSlash ? "/" + prefix : prefix;
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

      const { regex, paramNames, hasTrailingSlash, constraints, catchAll } =
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
        const params = buildParamsFromMatch(match, paramNames, catchAll);

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
        const params = buildParamsFromMatch(altMatch, paramNames, catchAll);

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
