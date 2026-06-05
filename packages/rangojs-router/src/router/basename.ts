/**
 * Normalize a router basename to its canonical form: a single leading slash,
 * no trailing slash, and `undefined` for an empty or bare-"/" value.
 *
 * This is the single source of truth used by both createRouter() (so the RSC
 * handler stores a canonical basename on the request context) and the testing
 * primitives (so a consumer can pass the same un-normalized string their
 * createRouter() accepts and observe the same redirect() prefixing).
 */
export function normalizeBasename(basename?: string): string | undefined {
  if (!basename) return undefined;
  const trimmed = basename.replace(/^\/+|\/+$/g, "");
  return trimmed ? "/" + trimmed : undefined;
}
