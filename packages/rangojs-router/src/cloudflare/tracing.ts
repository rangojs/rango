/**
 * Cloudflare custom-spans integration.
 *
 * Bridges the router's performance phases (request, middleware, action,
 * loaders, handler, render, ssr) onto Cloudflare Workers custom spans so they show
 * up in the trace waterfall and OpenTelemetry exports next to the platform's
 * automatic spans (KV reads, D1 queries, fetch calls), with correct nesting.
 *
 * Usage (Cloudflare preset only):
 *
 *   import { createRouter } from "@rangojs/router";
 *   import { createCloudflareTracing } from "@rangojs/router/cloudflare";
 *
 *   export const router = createRouter({
 *     tracing: createCloudflareTracing(),
 *   });
 *
 * The runner reads `executionContext.tracing` (the same object as
 * `import { tracing } from "cloudflare:workers"`) at call time. It is therefore
 * dependency-free: no `cloudflare:workers` import and no hard dependency on
 * `@cloudflare/workers-types`, matching the convention in cache/cf. When the
 * worker is not running on a tracing-enabled Cloudflare runtime — Node, dev
 * without a tracing destination, an older runtime — `executionContext.tracing`
 * is undefined and every span call falls through to the work directly, so the
 * request behaves exactly as if tracing were off. Whether spans are actually
 * recorded is governed by the `observability`/tracing block in wrangler config.
 *
 * Span duration note: enterSpan ends a span when its callback's returned value
 * (or promise) settles. The streaming phases (request/render/ssr/middleware) are
 * wrapped (in instrument.ts) so their callback awaits the response body's drain
 * before settling — the constructed Response is handed to the client immediately,
 * but the callback (hence the SPAN) stays open until the body finishes draining.
 * So these spans cover the full streamed request and loader/Suspense children
 * that resolve mid-stream nest under a still-open parent. This uses only the
 * typed enterSpan API; no startActiveSpan/end. The perf METRICS (render:total,
 * the middleware own-time, handler:total) stay construction-bound — they ship in
 * the Server-Timing header, flushed before drain — so a span reads at least as
 * long as its same-named metric, the difference being post-construction streaming.
 */

import { _getRequestContext } from "../server/request-context.js";
import {
  type RouterTracingConfig,
  type SpanRunner,
  type TracePhaseToggles,
  NOOP_TRACE_SPAN,
} from "../router/tracing.js";

/**
 * Minimal local view of Cloudflare's `Span`. Declared here (not imported from
 * `@cloudflare/workers-types`) to avoid a hard type dependency.
 */
interface CloudflareSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: boolean | number | string): void;
}

/** Minimal local view of Cloudflare's `Tracing` (only enterSpan is used). */
interface CloudflareTracing {
  enterSpan<T>(name: string, callback: (span: CloudflareSpan) => T): T;
}

/** Options for createCloudflareTracing. */
export interface CloudflareTracingOptions {
  /** Master switch. Defaults to true. */
  enabled?: boolean;
  /** Per-phase span toggles. Omitted phases default to enabled. */
  spans?: TracePhaseToggles;
}

/**
 * Resolve the per-request Cloudflare tracer from the active execution context.
 * Returns undefined off-Cloudflare or when tracing is not enabled for the
 * worker, in which case the caller runs the work without a span.
 */
function getRequestTracer(): CloudflareTracing | undefined {
  const executionContext = _getRequestContext()?.executionContext as
    | { tracing?: CloudflareTracing }
    | undefined;
  const tracing = executionContext?.tracing;
  return tracing && typeof tracing.enterSpan === "function"
    ? tracing
    : undefined;
}

const cloudflareSpanRunner: SpanRunner = (name, fn) => {
  const tracer = getRequestTracer();
  if (!tracer) return fn(NOOP_TRACE_SPAN);
  // enterSpan runs the callback now and ends the span when its return value
  // (or returned promise) settles; spans nest by JS async context. fn's param
  // is the narrower TraceSpan, so the wider CloudflareSpan satisfies it directly.
  return tracer.enterSpan(name, fn);
};

/**
 * Create the tracing config for a Cloudflare router. Pass the result to
 * `createRouter({ tracing })`. Spans are emitted for the request, middleware,
 * action, loaders, handler, render, and ssr phases; pass `spans` to turn
 * individual phases off.
 *
 * @see createOTelTracing (`@rangojs/router`) for the same slot on any platform
 *   with an OpenTelemetry SDK.
 */
export function createCloudflareTracing(
  options: CloudflareTracingOptions = {},
): RouterTracingConfig {
  return {
    runner: cloudflareSpanRunner,
    enabled: options.enabled ?? true,
    spans: options.spans,
  };
}
