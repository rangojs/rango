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
 * Two runners ship: the Cloudflare one (createCloudflareTracing in
 * src/cloudflare/tracing.ts), which bridges onto executionContext.tracing.
 * enterSpan, and the OTel one (createOTelTracing in router/telemetry-otel.ts),
 * which bridges onto tracer.startActiveSpan. Both wrap the actual work — not a
 * post-hoc event — so spans nest by async context and the platform's automatic
 * spans (KV/D1/fetch) nest under the right phase.
 *
 * traceSpan() below is the low-level wrap primitive. It is INTERNAL: the only
 * caller is observePhase() (instrument.ts), the single phase-instrumentation
 * API, which co-emits the span AND the debugPerformance perf metric from one
 * wrap site (or just the span, for metric:false phases) so the two surfaces
 * can't drift. Every router phase routes through observePhase via the PHASES
 * registry; do not call traceSpan directly from new code.
 *
 * Phase coverage (all via observePhase): rango.request (span-only; handler:total
 * metered directly), rango.middleware (span-only incl. intercept middleware;
 * pre/post metered directly), rango.loader (loader:<id>; single metering site at
 * useLoader, plus the fetchable path), rango.render (render:total; normal AND
 * action-revalidation renders), rango.ssr (ssr-render-html).
 *
 * Span-duration caveat: a span ends when its callback's value (or promise)
 * settles. For the streaming phases (request/render/ssr) that is when the
 * Response / HTML / RSC stream is constructed, NOT when the body finishes
 * draining. Loader/Suspense work that settles during stream drain extends past
 * the parent span's end, so parent durations under-report streamed time and a
 * rango.loader child can end after its parent. This is the streaming + end-on-
 * settle contract, not a defect; phase spans bound setup-to-stream-handoff.
 *
 * Both shipped runners (Cloudflare, OTel) keep the core agnostic: the
 * platform-specific bridge lives at the edge behind the SpanRunner contract.
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

/**
 * Run `fn` once and invoke `onSettle` exactly once when it terminates — on a
 * synchronous return, a synchronous throw, an async resolution, or an async
 * rejection. `onSettle` receives the error (or `undefined` on success). fn's
 * value is returned and errors propagate unchanged.
 *
 * Centralizes the run-once-then-settle control flow shared by the two span
 * surfaces: observePhase records the perf metric on settle, and the OTel runner
 * ends (or error-marks) the span on settle. The Cloudflare runner delegates
 * settling to enterSpan, so it does not use this.
 */
export function runThenSettle<T>(
  fn: () => T,
  onSettle: (error: unknown) => void,
): T {
  let out: T;
  try {
    out = fn();
  } catch (error) {
    onSettle(error);
    throw error;
  }
  if (out instanceof Promise) {
    return out.then(
      (value) => {
        onSettle(undefined);
        return value;
      },
      (error) => {
        onSettle(error);
        throw error;
      },
    ) as unknown as T;
  }
  onSettle(undefined);
  return out;
}
