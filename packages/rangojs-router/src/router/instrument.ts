/**
 * Phase instrumentation — the single internal API for observing a unit of
 * router work.
 *
 * The router has two timing surfaces over the same phases: the
 * `debugPerformance` perf report (the `[RSC Perf]` timeline + `Server-Timing`
 * header, via the metrics store) and platform spans (Cloudflare custom spans /
 * OpenTelemetry, via the span runner). Rather than instrument each phase twice
 * — which drifts (a phase ends up in one surface but not the other) — every
 * wrappable phase calls measurePhase() exactly once. It co-emits to BOTH
 * surfaces from one wrap site, so the span set is always a subset of the perf
 * phases and the two cannot diverge.
 *
 * Because Cloudflare's tracing API only wraps a callback (enterSpan), the wrap
 * site is the unit of truth: the perf metric is recorded from the same callback
 * boundary the span covers. When neither surface is active on the request,
 * measurePhase is a direct call — no wrapper, no timestamp, no allocation.
 *
 * Telemetry events (TelemetrySink: request.start/end, loader.start/end) are a
 * third, event-shaped surface over a subset of these phases; they are not wired
 * here yet, but the per-phase spec is the natural place to add them so all
 * surfaces stay anchored to the same sites.
 */

import { _getRequestContext } from "../server/request-context.js";
import { appendMetric } from "./metrics.js";
import {
  NOOP_TRACE_SPAN,
  traceSpan,
  type TracePhase,
  type TraceSpan,
} from "./tracing.js";

/** Describes one observable phase across the perf and span surfaces. */
export interface PhaseSpec {
  /** Perf timeline label + Server-Timing name (e.g. "render:total", "loader:<id>"). */
  metricLabel: string;
  /** Perf timeline indentation depth. */
  depth?: number;
  /** Span phase gate (per-phase toggle in the tracing config). */
  tracePhase: TracePhase;
  /** Span name (rango.*). */
  spanName: string;
}

/**
 * Instrument one unit of work: record its perf metric AND open its span, from a
 * single wrap site. fn is invoked exactly once with the span (a no-op span when
 * tracing is off); its return value is returned unchanged and thrown errors /
 * rejected promises propagate unchanged. When fn returns a promise both the
 * metric duration and the span end when it settles.
 */
export function measurePhase<T>(
  spec: PhaseSpec,
  fn: (span: TraceSpan) => T,
): T {
  const reqCtx = _getRequestContext();
  const store = reqCtx?._metricsStore;
  const tracing = reqCtx?._tracing;

  // Neither surface active: direct call, zero overhead.
  if (!store && !tracing) return fn(NOOP_TRACE_SPAN);

  const start = performance.now();
  const runSpan = (): T =>
    traceSpan(tracing, spec.tracePhase, spec.spanName, fn);

  // Span only — no perf metric to record.
  if (!store) return runSpan();

  const record = (value: T): T => {
    appendMetric(
      store,
      spec.metricLabel,
      start,
      performance.now() - start,
      spec.depth,
    );
    return value;
  };

  const out = runSpan();
  return out instanceof Promise
    ? (out.then(record) as unknown as T)
    : record(out);
}
