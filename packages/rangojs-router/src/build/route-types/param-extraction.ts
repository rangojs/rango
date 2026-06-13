// ---------------------------------------------------------------------------
// Param extraction from route patterns
// ---------------------------------------------------------------------------

/**
 * Extract typed params from a route pattern string.
 * Matches `:paramName` and `:paramName?` (optional).
 * Custom regex constraints like `:id(\d+)` are ignored for type purposes.
 */
export function extractParamsFromPattern(
  pattern: string,
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  const regex = /:([a-zA-Z_$][\w$]*)(?:\([^)]+\))?(\?)?/g;
  let match;
  while ((match = regex.exec(pattern)) !== null) {
    params[match[1]!] = match[2] ? "string?" : "string";
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

// ---------------------------------------------------------------------------
// Shared route entry formatter
// ---------------------------------------------------------------------------

/**
 * Format a single route entry for codegen output.
 * Routes without search remain plain strings (params are extracted from
 * the pattern at the type level by ExtractParams).
 * Routes with search become objects with path and search fields.
 */
export function formatRouteEntry(
  key: string,
  pattern: string,
  _params?: Record<string, string>,
  search?: Record<string, string>,
): string {
  const hasSearch = search && Object.keys(search).length > 0;

  // JSON.stringify the pattern and search values so backslashes and quotes in a
  // route pattern (e.g. a custom regex constraint) survive interpolation into
  // both the type-level string and the runtime NamedRoutes value.
  if (!hasSearch) {
    return `  ${key}: ${JSON.stringify(pattern)},`;
  }

  const searchBody = Object.entries(search!)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
  return `  ${key}: { path: ${JSON.stringify(pattern)}, search: { ${searchBody} } },`;
}
