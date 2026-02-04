/**
 * Router Pattern Matching
 *
 * Route pattern compilation and matching utilities.
 */

import type { RouteEntry, TrailingSlashMode } from "../types";
import type { EntryData } from "../server/context";

/**
 * Parsed segment info
 */
interface ParsedSegment {
  type: "static" | "param" | "wildcard";
  value: string; // static text, param name, or "*"
  optional: boolean;
  constraint?: string[]; // enum values like ["en", "gb"]
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
function parsePattern(pattern: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  // Match: /segment where segment can be:
  // - static text
  // - :param
  // - :param?
  // - :param(a|b)
  // - :param(a|b)?
  // - *
  const segmentRegex = /\/(:([a-zA-Z_][a-zA-Z0-9_]*)(\(([^)]+)\))?(\?)?|(\*)|([^/]+))/g;

  let match;
  while ((match = segmentRegex.exec(pattern)) !== null) {
    const [, , paramName, , constraint, optional, wildcard, staticText] = match;

    if (wildcard) {
      segments.push({ type: "wildcard", value: "*", optional: false });
    } else if (paramName) {
      segments.push({
        type: "param",
        value: paramName,
        optional: optional === "?",
        constraint: constraint ? constraint.split("|") : undefined,
      });
    } else if (staticText) {
      segments.push({ type: "static", value: staticText, optional: false });
    }
  }

  return segments;
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
export function compilePattern(pattern: string): {
  regex: RegExp;
  paramNames: string[];
  optionalParams: Set<string>;
  hasTrailingSlash: boolean;
} {
  // Detect if pattern has trailing slash (but not just "/")
  const hasTrailingSlash = pattern.length > 1 && pattern.endsWith("/");
  // Remove trailing slash for parsing (we'll add it back to regex if needed)
  const normalizedPattern = hasTrailingSlash ? pattern.slice(0, -1) : pattern;

  const segments = parsePattern(normalizedPattern);
  const paramNames: string[] = [];
  const optionalParams = new Set<string>();

  let regexPattern = "";

  for (const segment of segments) {
    if (segment.type === "wildcard") {
      paramNames.push("*");
      regexPattern += "/(.*)";
    } else if (segment.type === "param") {
      paramNames.push(segment.value);
      const valuePattern = segment.constraint
        ? `(${segment.constraint.join("|")})`
        : "([^/]+)";

      if (segment.optional) {
        optionalParams.add(segment.value);
        // Optional: make the whole /segment optional
        regexPattern += `(?:/${valuePattern})?`;
      } else {
        regexPattern += `/${valuePattern}`;
      }
    } else {
      // Static segment
      regexPattern += `/${escapeRegex(segment.value)}`;
    }
  }

  // Handle root path
  if (regexPattern === "") {
    regexPattern = "/";
  }

  // Add trailing slash to regex if pattern has one
  if (hasTrailingSlash) {
    regexPattern += "/";
  }

  return {
    regex: new RegExp(`^${regexPattern}$`),
    paramNames,
    optionalParams,
    hasTrailingSlash,
  };
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a pathname can possibly match a prefix pattern.
 * Used to short-circuit route matching for include() groups.
 *
 * This is a fast, conservative check - it may return true for paths
 * that ultimately don't match any routes, but it should never return
 * false for paths that could match.
 *
 * @returns true if pathname could match prefix, false if definitely not
 */
export function canPrefixMatch(pathname: string, prefix: string): boolean {
  // Empty or root prefix always matches
  if (!prefix || prefix === "/") return true;

  // Parse prefix into segments
  const segments = parsePattern(prefix);
  if (segments.length === 0) return true;

  // Check if prefix is entirely static (no params)
  const allStatic = segments.every((s) => s.type === "static");

  if (allStatic) {
    // For static prefixes, pathname must start with the prefix
    // Build the static prefix string
    const staticPrefix = "/" + segments.map((s) => s.value).join("/");

    // Check exact prefix match or prefix followed by /
    if (pathname === staticPrefix) return true;
    if (pathname.startsWith(staticPrefix + "/")) return true;

    // Handle trailing slash in prefix
    if (staticPrefix.endsWith("/")) {
      const withoutSlash = staticPrefix.slice(0, -1);
      if (pathname === withoutSlash) return true;
      if (pathname.startsWith(withoutSlash + "/")) return true;
    }

    return false;
  }

  // For prefixes with params, do segment-by-segment checks
  const pathnameSegments = pathname.split("/").filter(Boolean);

  // Count minimum required segments in prefix
  const minRequiredSegments = segments.filter((s) => !s.optional).length;

  // If pathname doesn't have enough segments, can't match
  if (pathnameSegments.length < minRequiredSegments) {
    return false;
  }

  // Check each prefix segment against pathname
  let pathnameIdx = 0;
  for (const seg of segments) {
    if (pathnameIdx >= pathnameSegments.length) {
      // Ran out of pathname segments
      // OK if remaining prefix segments are optional
      if (!seg.optional) return false;
      continue;
    }

    const pathSeg = pathnameSegments[pathnameIdx];

    if (seg.type === "static") {
      // Static segment must match exactly
      if (seg.value !== pathSeg) {
        return false;
      }
      pathnameIdx++;
    } else if (seg.type === "param") {
      // Param segment - check constraint if any
      if (seg.constraint && !seg.constraint.includes(pathSeg)) {
        return false;
      }
      // For optional params, only consume if there's a match or no constraint
      if (seg.optional && seg.constraint && !seg.constraint.includes(pathSeg)) {
        // Don't consume this segment, param is optional and doesn't match constraint
        continue;
      }
      pathnameIdx++;
    } else if (seg.type === "wildcard") {
      // Wildcard matches anything - always OK
      return true;
    }
  }

  return true;
}

/**
 * Match a pathname against registered routes
 *
 * Note: Optional params that are absent in the path will have empty string value.
 * Use the pattern definition to determine if a param is optional.
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
  optionalParams: Set<string>;
  redirectTo?: string;
}

export function findMatch<TEnv>(
  pathname: string,
  routesEntries: RouteEntry<TEnv>[]
): RouteMatchResult<TEnv> | null {
  const pathnameHasTrailingSlash = pathname.length > 1 && pathname.endsWith("/");
  // Try alternate pathname for redirect matching
  const alternatePathname = pathnameHasTrailingSlash
    ? pathname.slice(0, -1)
    : pathname + "/";

  for (const entry of routesEntries) {
    // OPTIMIZATION: Skip this entry if prefix can't possibly match
    // This short-circuits include() groups with non-matching prefixes
    if (!canPrefixMatch(pathname, entry.prefix)) {
      continue;
    }

    const routeEntries = Object.entries(entry.routes);

    for (const [routeKey, pattern] of routeEntries) {
      // Join prefix and pattern, handling edge cases
      let fullPattern: string;
      if (entry.prefix === "" || entry.prefix === "/") {
        fullPattern = pattern;
      } else if (pattern === "/" || pattern === "") {
        fullPattern = entry.prefix;
      } else {
        fullPattern = entry.prefix + pattern;
      }

      const { regex, paramNames, optionalParams, hasTrailingSlash } = compilePattern(fullPattern);

      // Get trailing slash mode for this route (per-route config or pattern-based)
      const trailingSlashMode: TrailingSlashMode | undefined = entry.trailingSlash?.[routeKey];


      // Try exact match first
      const match = regex.exec(pathname);
      if (match) {
        const params: Record<string, string> = {};
        paramNames.forEach((name, index) => {
          params[name] = match[index + 1] ?? "";
        });

        // Check if trailing slash mode requires redirect even on exact match
        if (trailingSlashMode === "always" && !pathnameHasTrailingSlash && pathname !== "/") {
          // Mode says always have trailing slash, but pathname doesn't have it
          return { entry, routeKey, params, optionalParams, redirectTo: pathname + "/" };
        } else if (trailingSlashMode === "never" && pathnameHasTrailingSlash) {
          // Mode says never have trailing slash, but pathname has it
          return { entry, routeKey, params, optionalParams, redirectTo: pathname.slice(0, -1) };
        }

        return { entry, routeKey, params, optionalParams };
      }

      // Try alternate pathname (opposite trailing slash)
      const altMatch = regex.exec(alternatePathname);
      if (altMatch) {
        const params: Record<string, string> = {};
        paramNames.forEach((name, index) => {
          params[name] = altMatch[index + 1] ?? "";
        });

        // Determine redirect behavior based on mode
        if (trailingSlashMode === "ignore") {
          // Match without redirect
          return { entry, routeKey, params, optionalParams };
        } else if (trailingSlashMode === "never") {
          // Redirect to no trailing slash
          if (pathnameHasTrailingSlash) {
            return { entry, routeKey, params, optionalParams, redirectTo: alternatePathname };
          }
          return { entry, routeKey, params, optionalParams };
        } else if (trailingSlashMode === "always") {
          // Redirect to with trailing slash
          if (!pathnameHasTrailingSlash) {
            return { entry, routeKey, params, optionalParams, redirectTo: alternatePathname };
          }
          return { entry, routeKey, params, optionalParams };
        } else {
          // No explicit mode - use pattern-based detection
          // Redirect to canonical form (what the pattern defines)
          const canonicalPath = hasTrailingSlash ? alternatePathname : pathname.slice(0, -1);
          return { entry, routeKey, params, optionalParams, redirectTo: canonicalPath };
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
    items.push(current); // Move up to next parent
    current = current.parent;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    yield items[i];
  }
}
