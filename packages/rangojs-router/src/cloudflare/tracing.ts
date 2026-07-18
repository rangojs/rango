/**
 * Cloudflare custom-spans integration.
 *
 * Bridges the router's observable phases (request, middleware, action, loaders,
 * handler, render, ssr, response, background) onto Cloudflare Workers custom
 * spans so they show up in the trace waterfall and OpenTelemetry exports next
 * to the platform's automatic spans (KV reads, D1 queries, fetch calls), with
 * correct nesting.
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
 * (or promise) settles. For the streaming phases (request/render/ssr) that is at
 * stream CONSTRUCTION, not body-drain; rango.response marks that handoff
 * boundary explicitly (it wraps only response finalization, never the body).
 * Instrumentation is best-effort and never wraps or buffers the response body,
 * so it cannot regress streaming or latency. A loader/Suspense child that
 * resolves mid-stream therefore keeps a rango.loader span that can extend past
 * its render parent — overlapping spans are valid. Uses only the typed enterSpan
 * API; spans bound work up to stream-handoff, matching the co-emitted perf
 * metric. On deployed Workers a rango.response span may report 0 ms (non-I/O
 * timers are frozen); its position and attributes are the value.
 */

import { _getRequestContext } from "../server/request-context.js";
import {
  type RouterTracingConfig,
  type SpanRunner,
  type TracingToggleOptions,
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

/**
 * Options for createCloudflareTracing. Alias of the shared
 * {@link TracingToggleOptions} (`enabled` master switch + per-phase `spans`
 * toggles); the name is public API.
 */
export type CloudflareTracingOptions = TracingToggleOptions;

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
 * action, loaders, handler, render, ssr, response, and background phases; pass
 * `spans` to turn individual phases off.
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
