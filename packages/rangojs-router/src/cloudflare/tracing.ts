/**
 * Cloudflare custom-spans integration.
 *
 * Bridges the router's performance phases (request, middleware, loaders,
 * render, ssr) onto Cloudflare Workers custom spans so they show up in the
 * trace waterfall and OpenTelemetry exports next to the platform's automatic
 * spans (KV reads, D1 queries, fetch calls), with correct parent-child nesting.
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
 * Span duration note: a phase span ends when its callback's returned value (or
 * promise) settles, which for the streaming phases (request/render/ssr) is when
 * the Response or HTML/RSC stream is *constructed*, not when the body finishes
 * draining. Loader/Suspense work that settles while the body streams therefore
 * extends past the parent span's end, and platform spans emitted during that
 * drain (deferred SSR, waitUntil-scheduled cache writes) are siblings of the
 * automatic request span rather than children of rango.*. Phase spans bound
 * setup-to-stream-handoff; they are not a full request-duration measure.
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
 * loaders, render, and ssr phases; pass `spans` to turn individual phases off.
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
