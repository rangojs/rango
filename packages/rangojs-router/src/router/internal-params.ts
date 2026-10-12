/**
 * Strip internal _rsc* query params from a URL.
 * Returns a new URL with only user-facing params.
 *
 * A leaf, so request-scoped modules (server/rewrite-trail.ts) can strip
 * without importing the handler context's graph.
 */
export function stripInternalParams(url: URL): URL {
  const clean = new URL(url);
  for (const key of [...clean.searchParams.keys()]) {
    if (key.startsWith("_rsc")) {
      clean.searchParams.delete(key);
    }
  }
  return clean;
}
