/**
 * OpenTelemetry tracing setup for the Vercel app.
 *
 * Hybrid wiring, one build, two paths chosen at startup:
 *
 *   - Real (default): call `@vercel/otel`'s `registerOTel()` to install the
 *     global OpenTelemetry provider, then `createVercelTracing()` reads that
 *     global tracer. This is the pattern a real Vercel consumer ships; spans
 *     export to Vercel's trace waterfall / a Trace Drain on a Node-runtime
 *     deploy. (Custom spans are Node-only — unsupported on the Edge runtime.)
 *
 *   - Debug (`RANGO_TRACE_DEBUG=1`, e2e only): swap in an in-memory recording
 *     tracer via `createVercelTracing({ tracer })` so the emitted `rango.*`
 *     spans can be read back through the `/__debug/trace` route. This exercises
 *     the real `createVercelTracing` public API end-to-end without a deploy.
 *
 * `registerOTel()` must run before the first request. This module is imported by
 * `router.tsx`, which the generated function entry loads at startup — i.e.
 * before any request — and `trace.getTracer()` (inside `createVercelTracing`) is
 * safe even if it runs first: the OTel API's proxy tracer delegates to the
 * provider once registered.
 */

import { registerOTel } from "@vercel/otel";
import { createVercelTracing } from "@rangojs/router/vercel";
import { createOTelSink } from "@rangojs/router";
import type { RouterTracingConfig, TelemetrySink } from "@rangojs/router";
import { recordingTracer } from "./trace-debug.js";

const DEBUG = process.env.RANGO_TRACE_DEBUG === "1";

export function buildTracing(): RouterTracingConfig {
  if (DEBUG) {
    return createVercelTracing({ tracer: recordingTracer });
  }
  registerOTel({ serviceName: "rango-vercel-basic" });
  return createVercelTracing();
}

/**
 * Telemetry sink for the discrete-fact events (cache.decision, timeout, ...).
 * Same hybrid switch as buildTracing: in the e2e debug build the in-memory
 * recorder backs the sink so createOTelSink's instant spans land in the
 * /__debug/trace tree; in the real path the slot stays unset (the tracing slot
 * already emits the phase spans this example demonstrates).
 */
export function buildTelemetry(): TelemetrySink | undefined {
  return DEBUG ? createOTelSink(recordingTracer) : undefined;
}
