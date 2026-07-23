/**
 * Vercel OpenTelemetry tracing integration.
 *
 * Bridges the router's observable phases (request, middleware, action, loaders,
 * handler, render, ssr, response, background) onto OpenTelemetry spans so they
 * show up in Vercel's trace waterfall next to the platform's automatic spans,
 * with correct nesting. Vercel exposes tracing through OpenTelemetry (not a
 * native import-free API like Cloudflare), so this is a thin convenience over
 * `createOTelTracing`: it reads the global OTel tracer that `@vercel/otel`'s
 * `registerOTel()` installs.
 *
 * Usage (vercel preset). A Rango/Vite app does NOT auto-load `instrumentation.ts`
 * the way Next.js does, so export the tracing config from there and import it —
 * the import is what runs `registerOTel()`. A standalone `registerOTel()` that
 * nothing imports is a silent no-op (the tracer never registers, spans drop):
 *
 *   // instrumentation.ts
 *   import { registerOTel } from "@vercel/otel";
 *   import { createVercelTracing } from "@rangojs/router/vercel";
 *   registerOTel({ serviceName: "my-app" });
 *   export const tracing = createVercelTracing();
 *
 *   // router.tsx — importing `tracing` runs instrumentation.ts (and registerOTel)
 *   import { createRouter } from "@rangojs/router";
 *   import { tracing } from "./instrumentation.js";
 *   export const router = createRouter({ tracing });
 *
 * Two runtime caveats inherited from the platform:
 *   - Node.js runtime only. Vercel custom spans are unsupported on the Edge
 *     runtime; `startActiveSpan` also needs an AsyncLocalStorage context manager
 *     (which @vercel/otel configures on Node) for spans to nest correctly.
 *   - `registerOTel()` must run before the first request. Reading the tracer via
 *     `trace.getTracer` here is safe even if it runs first — the API's proxy
 *     tracer delegates to the provider once registered — but no provider means
 *     every span is a no-op (the request behaves exactly as if tracing were off).
 *
 * Whether spans are actually exported is governed by your OTel setup / Vercel
 * tracing destination, not by this adapter.
 */

import { trace } from "@opentelemetry/api";
import {
  createOTelTracing,
  type OTelActiveSpanTracer,
} from "../router/telemetry-otel.js";
import type {
  RouterTracingConfig,
  TracingToggleOptions,
} from "../router/tracing.js";

/**
 * Options for createVercelTracing. Extends the shared
 * {@link TracingToggleOptions} (`enabled` + per-phase `spans`) with the
 * Vercel-specific tracer selectors.
 */
export interface VercelTracingOptions extends TracingToggleOptions {
  /**
   * OTel instrumentation-scope name passed to `trace.getTracer()`. Defaults to
   * `"rango"`. Ignored when `tracer` is provided.
   */
  tracerName?: string;
  /**
   * Explicit tracer override. Defaults to the global OTel tracer
   * (`trace.getTracer(tracerName)`) — the provider `@vercel/otel`'s
   * `registerOTel()` installs. Pass this to bridge onto a tracer you own.
   */
  tracer?: OTelActiveSpanTracer;
}

/**
 * Create the tracing config for a Vercel router. Pass the result to
 * `createRouter({ tracing })`. Spans are emitted for the request, middleware,
 * action, loaders, handler, render, ssr, response, and background phases; pass
 * `spans` to turn individual phases off.
 *
 * @see createOTelTracing (`@rangojs/router`) for the underlying adapter on any
 *   platform with an OpenTelemetry SDK.
 * @see createCloudflareTracing (`@rangojs/router/cloudflare`) for the same slot
 *   using Cloudflare Workers native custom spans.
 */
export function createVercelTracing(
  options: VercelTracingOptions = {},
): RouterTracingConfig {
  const { tracerName = "rango", tracer, enabled, spans } = options;
  return createOTelTracing(tracer ?? trace.getTracer(tracerName), {
    enabled,
    spans,
  });
}
