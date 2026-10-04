/**
 * Wire protocol for CLIENT-RUN per-loader revalidation decisions.
 *
 * clientUrls() revalidate() predicates are declared in a "use client" module,
 * so they cannot cross the projection boundary as functions — instead they
 * EXECUTE in the browser and only their DECISIONS cross: the browser attaches
 * this header to partial-navigation and action requests, and the synthesized
 * per-loader revalidate() on every materialized loader stub reads it back
 * (see materializeRouteItems in server-projection.ts).
 *
 * Trust model: same class as `_rsc_segments` — a decision can only make the
 * CLIENT's own view staler (skip) or fresher (force), and the synthesized
 * predicates exist only on client-urls loader stubs, so the header can never
 * influence server-tree loaders. Requests without the header (no-JS, PE,
 * prefetch, document loads) fall back to the locked server defaults.
 */

export const CLIENT_REVALIDATION_HEADER = "X-Rango-Client-Reval";

export interface ClientRevalidationDecisions {
  /** Loader $$ids whose client predicate said false (keep held data). */
  readonly skip: readonly string[];
  /** Loader $$ids whose client predicate said true against a false default. */
  readonly force: readonly string[];
}

export function encodeClientRevalidationDecisions(
  decisions: ClientRevalidationDecisions,
): string | null {
  if (decisions.skip.length === 0 && decisions.force.length === 0) return null;
  // encodeURIComponent keeps the header value ISO-8859-1-safe regardless of
  // what characters loader module ids contain.
  return encodeURIComponent(
    JSON.stringify({ skip: decisions.skip, force: decisions.force }),
  );
}

export function decodeClientRevalidationDecisions(
  headerValue: string | null,
): ClientRevalidationDecisions | null {
  if (!headerValue) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(headerValue)) as {
      skip?: unknown;
      force?: unknown;
    };
    const toIds = (value: unknown): readonly string[] =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
    return { skip: toIds(parsed.skip), force: toIds(parsed.force) };
  } catch {
    // A malformed header is treated as absent: locked defaults apply.
    return null;
  }
}
