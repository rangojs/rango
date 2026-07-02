/**
 * Requestless-prerender guard.
 *
 * The on-demand producer renders a route with only route params + env — never
 * the triggering request's cookies, headers, geo, or session (see the design's
 * Producer Semantics). Personalized reads during a producer render would bake
 * one visitor's data into a payload shared with everyone for that route.
 *
 * The producer marks its own request context with `_onDemandProducer: true`. The
 * standalone request-scoped helpers a handler reaches for — `cookies()`,
 * `headers()`, `invalidateClientCache()`, `keepClientCache()` — call
 * {@link assertNotInsidePrerenderProducer}, which throws
 * {@link PrerenderPersonalizationError}; the producer catches it and maps to a
 * `skipped-personalized` result, leaving any existing entry untouched. (The
 * producer context's own `ctx.cookie`/`header`/etc. remain the pre-existing
 * build-time no-op stubs over empty synthetic state — the guard covers the
 * standalone helpers, which are the reads that would otherwise see real request
 * data.)
 */

/** Thrown when a producer render touches request-specific state. */
export class PrerenderPersonalizationError extends Error {
  /** Cross-realm-safe brand (instanceof can fail across bundle/realm boundaries). */
  readonly isPrerenderPersonalizationError = true as const;

  constructor(api: string) {
    super(
      `${api} cannot be used during on-demand prerender. The prerender producer ` +
        `is requestless: it renders with route params and env only, and its output ` +
        `is a shared payload keyed by route + params. Reading request-scoped state ` +
        `(cookies, headers) or mutating the response here would leak one visitor's ` +
        `data to every later visitor. This route was skipped as personalized.`,
    );
    this.name = "PrerenderPersonalizationError";
  }
}

export function isPrerenderPersonalizationError(
  value: unknown,
): value is PrerenderPersonalizationError {
  return (
    value != null &&
    typeof value === "object" &&
    (value as PrerenderPersonalizationError).isPrerenderPersonalizationError ===
      true
  );
}

/**
 * Throw {@link PrerenderPersonalizationError} when `ctx` is a requestless
 * on-demand producer context. A no-op for the live request path and the
 * build/dev prerender paths (which do not set `_onDemandProducer`), so existing
 * callers are unaffected.
 */
export function assertNotInsidePrerenderProducer(
  ctx: unknown,
  api: string,
): void {
  if (
    ctx != null &&
    typeof ctx === "object" &&
    (ctx as { _onDemandProducer?: boolean })._onDemandProducer === true
  ) {
    throw new PrerenderPersonalizationError(api);
  }
}
