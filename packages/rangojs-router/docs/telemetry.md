# Router Telemetry

The router emits structured lifecycle events through a pluggable telemetry sink.
When no sink is configured, telemetry is completely disabled (zero overhead).

`createRouter()` and the built-in telemetry sink factories are root
server/RSC APIs. Use them from router definition files and other server/RSC
modules, not from client components. Client hooks and components still come
from `@rangojs/router/client`.

## Quick Start

### Console Sink (Development)

```typescript
import { createRouter, createConsoleSink } from "@rangojs/router";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  telemetry: createConsoleSink(),
});
```

Output:

```
[telemetry] request.start GET /blog (match)
[telemetry] loader.start BlogLoader (blog-page)
[telemetry] loader.end BlogLoader 12.3ms ok=true
[telemetry] request.end GET /blog 15.1ms segments=3 cache=false
```

### OpenTelemetry Sink (Production)

```typescript
import { createRouter, createOTelSink } from "@rangojs/router";
import { trace } from "@opentelemetry/api";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  telemetry: createOTelSink(trace.getTracer("my-app")),
});
```

The OTel adapter maps router events to spans with the `rango.*` attribute
namespace. It is structurally typed against the `@opentelemetry/api` `Tracer`
interface, so any compatible tracer works without version coupling.

### Custom Sink

Implement the `TelemetrySink` interface to send events to any backend:

```typescript
import {
  createRouter,
  type TelemetrySink,
  type TelemetryEvent,
} from "@rangojs/router";

const metricsSink: TelemetrySink = {
  emit(event: TelemetryEvent) {
    switch (event.type) {
      case "request.end":
        myMetrics.histogram("rango.request.duration", event.durationMs, {
          method: event.method,
          path: event.pathname,
          cache_hit: String(event.cacheHit),
        });
        break;
      case "loader.end":
        myMetrics.histogram("rango.loader.duration", event.durationMs, {
          loader: event.loaderName,
          ok: String(event.ok),
        });
        break;
    }
  },
};

const router = createRouter({
  telemetry: metricsSink,
});
```

## Event Types

All events include a `timestamp` (from `performance.now()`) and an optional
`requestId` extracted from request headers. The router checks
`x-rsc-router-request-id`, `x-request-id`, and `cf-ray` (in that order).

| Event                   | Lifecycle                                            |
| ----------------------- | ---------------------------------------------------- |
| `request.start`         | Emitted when a request enters the router             |
| `request.end`           | Emitted when a request completes successfully        |
| `request.error`         | Emitted when a request fails with an unhandled error |
| `loader.start`          | Emitted when a loader begins execution               |
| `loader.end`            | Emitted when a loader completes (success or failure) |
| `loader.error`          | Emitted when a loader throws an error                |
| `handler.error`         | Emitted on handler or segment render failure         |
| `cache.decision`        | Emitted when a cache lookup result is determined     |
| `revalidation.decision` | Emitted when a segment revalidation decision is made |

### Request Events

```typescript
// request.start
{
  type: "request.start",
  method: "GET",
  pathname: "/blog/hello",
  transaction: "match" | "matchPartial",  // full document vs navigation
  isPartial: boolean,
}

// request.end
{
  type: "request.end",
  method: "GET",
  pathname: "/blog/hello",
  transaction: "match" | "matchPartial",
  durationMs: 15.2,
  segmentCount: 3,
  cacheHit: false,
}

// request.error
{
  type: "request.error",
  method: "GET",
  pathname: "/blog/hello",
  transaction: "match" | "matchPartial",
  error: Error,
  phase: "middleware",  // where the error occurred
  durationMs: 2.1,
}
```

### Loader Events

```typescript
// loader.start
{
  type: "loader.start",
  segmentId: "blog-page",
  loaderName: "BlogLoader",
  pathname: "/blog/hello",
}

// loader.end
{
  type: "loader.end",
  segmentId: "blog-page",
  loaderName: "BlogLoader",
  pathname: "/blog/hello",
  durationMs: 12.3,
  ok: true,
}

// loader.error
{
  type: "loader.error",
  segmentId: "blog-page",
  loaderName: "BlogLoader",
  pathname: "/blog/hello",
  error: Error,
  handledByBoundary: true,
}
```

### Handler / Segment Error Events

Emitted for route handler errors, streamed segment render failures,
and parallel-slot errors. Covers any error caught by an error boundary
during segment resolution.

```typescript
{
  type: "handler.error",
  segmentId: "blog-page",       // optional
  segmentType: "route",         // "route" | "parallel" | etc. (optional)
  error: Error,
  handledByBoundary: true,
  pathname: "/blog/hello",      // optional
  routeKey: "blog:post",        // optional
  params: { slug: "hello" },    // optional
}
```

### Cache Decision Events

```typescript
{
  type: "cache.decision",
  pathname: "/blog/hello",
  routeKey: "blog:post",
  hit: true,
  shouldRevalidate: false,
  source: "runtime" | "prerender",  // optional
}
```

### Revalidation Decision Events

```typescript
{
  type: "revalidation.decision",
  segmentId: "blog-page",
  pathname: "/blog/hello",
  routeKey: "blog:post",
  shouldRevalidate: true,
}
```

## OTel Span Mapping

The `createOTelSink` adapter maps events to OpenTelemetry spans:

| Span Name                     | Type     | Key Attributes                                                                                                    |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `rango.request`               | Duration | `http.method`, `http.route`, `rango.transaction`, `rango.segment_count`, `rango.cache.hit`                        |
| `rango.loader`                | Duration | `rango.segment_id`, `rango.loader_name`, `rango.duration_ms`, `rango.loader.ok`                                   |
| `rango.handler.error`         | Instant  | `rango.segment_id`, `rango.segment_type`, `rango.route_key`, `rango.handled_by_boundary` (handler/segment errors) |
| `rango.cache.decision`        | Instant  | `rango.cache.hit`, `rango.cache.should_revalidate`, `rango.cache.source`                                          |
| `rango.revalidation.decision` | Instant  | `rango.segment_id`, `rango.route_key`, `rango.revalidate`                                                         |

Duration spans are started on `*.start` events and ended on `*.end` or `*.error`.
Instant spans are created and ended immediately for point-in-time events.

### Span Correlation

The adapter correlates start/end events using composite keys. Request spans
use `requestId + pathname + transaction`. Loader spans use
`requestId + segmentId + loaderName + pathname`. When a request ID header
is present, concurrent requests to the same path are correctly correlated
even if they complete out of order.

### Error Recording

Error spans call `span.recordException(error)` and set
`SpanStatusCode.ERROR` with the error message. Loader errors that occur without
a matching `loader.start` event produce a standalone error span.

## Cloudflare Workers Example

```typescript
import { createRouter, createOTelSink } from "@rangojs/router";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("my-app", "1.0.0");

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  telemetry: createOTelSink(tracer),
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.fetch(request, { env, ctx });
  },
};
```

## Combining Sinks

To send events to multiple backends, compose sinks:

```typescript
import {
  createRouter,
  createConsoleSink,
  createOTelSink,
  type TelemetrySink,
  type TelemetryEvent,
} from "@rangojs/router";
import { trace } from "@opentelemetry/api";

function combineSinks(...sinks: TelemetrySink[]): TelemetrySink {
  return {
    emit(event: TelemetryEvent) {
      for (const sink of sinks) {
        sink.emit(event);
      }
    },
  };
}

const router = createRouter({
  telemetry: combineSinks(
    createConsoleSink(),
    createOTelSink(trace.getTracer("my-app")),
  ),
});
```

## Exports

All telemetry APIs are exported from the root `@rangojs/router` server/RSC
entrypoint:

```typescript
// Sink factories
import { createConsoleSink, createOTelSink } from "@rangojs/router";

// Types
import type {
  TelemetrySink,
  TelemetryEvent,
  OTelTracer,
  OTelSpan,
  RequestStartEvent,
  RequestEndEvent,
  RequestErrorEvent,
  LoaderStartEvent,
  LoaderEndEvent,
  LoaderErrorEvent,
  HandlerErrorEvent,
  CacheDecisionEvent,
  RevalidationDecisionEvent,
} from "@rangojs/router";
```
