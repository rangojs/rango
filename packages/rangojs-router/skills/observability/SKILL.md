---
name: observability
description: Debug Rango request performance with debugPerformance, Server-Timing, structured telemetry, and tracing. Use when a request feels slow and you need to see where time is spent, or wiring up tracing/telemetry for production requests.
argument-hint:
---

# Observability

Use this when you need to understand request latency, cache decisions,
revalidation behavior, loader overlap, or production traces.

Rango exposes two public observability surfaces and one development-only
diagnostic adapter:

1. **Performance timeline** (`debugPerformance`) — per-request waterfall for
   local or targeted debugging. It prints to the console and emits
   `Server-Timing`.
2. **Structured telemetry** (`telemetry`) — lifecycle events sent to a pluggable
   sink for production monitoring, OpenTelemetry, or custom metrics.
3. **Development MCP** (`rango mcp`) — bounded request, route, error, render,
   cache-tag, and revalidation facts from a running Vite dev server. It is read-only, requires
   no application telemetry sink, and is absent from production builds.

The essentials are below. The exported `TelemetryEvent` union type
(`import type { TelemetryEvent } from "@rangojs/router"`) is the full event
contract — every event kind and its fields are typed there.

Use the MCP when an agent needs to correlate one browser response with exact
framework decisions: read `X-Rango-Request-Id`, select it with `list_requests`,
then call `get_request_trace`, `explain_render`, `explain_cache_tags`, or
`explain_revalidation`. Browser DOM, console, and network state still belong to
the browser driver; production monitoring still belongs to telemetry/tracing.

## Performance timeline

Enable globally while debugging:

```typescript
import { createRouter } from "@rangojs/router";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  debugPerformance: true,
});
```

Or enable for selected requests from middleware:

```typescript
middleware(async (ctx, next) => {
  if (ctx.url.searchParams.has("debug")) {
    ctx.debugPerformance();
  }
  await next();
});
```

Call `ctx.debugPerformance()` before `await next()`. The request then prints a
shared-axis waterfall and adds a `Server-Timing` header.

Read the timeline as intervals:

- `handler:total` is the whole router request.
- `render:total` / `ssr-render-html` show the render pass.
- `loader:*` rows should overlap render work. If a loader starts only after the
  render bar, it is serialized latency.
- Cache, route matching, middleware pre/post, RSC serialization, and SSR phases
  appear as separate spans, so the slow phase is visible without guessing.

**Deployed Cloudflare caveat**: on production Workers, timers are frozen
during request execution (Spectre mitigation), so `Server-Timing` durations
read as ~0 on the deployed edge — they only advance across genuine awaited
I/O. The waterfall is a LOCAL diagnostic (dev, `vite preview`,
`wrangler dev`); for deployed workers, measure from the client
(`PerformanceResourceTiming`, TTFB) and use structured telemetry below for
server-side events.

## Structured telemetry

Use telemetry when you want durable production events rather than a one-request
debug waterfall.

```typescript
import { createRouter, createConsoleSink } from "@rangojs/router";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  telemetry: createConsoleSink(),
});
```

For OpenTelemetry — phase spans come from the `tracing` slot
(`createOTelTracing`), discrete-fact spans from the `telemetry` sink
(`createOTelSink`):

```typescript
import {
  createRouter,
  createOTelTracing,
  createOTelSink,
} from "@rangojs/router";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("my-app");

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  tracing: createOTelTracing(tracer), // request/loader/render/… phase spans
  telemetry: createOTelSink(tracer), // handler errors, cache decisions, …
});
```

On **Cloudflare Workers**, use `createCloudflareTracing` for the `tracing` slot
instead — it emits the same phases as native Cloudflare custom spans (in the
Workers trace waterfall, next to the automatic KV/D1/fetch spans), with no
`@opentelemetry/api` dependency:

```typescript
import { createRouter } from "@rangojs/router";
import { createCloudflareTracing } from "@rangojs/router/cloudflare";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  tracing: createCloudflareTracing(), // all phases on by default
  // tracing: createCloudflareTracing({ spans: { ssr: false } }), // toggle phases
});
```

On **Vercel Functions** (Node runtime), use `createVercelTracing` — a thin
wrapper over `createOTelTracing` that reads the global OTel tracer
`@vercel/otel`'s `registerOTel()` installs, so you do not call `trace.getTracer`
yourself. Custom spans are Node-only (unsupported on the Edge runtime):

```typescript
// instrumentation.ts — install the provider, then export the tracing config.
// Importing this module is what runs registerOTel() — a Rango/Vite app does not
// auto-load instrumentation.ts like Next.js, so a standalone registerOTel() that
// nothing imports is a silent no-op.
import { registerOTel } from "@vercel/otel";
import { createVercelTracing } from "@rangojs/router/vercel";
registerOTel({ serviceName: "my-app" });
export const tracing = createVercelTracing(); // { enabled, spans, tracerName, tracer }

// router.tsx — importing `tracing` runs instrumentation.ts
import { createRouter } from "@rangojs/router";
import { tracing } from "./instrumentation.js";

const router = createRouter({ document: Document, urls: urlpatterns, tracing });
```

These factories return a `RouterTracingConfig` for the same `tracing` slot;
`telemetry` stays independent (events only, no phase spans). Phase spans:
`rango.request`, `rango.middleware`, `rango.action`, `rango.loader`,
`rango.render`, `rango.ssr` — the same phases the `debugPerformance` timeline
shows, co-emitted from one site. Off-platform (no Cloudflare tracing destination
/ no OTel SDK) every span call is a transparent pass-through, so the request
behaves as if tracing were off.

Custom sinks implement `emit(event)`:

```typescript
import { createRouter } from "@rangojs/router";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  telemetry: {
    emit(event) {
      myMetrics.record(event);
    },
  },
});
```

Events include `request.start/end/error`, `loader.start/end/error`,
`handler.error`, `cache.decision`, `revalidation.decision`, `request.timeout`,
and `request.origin-rejected`.

## Debugging revalidation and stale data

When stale UI or unexpected partial renders are the question, use all three
layers together:

```typescript
import { createConsoleSink, createRouter } from "@rangojs/router";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  debugPerformance: true,
  telemetry: createConsoleSink(),
});
```

Then inspect:

- `revalidation.decision` telemetry to see which segment re-ran or skipped.
- cache spans / `cache.decision` events to see hit, miss, stale, and background
  revalidation behavior.
- loader spans to confirm live loaders overlap the render rather than blocking
  first paint.
- the `Server-Timing` header to compare local logs with browser-network timing.

## Disabled-by-default costs

`debugPerformance` is off by default, and public telemetry emits nothing unless
a sink is configured. Production builds retain that no-op fast path.
Development builds can still project the same local facts into the compile-gated
diagnostic hub for `rango mcp`; that is separate from public sink delivery.
Per-request `ctx.debugPerformance()` turns on the waterfall only for the route,
user, or query param you are investigating.
