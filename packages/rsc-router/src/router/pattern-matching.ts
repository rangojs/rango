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
export function findMatch<TEnv>(
  pathname: string,
  routesEntries: RouteEntry<TEnv>[]
): {
  entry: RouteEntry<TEnv>;
  routeKey: string;
  params: Record<string, string>;
  optionalParams: Set<string>;
  redirectTo?: string;
} | null {
  const pathnameHasTrailingSlash = pathname.length > 1 && pathname.endsWith("/");
  // Try alternate pathname for redirect matching
  const alternatePathname = pathnameHasTrailingSlash
    ? pathname.slice(0, -1)
    : pathname + "/";

  for (const entry of routesEntries) {
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
          const canonicalPath = pathnameHasTrailingSlash ? alternatePathname : pathname;
          if (pathnameHasTrailingSlash) {
            return { entry, routeKey, params, optionalParams, redirectTo: canonicalPath };
          }
          return { entry, routeKey, params, optionalParams };
        } else if (trailingSlashMode === "always") {
          // Redirect to with trailing slash
          const canonicalPath = pathnameHasTrailingSlash ? pathname : alternatePathname;
          if (!pathnameHasTrailingSlash) {
            return { entry, routeKey, params, optionalParams, redirectTo: canonicalPath };
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
