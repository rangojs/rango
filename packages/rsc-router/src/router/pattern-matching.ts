/**
 * Router Pattern Matching
 *
 * Route pattern compilation and matching utilities.
 */

import type { RouteEntry } from "../types";
import type { EntryData } from "../server/context";

/**
 * Compile a route pattern to regex
 */
export function compilePattern(pattern: string): {
  regex: RegExp;
  paramNames: string[];
} {
  console.log("pattern", pattern);

  const paramNames: string[] = [];
  const regexPattern = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        const paramName = segment.slice(1);
        paramNames.push(paramName);
        return "([^/]+)";
      }
      if (segment === "*") {
        paramNames.push("*");
        return "(.*)";
      }
      return segment;
    })
    .join("/");

  return {
    regex: new RegExp(`^${regexPattern}$`),
    paramNames,
  };
}

/**
 * Match a pathname against registered routes
 */
export function findMatch<TEnv>(
  pathname: string,
  routesEntries: RouteEntry<TEnv>[]
): {
  entry: RouteEntry<TEnv>;
  routeKey: string;
  params: Record<string, string>;
} | null {
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
      console.log(fullPattern);

      const { regex, paramNames } = compilePattern(fullPattern);
      const match = regex.exec(pathname);

      if (match) {
        const params: Record<string, string> = {};
        paramNames.forEach((name, index) => {
          params[name] = match[index + 1] || "";
        });

        return { entry, routeKey, params };
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
