/**
 * Span tracing hook (platform-agnostic).
 *
 * The core router emits its existing performance phases (request, middleware,
 * loaders, render, ssr) as spans by calling traceSpan() at a small set of
 * execution boundaries. When no tracing is configured the call is a direct
 * pass-through: fn is invoked with a no-op span, with no wrapper and no
 * allocation, so a non-traced request behaves exactly as before.
 *
 * A platform integration supplies a SpanRunner that wraps fn in a real span.
 * The only shipped runner is the Cloudflare one (createCloudflareTracing in
 * src/cloudflare/tracing.ts), which bridges these phases onto Cloudflare's
 * custom-spans API (executionContext.tracing.enterSpan). The runner wraps the
 * actual work — not a post-hoc event — so spans nest by async context and the
 * platform's automatic spans (KV/D1/fetch) nest under the right phase.
 *
 * Wrapped phases and their span boundaries:
 *   - rango.request    rsc/handler.ts        whole pipeline (inside the request context)
 *   - rango.middleware router/middleware.ts  per global/route/loader middleware (onion)
 *   - rango.loader     segment-resolution/loader-cache.ts  per loader execution
 *   - rango.render     rsc/rsc-rendering.ts  the match + serialize pass
 *   - rango.ssr        rsc/rsc-rendering.ts  the SSR HTML render
 *
 * Not yet wrapped (first cut, deliberate): intercept-route middleware
 * (executeInterceptMiddleware) and action-revalidation renders
 * (revalidateAfterAction). An action's revalidation loaders therefore still emit
 * rango.loader spans, but without a rango.render parent.
 *
 * Span-duration caveat: a span ends when its callback's value (or promise)
 * settles. For the streaming phases (request/render/ssr) that is when the
 * Response / HTML / RSC stream is constructed, NOT when the body finishes
 * draining. Loader/Suspense work that settles during stream drain extends past
 * the parent span's end, so parent durations under-report streamed time and a
 * rango.loader child can end after its parent. This is the streaming + end-on-
 * settle contract, not a defect; phase spans bound setup-to-stream-handoff.
 *
 * This mirrors the OTel adapter (createOTelSink): the core stays agnostic and
 * the platform-specific bridge lives at the edge.
 */

/**
 * Minimal span handle passed to traced work. Structurally compatible with both
 * Cloudflare's `Span` and OTel's `Span` (only setAttribute is used here).
 */
export interface TraceSpan {
  setAttribute(key: string, value: string | number | boolean): void;
}

/**
 * Wraps a unit of work in a span. A runner MUST invoke fn exactly once, pass it
 * a span, return fn's result unchanged, and propagate thrown errors / rejected
 * promises unchanged. When fn returns a promise the span ends once it settles.
 */
export type SpanRunner = <T>(name: string, fn: (span: TraceSpan) => T) => T;

/** The router phases that can be wrapped in a span. */
export type TracePhase = "request" | "middleware" | "loader" | "render" | "ssr";

/** Per-phase span toggles. Omitted phases default to enabled. */
export interface TracePhaseToggles {
  request?: boolean;
  middleware?: boolean;
  loader?: boolean;
  render?: boolean;
  ssr?: boolean;
}

/**
 * Value passed to `createRouter({ tracing })`. Produced by a platform factory
 * such as `createCloudflareTracing()`.
 */
export interface RouterTracingConfig {
  /** Platform span runner. */
  runner: SpanRunner;
  /** Master switch. Defaults to true when a config object is provided. */
  enabled?: boolean;
  /** Per-phase span toggles. */
  spans?: TracePhaseToggles;
}

/**
 * Resolved tracing state stored on the router/request context. `undefined`
 * means tracing is fully disabled and every traceSpan() call is a pass-through.
 */
export interface ResolvedTracing {
  runner: SpanRunner;
  phases: Record<TracePhase, boolean>;
}

/** Shared no-op span. setAttribute is a no-op so disabled call sites stay free. */
export const NOOP_TRACE_SPAN: TraceSpan = {
  setAttribute() {},
};

const ALL_PHASES_ON: Record<TracePhase, boolean> = {
  request: true,
  middleware: true,
  loader: true,
  render: true,
  ssr: true,
};

/**
 * Resolve a user-supplied tracing config into the fast internal form, or
 * `undefined` when tracing is off (no config, `enabled: false`, or no runner).
 */
export function resolveTracing(
  config: RouterTracingConfig | undefined,
): ResolvedTracing | undefined {
  if (
    !config ||
    config.enabled === false ||
    typeof config.runner !== "function"
  ) {
    return undefined;
  }
  const spans = config.spans;
  return {
    runner: config.runner,
    phases: spans
      ? {
          request: spans.request ?? true,
          middleware: spans.middleware ?? true,
          loader: spans.loader ?? true,
          render: spans.render ?? true,
          ssr: spans.ssr ?? true,
        }
      : ALL_PHASES_ON,
  };
}

/**
 * Wrap `fn` in a span for `phase`. When tracing is off (or the phase is
 * disabled) fn runs directly with a no-op span — identical to the untraced
 * path. Otherwise the platform runner wraps fn so the span covers the real
 * work and nests by async context.
 */
export function traceSpan<T>(
  tracing: ResolvedTracing | undefined,
  phase: TracePhase,
  name: string,
  fn: (span: TraceSpan) => T,
): T {
  if (tracing === undefined || tracing.phases[phase] === false) {
    return fn(NOOP_TRACE_SPAN);
  }
  return tracing.runner(name, fn);
}
