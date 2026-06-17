/**
 * Phase + event instrumentation — the single internal API for observing router
 * work.
 *
 * The router exposes the same work on three surfaces, and the rule is: each
 * surface has exactly one owner here, so they cannot drift.
 *
 *   - observePhase(): a span of work. Co-emits the `debugPerformance` perf
 *     metric (metrics store -> [RSC Perf] timeline + Server-Timing) AND the
 *     platform span (tracing runner -> Cloudflare custom spans / OTel). From one
 *     wrap site, so the span set is always a subset of the perf phases and the
 *     two can't disagree. Phases that meter their own perf metric with a finer
 *     decomposition (request, middleware) pass `metric: false` and get the span
 *     only — still co-located, still one owner per surface.
 *   - observeEvent(): a discrete fact (TelemetrySink): cache decisions,
 *     revalidation decisions, handler errors, timeouts, origin rejections.
 *     Event-shaped, not phase-shaped — derived from the same call sites but a
 *     separate surface from spans.
 *
 * Why phases, not events, are the parent abstraction: Cloudflare's span API is
 * callback-bound (enterSpan wraps the actual work), so the callback boundary is
 * the source of truth — async-context nesting (a loader's KV/D1/fetch spans
 * landing under rango.loader) cannot be faithfully reconstructed from
 * after-the-fact start/end events. Spans drive; events are emitted alongside.
 *
 * Phase identity lives in the PHASES registry below, so the raw `rango.*` span
 * names, perf-metric labels, and span attributes have a single definition each.
 *
 * When neither perf surface nor tracing is active on the request, observePhase
 * is a direct call — no wrapper, no timestamp, no allocation.
 */

import { _getRequestContext } from "../server/request-context.js";
import { getRouterContext } from "./router-context.js";
import { resolveSink, safeEmit, type TelemetryEvent } from "./telemetry.js";
import { appendMetric } from "./metrics.js";
import {
  NOOP_TRACE_SPAN,
  traceSpan,
  runThenSettle,
  type TracePhase,
  type TraceSpan,
} from "./tracing.js";

/**
 * Perf-metric boundary for a phase, or `false` for span-only. `false` means the
 * caller records its own perf metric with a finer decomposition than a single
 * wrap (request: a grand total incl. pre-context bootstrap; middleware: pre/post
 * own-time), so observePhase opens the span but records no metric of its own.
 */
export type PhaseMetric = { label: string; depth?: number } | false;

/** Describes one observable phase across the perf and span surfaces. */
export interface PhaseSpec {
  /** Perf timeline label + Server-Timing name, or false for span-only. */
  metric: PhaseMetric;
  /** Span phase gate (per-phase toggle in the tracing config). */
  tracePhase: TracePhase;
  /** Span name (rango.*). */
  spanName: string;
  /** Span attributes set automatically when the span opens. */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * The router's observable phases. One definition per phase keeps the `rango.*`
 * span names, perf-metric labels, and identifying attributes from spreading
 * across call sites.
 */
export const PHASES = {
  /** Whole request pipeline. Span only — handler:total is metered directly. */
  request: {
    metric: false,
    tracePhase: "request",
    spanName: "rango.request",
  } as PhaseSpec,

  /** One middleware (incl. its downstream onion). Span only — the perf metric
   * is the middleware's exclusive pre/post own-time, recorded directly.
   * `metricLabel` is that metric's label (e.g. "middleware:auth@*"); it doubles
   * as the rango.middleware_name span attribute. */
  middleware: (metricLabel: string): PhaseSpec => ({
    metric: false,
    tracePhase: "middleware",
    spanName: "rango.middleware",
    attributes: { "rango.middleware_name": metricLabel },
  }),

  /**
   * One loader execution. `depth` is the perf-timeline indentation: 2 (default)
   * for render-time loaders that nest under the render phase; 1 for a standalone
   * fetchable `_rsc_loader` request, which has no render parent.
   */
  loader: (id: string, depth: number = 2): PhaseSpec => ({
    metric: { label: `loader:${id}`, depth },
    tracePhase: "loader",
    spanName: "rango.loader",
    attributes: { "rango.loader_id": id },
  }),

  /** Whole render phase: match + serialize + SSR. */
  render: {
    metric: { label: "render:total" },
    tracePhase: "render",
    spanName: "rango.render",
  } as PhaseSpec,

  /** SSR HTML render from the RSC stream. Colon-delimited like the other ssr:*
   * setup metrics (ssr:module-load / ssr:stream-mode). */
  ssr: {
    metric: { label: "ssr:render-html" },
    tracePhase: "ssr",
    spanName: "rango.ssr",
  } as PhaseSpec,
} as const;

/**
 * Instrument one unit of work: open its span AND (unless `metric: false`) record
 * its perf metric, from a single wrap site. fn is invoked exactly once with the
 * span (a no-op span when tracing is off); its return value is returned
 * unchanged and thrown errors / rejected promises propagate unchanged. When fn
 * returns a promise both the metric duration and the span end when it settles.
 *
 * Reads the metrics store + tracing off the RequestContext ALS, which is active
 * for the WHOLE request — contrast observeEvent, which reads the RouterContext
 * ALS (entered later, during match).
 */
export function observePhase<T>(
  spec: PhaseSpec,
  fn: (span: TraceSpan) => T,
): T {
  const reqCtx = _getRequestContext();
  const store = reqCtx?._metricsStore;
  const tracing = reqCtx?._tracing;

  // Neither surface active: direct call, zero overhead.
  if (!store && !tracing) return fn(NOOP_TRACE_SPAN);

  // Attributes only land on a real span, so skip the wrapper when only the perf
  // surface is active (traceSpan would apply them to NOOP_TRACE_SPAN for nothing).
  const attributes = spec.attributes;
  const wrapped: (span: TraceSpan) => T =
    attributes && tracing
      ? (span) => {
          for (const key in attributes) span.setAttribute(key, attributes[key]);
          return fn(span);
        }
      : fn;

  const runSpan = (): T =>
    traceSpan(tracing, spec.tracePhase, spec.spanName, wrapped);

  // Span-only — no perf metric to record (metric:false, or perf surface off).
  const metric = spec.metric;
  if (!store || metric === false) return runSpan();

  // Record the phase duration on EVERY termination — success or failure — so a
  // failed loader/render still shows its timing in the perf report (parity with
  // the old track().finally() path it replaced).
  const start = performance.now();
  return runThenSettle(runSpan, () => {
    appendMetric(
      store,
      metric.label,
      start,
      performance.now() - start,
      metric.depth,
    );
  });
}

/**
 * Emit one discrete telemetry event (the event-shaped counterpart to
 * observePhase). Resolves the sink from the active router context and stamps the
 * request id when the event omits it. No-op (and total — never throws) when no
 * sink is configured.
 *
 * This is the canonical emitter for SYNCHRONOUS facts that fire inside the
 * request's ALS scope (handler errors, timeouts, origin rejections, revalidation
 * decisions). A few emitters deliberately stay on the lower-level
 * resolveSink + safeEmit because observeEvent's lazy, per-call
 * getRouterContext() read does not fit them — keep this the complete list:
 *   - router.ts wrapLoaderPromise (loader.start/end/error) and
 *     segment-resolution/streamed-handler-telemetry.ts (streamed handler.error)
 *     capture the sink + request id EAGERLY and emit from a fire-and-forget
 *     continuation that runs after the ALS scope may have unwound.
 *   - router/match-handlers.ts resolves the sink ONCE for the hot match-pipeline
 *     loop (request.start/end/error, cache.decision, ...).
 *   - segment-resolution/helpers.ts emits via a caller-provided report.telemetry
 *     sink rather than the ALS router context.
 */
export function observeEvent(event: TelemetryEvent): void {
  // getRouterContext() either throws (real impl, outside a router context — e.g.
  // the build-time prerender path) or returns null/undefined (e.g. mocked).
  // Either way there is no sink to emit to, so swallow and return.
  let routerCtx: ReturnType<typeof getRouterContext> | null | undefined;
  try {
    routerCtx = getRouterContext();
  } catch {
    return;
  }
  if (!routerCtx?.telemetry) return;
  const stamped =
    event.requestId === undefined && routerCtx.requestId !== undefined
      ? ({ ...event, requestId: routerCtx.requestId } as TelemetryEvent)
      : event;
  safeEmit(resolveSink(routerCtx.telemetry), stamped);
}
