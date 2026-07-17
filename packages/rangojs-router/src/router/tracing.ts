/**
 * Span tracing hook (platform-agnostic).
 *
 * The core router emits its existing performance phases (request, middleware,
 * action, loaders, handler, render, ssr, response) as spans by calling
 * traceSpan() at a small set of execution boundaries. When no tracing is configured the call is a direct
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
 * pre/post metered directly), rango.action (action:<id>; server-action
 * execution, JS + no-JS/PE), rango.loader (loader:<id>; single metering site at
 * useLoader, plus the fetchable path), rango.handler (span-only, one per segment
 * route/layout handler execution; the handler:<id> perf metric is owned by the
 * track() at the call site), rango.render (render:total:<route>; normal AND
 * action-revalidation renders), rango.ssr (ssr:render-html), rango.response
 * (span-only; final response construction + host handoff — the explicit
 * stream-handoff marker, see below).
 *
 * Span-duration caveat (best-effort, never buffers): a span ends when its
 * callback's value (or promise) settles. For the streaming phases (request,
 * render, ssr) that is when the Response / HTML / RSC stream is CONSTRUCTED, not
 * when the body finishes draining — instrumentation never wraps or buffers the
 * response body, so it cannot regress response latency or streaming. A loader /
 * Suspense child that resolves while the body streams therefore keeps a
 * rango.loader span that can extend past its render parent; overlapping spans are
 * valid (the loader really did take that long). Phase spans bound the work up to
 * stream-handoff, which is also what the co-emitted perf metric measures.
 * rango.response makes that handoff boundary explicit: it wraps only response
 * finalization (redirect interception/guarding, Server-Timing mutation, final
 * response selection) after downstream execution returns, ending immediately
 * before the handler returns the Response to the host. It is handoff-bound,
 * never drain-bound — it never reads, tees, or awaits response.body, and it is
 * absent when the request throws before a response exists.
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
export type TracePhase =
  | "request"
  | "middleware"
  | "action"
  | "loader"
  | "handler"
  | "render"
  | "ssr"
  | "response";

/**
 * Per-phase span toggles. Omitted phases default to enabled. Derived from
 * TracePhase so a new phase cannot be silently missing here — the other phase
 * lists in this file (ALL_PHASES_ON, resolveTracing) are exhaustiveness-checked
 * by their Record<TracePhase, boolean> annotations.
 */
export type TracePhaseToggles = Partial<Record<TracePhase, boolean>>;

/**
 * The option pair shared by every tracing factory (enabled master switch +
 * per-phase span toggles). Extended by OTelTracingOptions,
 * CloudflareTracingOptions, VercelTracingOptions, and RouterTracingConfig so
 * a phase added to TracePhaseToggles propagates everywhere from one place.
 */
export interface TracingToggleOptions {
  /** Master switch. Defaults to true. */
  enabled?: boolean;
  /** Per-phase span toggles. Omitted phases default to enabled. */
  spans?: TracePhaseToggles;
}

/**
 * Value passed to `createRouter({ tracing })`. Produced by a platform factory
 * such as `createCloudflareTracing()`.
 */
export interface RouterTracingConfig extends TracingToggleOptions {
  /** Platform span runner. */
  runner: SpanRunner;
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
  action: true,
  loader: true,
  handler: true,
  render: true,
  ssr: true,
  response: true,
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
          action: spans.action ?? true,
          loader: spans.loader ?? true,
          handler: spans.handler ?? true,
          render: spans.render ?? true,
          ssr: spans.ssr ?? true,
          response: spans.response ?? true,
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
