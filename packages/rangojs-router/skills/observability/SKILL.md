---
name: observability
description: Debug Rango request performance with debugPerformance, Server-Timing, structured telemetry, and tracing
argument-hint:
---

# Observability

Use this when you need to understand request latency, cache decisions,
revalidation behavior, loader overlap, or production traces.

Rango exposes two complementary observability surfaces:

1. **Performance timeline** (`debugPerformance`) — per-request waterfall for
   local or targeted debugging. It prints to the console and emits
   `Server-Timing`.
2. **Structured telemetry** (`telemetry`) — lifecycle events sent to a pluggable
   sink for production monitoring, OpenTelemetry, or custom metrics.

See `packages/rangojs-router/docs/telemetry.md` for the complete event contract.

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

For OpenTelemetry:

```typescript
import { createRouter, createOTelSink } from "@rangojs/router";
import { trace } from "@opentelemetry/api";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  telemetry: createOTelSink(trace.getTracer("my-app")),
});
```

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
`handler.error`, `cache.decision`, and `revalidation.decision`.

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

## Zero-overhead defaults

`debugPerformance` is off by default, and `telemetry` emits nothing unless a sink
is configured. Per-request `ctx.debugPerformance()` lets you turn on the
waterfall only for the route, user, or query param you are investigating.
