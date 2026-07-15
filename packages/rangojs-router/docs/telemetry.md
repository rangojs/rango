# Router Observability

When you need to see what the router is actually doing on a request — where the
time went, or what it decided and why — you reach for one of two systems. They
answer different questions, so the first thing to get straight is which one you
want.

The router has two complementary observability systems:

- **Performance timeline** (`debugPerformance`) — a per-request waterfall of
  every phase from handler entry to response, exposed as a console log and
  `Server-Timing` header. Designed for local development and per-request
  debugging.
- **Structured telemetry** (`telemetry`) — lifecycle events emitted through a
  pluggable sink (console, OpenTelemetry, custom). Designed for production
  monitoring and distributed tracing.

During `vite dev`, `rango mcp` adds a third, read-only adapter over the same owned
request facts. It can list exact server request IDs, retrieve a bounded trace,
query sanitized runtime errors, and report route declaration ownership without
requiring a `TelemetrySink`. It also projects segment-cache, PPR, loader
visible-generation, and revalidation decisions without running handlers or
predicates again. Node module-runner and Cloudflare workerd requests use the same
bounded hot-channel bridge into Vite. This adapter is absent from production
builds and is not a production observability backend; keep using telemetry and
tracing there.

The request tools are `list_requests`, `get_request_trace`, and `get_errors`.
`explain_render` joins cache, PPR, handler, and loader events for one request;
`explain_revalidation` keeps client-visible recomputation decisions on their
separate freshness axis.
`get_compilation_issues` also reports structured transform errors and bounded
recent Vite warnings. Its response marks warning coverage as `recent-only`
because Vite does not expose a stable current-warning registry.

---

## Performance Timeline

Enable with `debugPerformance: true` on the router:

```typescript
import { createRouter } from "@rangojs/router";

const router = createRouter({
  document: Document,
  urls: urlpatterns,
  debugPerformance: true,
});
```

Every HTML request prints a shared-axis waterfall to the console showing
exactly where time is spent:

```
[RSC Perf] GET / (24.53ms)
start      dur  span                    timeline
                                        0ms                              24.53ms
 0.00ms  0.02ms    middleware:auth@*    |#.......................................|
 0.02ms  1.30ms    ssr:module-load     |##......................................|
 0.02ms  0.04ms    ssr:stream-mode     |#.......................................|
 0.08ms  3.20ms    route-matching      |#####...................................|
 3.28ms  0.12ms    rsc-serialize       |.....#..................................|
 3.40ms  8.70ms    ssr:render-html     |.....##############.....................|
 0.00ms 12.22ms    render:total        |##################......................|
 0.00ms 24.53ms    handler:total       |########################################|
```

Each row shows a phase's start offset, duration, label, and a visual `#` bar
on a shared time axis. Phases that overlap (e.g. SSR module loading running in
parallel with route matching) are immediately visible.

### Middleware timeline

Middleware records two phases: the time **before** calling `next()` (setup,
auth checks) and the time **after** `next()` resolves (response post-processing).
These appear as a single row with **disjoint timeline segments**:

```
 0.00ms  1.42ms    middleware:auth@*   |##..............................####|
```

The first `#` region is the pre-phase (before `next()`), the gap is the
downstream handler, and the second `#` region is the post-phase (after
`next()` resolved). The displayed duration is the sum of both phases, so you
can immediately tell how much wall time the middleware itself consumed vs how
much it waited on downstream work.

Post-phase timing below 0.01ms is suppressed as measurement noise.

### Per-request opt-in

Instead of enabling `debugPerformance` globally, you can enable it per-request
from middleware. This is useful for targeted debugging in production — you get
the full timeline for specific routes or conditions without paying for it on
every request.

```typescript
// Query param toggle — append ?debug to any URL
async function debugMiddleware(ctx, next) {
  if (ctx.url.searchParams.has("debug")) {
    ctx.debugPerformance();
  }
  await next();
}
```

```typescript
// Target a specific slow route
async function checkoutPerfMiddleware(ctx, next) {
  if (ctx.url.pathname.startsWith("/checkout")) {
    ctx.debugPerformance();
  }
  await next();
}
```

```typescript
// Internal team debug cookie
async function teamDebugMiddleware(ctx, next) {
  if (ctx.req.headers.get("cookie")?.includes("__perf=1")) {
    ctx.debugPerformance();
  }
  await next();
}
```

The metrics store is created for that request only. The console timeline is
printed and `Server-Timing` headers are emitted as if `debugPerformance`
were enabled, without affecting other requests.

Call `ctx.debugPerformance()` **before** `await next()` — the metrics
store must exist when downstream phases (route matching, rendering, SSR)
run so they can record their spans. Calling it after `next()` returns
still emits `handler:total` but misses all upstream metrics.

Offsets anchor to the true request entry. The handler-entry timestamp is threaded
onto the request context, so a store created mid-request this way uses it — not
the opt-in moment — as the timeline origin. A phase whose start predates the
opt-in but is recorded once the store exists (for example a middleware `:pre`
whose clock started before its handler called `ctx.debugPerformance()`) then
reports its real, non-negative offset instead of clamping to `0ms`. A phase that
ran to completion entirely before you opted in is still not captured at all — the
store did not exist to record it (see the before-`next()` note above); the
anchoring fixes offsets, not the missing upstream metrics.

### Server-Timing header

When metrics are enabled, the response includes a `Server-Timing` header
with every phase encoded as a standard timing entry:

```
Server-Timing: handler-nonce;dur=0.01,
  handler-mw-match;dur=0.03,
  handler-manifest-cache;dur=0.02,
  handler-ctx-create;dur=0.12,
  handler-classify;dur=0.45,
  d1-middleware-auth-pre;dur=0.02,
  d1-middleware-auth-post;dur=1.40,
  ssr-module-load;dur=1.30,
  ssr-stream-mode;dur=0.04,
  route-matching;dur=3.20,
  rsc-serialize;dur=0.12,
  ssr-render-html;dur=8.70,
  render-total;dur=12.22,
  handler-total;dur=24.53
```

Open Chrome DevTools > Network > click a request > Timing tab to see these
as a waterfall. Nested metrics (like middleware) use a `d{depth}-` prefix.

Bootstrap handler phases (`handler-nonce`, `handler-mw-match`,
`handler-manifest-cache`, `handler-ctx-create`, `handler-classify`) are always
emitted in the `Server-Timing` header, even without `debugPerformance`, to give
a baseline view of handler overhead on every request.

PPR partial navigations also expose an always-on bounded response signal:
`x-rango-ppr-replay: HIT; freshness=fresh|stale` when matching consumed the
captured segment record, or `BYPASS; reason=<token>` when it fell open. This is
separate from document-only `x-rango-shell`. When metrics are enabled, the same
decision appears as `ppr-navigation-replay` with description `fresh`, `stale`,
or `bypass:<reason>`.

### Early SSR setup

SSR module loading and stream mode resolution are kicked off in parallel with
route matching. Requests that won't need SSR (RSC partials, actions, loaders,
Accept-based RSC, prerender collection) skip this entirely. Response and mime
routes also skip it — the setup runs after `classifyRequest()` determines the
request mode. In production, the SSR module is memoized across requests so
repeated imports resolve instantly.

### Metric reference

| Metric                                                 | Phase      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handler:total`                                        | Handler    | Full request duration from handler entry to response                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `route-matching`                                       | Matching   | Route lookups: full renders or partial fresh (all findMatch calls combined)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `route-matching:nav`                                   | Matching   | Prev + intercept-source lookups (partial reuse path)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `manifest-loading`                                     | Matching   | Async manifest load (when not cached)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ppr:navigation-replay`                                | Matching   | PPR partial-navigation decision; description is `fresh`, `stale`, or `bypass:<bounded-reason>`. Server-Timing folds the colon to `ppr-navigation-replay`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ssr:module-load`                                      | SSR setup  | Dynamic import of the SSR module                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ssr:stream-mode`                                      | SSR setup  | Stream mode resolution (sync or async)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `rsc-serialize`                                        | Rendering  | Synchronous RSC stream creation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ssr:render-html`                                      | Rendering  | SSR HTML rendering from RSC stream (co-emitted with the `rango.ssr` span). Server-Timing folds the colon to a hyphen (`ssr-render-html`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `action:{id}`                                          | Action     | Server-action execution (decode args + run the action body), before the revalidation render (co-emitted with `rango.action`); `{id}` is the action $$id, so the timeline shows which action ran. JS and no-JS/PE form actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `render:total:{route}`                                 | Rendering  | Whole render phase: match + serialize + SSR (co-emitted with `rango.render`); `{route}` is the matched route name (resolved at record time), falling back to bare `render:total` for unmatched / auto-named routes. Also emitted for an action-revalidation render                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `loader:{id}`                                          | Loader     | Per-loader EXECUTION, every executing path incl. fetchable (co-emitted with `rango.loader`). A loader-cache HIT does not execute, so it emits no `loader:` entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `handler:{id}`                                         | Handler    | Per-segment route/layout handler EXECUTION (the component/handler that produces a segment) — the dominant per-segment work. Paired with the `rango.handler` span (`rango.handler_id={id}`, mirroring `rango.loader_id`/`rango.action_id` — the handler id, NOT the emitted segment's `shortCode`); the metric is owned by `track()` at the call site, the span by `observeHandler`. A static/prerender HIT emits NO `rango.handler` span (no handler runs); the `handler:{id}` metric is still recorded for **layout/cache** entries (their `track()` wraps `resolveLayoutComponent`, which does the static lookup) but NOT for **route/parallel** entries (their static lookup precedes `track()`, so a static hit records neither). Server-Timing prefixes the depth (`d2-handler-{id}`) |
| `middleware:{name}@{scope}` / `middleware:{scope}#{n}` | Middleware | Combined pre + post own-time. Named handlers use `{name}@{scope}`; anonymous handlers use `{scope}#{ordinal}`. `scope` is the registered pattern or `*`. Span-only via `observePhase`; this metric is recorded directly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Zero overhead when disabled

When `debugPerformance` is false (the default) and no middleware calls
`ctx.debugPerformance()`, the timeline system adds no `.then()` callbacks,
no `performance.now()` calls, and no metrics store allocations to the
request path.

---

## Structured Telemetry

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

### Which tracing factory for my platform

Phase **spans** always come from the `tracing` slot. Pick the factory by platform:

| Platform                               | `tracing` slot              | Phase spans? |
| -------------------------------------- | --------------------------- | ------------ |
| Cloudflare Workers                     | `createCloudflareTracing()` | yes (native) |
| Vercel Functions (Node runtime)        | `createVercelTracing()`     | yes (OTel)   |
| Any platform with an OpenTelemetry SDK | `createOTelTracing(tracer)` | yes (OTel)   |
| Node / anywhere, no tracing slot wired | _(unset)_                   | no           |

The `telemetry` slot (`createConsoleSink` / `createOTelSink` / custom) is
independent and only emits discrete-fact **events**, never phase spans — so
`createOTelSink` alone yields no phase spans; pair it with `createOTelTracing`.

### OpenTelemetry (Production)

OpenTelemetry plugs into BOTH observability slots, and they do different jobs:

- `tracing: createOTelTracing(tracer)` — the **phase spans** (the canonical span
  layer). Bridges the router's phases (request/middleware/action/loader/render/ssr)
  onto OTel's callback-bound `startActiveSpan`, so they nest by async context and
  a loader's own OTel spans (db/fetch) land under `rango.loader`. This is the
  OTel equivalent of `createCloudflareTracing`.
- `telemetry: createOTelSink(tracer)` — the **discrete-fact** instant spans
  (handler errors, cache decisions, revalidation decisions, timeouts, origin
  rejections). It does NOT emit request/loader phase spans — those belong to the
  tracing slot above — so running both does not double up.

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
  tracing: createOTelTracing(tracer), // phase spans (callback-bound)
  telemetry: createOTelSink(tracer), // discrete-fact instant spans
});
```

Both adapters are structurally typed against the `@opentelemetry/api` `Tracer`
interface, so any compatible tracer works without version coupling. Faithful
nesting from `createOTelTracing` requires an OTel async context manager
(`AsyncLocalStorageContextManager`) in your OTel setup — standard for any
`startActiveSpan`-based instrumentation.

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
cryptographically random, server-owned `requestId`. The same `Request` keeps one
ID across logging, telemetry, and development diagnostics. Inbound
`x-rsc-router-request-id`, `x-request-id`, and `cf-ray` values are untrusted
correlation hints: development diagnostics retain the first present, bounded
value separately as `clientCorrelationId`; it never replaces `requestId`.
Ordinary development responses expose the same server-owned value through
`X-Rango-Request-Id` for browser/framework correlation. The header is absent in
production and is added after cache capture or retrieval.

| Event                     | Lifecycle                                             |
| ------------------------- | ----------------------------------------------------- |
| `request.start`           | Emitted when a request enters the router              |
| `request.end`             | Emitted when a request completes successfully         |
| `request.error`           | Emitted when a request fails with an unhandled error  |
| `loader.start`            | Emitted when a loader begins execution                |
| `loader.end`              | Emitted when a loader completes (success or failure)  |
| `loader.error`            | Emitted when a loader throws an error                 |
| `handler.error`           | Emitted on handler or segment render failure          |
| `cache.decision`          | Emitted when a cache lookup result is determined      |
| `revalidation.decision`   | Emitted when a segment revalidation decision is made  |
| `request.timeout`         | Emitted when a configured phase deadline elapses      |
| `request.origin-rejected` | Emitted when the cross-origin guard rejects a request |

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
  status: 302,  // optional — present only when a Response ended the transaction
                // (a thrown-Response short-circuit, or dispatch()'s final
                // response); absent for a normal render completion
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

A thrown `Response` from middleware — a redirect or auth gate short-circuit —
is completed control flow, not a failure. It emits `request.end` with
`segmentCount: 0` (the same completed-request event the non-thrown redirect
path emits) and `status` set to the thrown Response's status (e.g. `302`), never
`request.error`, so auth redirects do not inflate error counts. `request.error`
fires only for a genuine unhandled error. A normal render completion omits
`status` (the Response is built after `match()`), so a sink can split 3xx
short-circuits from 2xx completions on the field's presence.

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
  segments: [                       // optional (CacheSegmentSignal[])
    { id: "blog:post", type: "route", cacheStatus: "hit", shouldRevalidate: false },
  ],
}
```

`segments` is present only when telemetry (or the dev-only `X-Rango-Cache`
debug header) is enabled. In v1 the pipeline tracks cache decisions at the
route/entry level, not per individual segment, so the array carries a single
coarse route-level entry keyed by the route key — a `CacheSegmentSignal` whose
`cacheStatus` (`CacheSegmentStatus`) is one of `"hit"`, `"miss"`, `"stale"`,
`"prerendered"`, or `"passthrough"`. The shape is forward-compatible with
genuine per-segment status if the pipeline later exposes it.

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

### Request Timeout Events

Emitted when a configured phase deadline elapses (see `RouterTimeouts`). The
`phase` is the `TimeoutPhase` whose budget was exceeded (`"action"`,
`"render-start"`, or `"stream-idle"`). `customHandler` reflects whether an
`onTimeout` handler was configured — `false` means the router served the
default timeout response. A render-start timeout may also include `render`, a
frozen snapshot of the foreground Flight/HTML/response operation. It is absent
when the deadline fired before the response-construction driver started (for
example, in a slow route handler) or on a response route.

```typescript
{
  type: "request.timeout",
  phase: "stream-idle",   // TimeoutPhase: "action" | "render-start" | "stream-idle"
  pathname: "/blog/hello",
  routeKey: "blog:post",  // optional
  actionId: "submit",     // optional (present for action-phase timeouts)
  durationMs: 5000,
  customHandler: false,   // whether onTimeout was configured
  render: {               // optional; render-start timeouts only
    mode: "full",
    phase: "html",
    state: "running",
    completed: 1,
    total: 3,
    phaseDurationMs: 4200,
  },
}
```

The same `RenderTimeoutContext` snapshot is passed to `onTimeout` as
`context.render` and to `onError` as `context.metadata.render` — each surface
receives its own copy, so a callback that mutates its copy (for example a
redacting logger) cannot corrupt what the other surfaces observe. Values are
identical across the three, so a timeout can be correlated across all support
surfaces without reconstructing progress from timestamps.

### Origin-Rejected Events

Emitted when the cross-origin guard rejects a state-changing request before it
runs. The `phase` is the `OriginCheckPhase` the request was classified as
(`"action"`, `"loader"`, or `"pe-form"`). `origin` and `host` are the compared
header values (either may be `null` when the header is absent).

```typescript
{
  type: "request.origin-rejected",
  method: "POST",
  pathname: "/api/submit",
  phase: "action",        // OriginCheckPhase: "action" | "loader" | "pe-form"
  origin: "https://evil.example",  // or null when absent
  host: "myapp.example",           // or null when absent
}
```

## OTel Span Mapping

The `createOTelSink` adapter maps the router's **discrete-fact events** to
**instant** OpenTelemetry spans (one span per fact):

| Span Name                       | Key Attributes                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `rango.handler.error`           | `rango.segment_id`, `rango.segment_type`, `rango.route_key`, `rango.handled_by_boundary` (error status) |
| `rango.cache.decision`          | `rango.cache.hit`, `rango.cache.should_revalidate`, `rango.cache.source`                                |
| `rango.revalidation.decision`   | `rango.segment_id`, `http.route`, `rango.route_key`, `rango.revalidate`                                 |
| `rango.request.timeout`         | `rango.phase`, `http.route`, `rango.duration_ms`, `rango.timeout.custom_handler` (error status)         |
| `rango.request.origin-rejected` | `http.method`, `http.route`, `rango.phase`, `rango.origin` (error status)                               |

The **phase** spans — `rango.request`, `rango.middleware`, `rango.action`,
`rango.loader`, `rango.handler`, `rango.render`, `rango.ssr` — are NOT produced by the sink. They are duration
spans owned by the `tracing` slot (`createOTelTracing` / `createCloudflareTracing`),
which wraps the actual work via the callback boundary so they nest by async
context. `createOTelSink` therefore ignores the `request.start/end/error` and
`loader.start/end/error` phase events — emitting them here would duplicate the
tracing-slot spans. This is the one-owner-per-surface rule (see _Cloudflare
custom spans_ below).

### Error Recording

Error spans (`rango.handler.error`, `rango.request.timeout`,
`rango.request.origin-rejected`) call `span.recordException(error)` where an
error object is present and set `SpanStatusCode.ERROR` with a message.

## Cloudflare Workers Example

On Cloudflare, prefer `createCloudflareTracing()` for phase spans (it bridges
onto the platform's native span API). Use OTel when you export to an
OTel-compatible backend instead. Either way, the phase spans come from the
`tracing` slot; `createOTelSink` only adds the discrete-fact spans:

```typescript
import {
  createRouter,
  createOTelTracing,
  createOTelSink,
} from "@rangojs/router";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("my-app", "1.0.0");

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  tracing: createOTelTracing(tracer), // phase spans (request/loader/render/…)
  telemetry: createOTelSink(tracer), // discrete-fact spans (errors, cache, …)
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.fetch(request, { env, ctx });
  },
};
```

## Cloudflare custom spans (`createCloudflareTracing`)

On Cloudflare, you can emit the router's performance phases as **native
Cloudflare custom spans** instead of (or alongside) the OTel sink. These show
up in the Workers trace waterfall and OpenTelemetry exports next to the
platform's automatic spans (KV reads, D1 queries, fetch calls).

```typescript
import { createRouter } from "@rangojs/router";
import { createCloudflareTracing } from "@rangojs/router/cloudflare";

export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  // All phases on by default; turn individual phases off as needed.
  tracing: createCloudflareTracing({ spans: { ssr: false } }),
});
```

Emitted spans: `rango.request`, `rango.middleware`, `rango.action`,
`rango.loader`, `rango.handler`, `rango.render`, `rango.ssr`. Unlike the OTel sink (which builds spans from
lifecycle _events_ after the fact), `createCloudflareTracing` **wraps the actual
work** with `executionContext.tracing.enterSpan`, so spans nest by async context
and the platform's automatic KV/D1/fetch spans land under the right phase.

<a id="one-instrumentation-model"></a>

### One instrumentation model

These spans and the `debugPerformance` perf timeline above are **one model, not
two**. Every router phase is wrapped exactly once by the internal
`observePhase()` primitive (`src/router/instrument.ts`), which from a single
wrap site opens the span AND — unless the phase meters its own perf metric —
records the perf metric, reading the metrics store and tracing config off the
request context. So the span set is always a subset of the perf phases and the
two surfaces cannot drift (e.g. a fetchable `_rsc_loader` request appears in
both, not one).

Three phases pass `metric: false` to `observePhase` — their perf metric is
recorded elsewhere, not as a single combined metric from the wrap site (still
one owner per surface):

- `rango.request` — `handler:total` is the grand total incl. the pre-context
  bootstrap timings.
- `rango.middleware` — the metric is the middleware's exclusive `:pre`/`:post`
  own-time (before/after `next()`); the span is the inclusive onion.
- `rango.handler` — the `handler:{id}` metric is owned by the call-site `track()`
  (the span is added separately by `observeHandler`), so this phase is span-only
  here; see the metric table above for when a static hit records it.

Discrete facts (cache decisions, handler errors, timeouts, …) are the **other**
surface — `observeEvent()` → the `TelemetrySink`. Spans drive; events are
emitted alongside. Events are never the parent abstraction: a callback-bound
span's async-context nesting cannot be reconstructed from after-the-fact
start/end events.

Loaders are metered at the `ctx.use` execution funnel via `observePhase`. Both
`ctx.use` implementations — the render-pipeline executor (`useLoader`) and the
base request-context one (`createUseFunction`) — plus the fetchable
`_rsc_loader` path, go through `observePhase`, and memoization makes each loader
execute once, so DSL render-time, handler-invoked, and loader-to-loader loaders
are each measured exactly once. A **loader-cache HIT emits no loader phase** —
the loader did not execute (the hit is a LoaderCache debug log; it produces no
loader-level telemetry event — `cache.decision` events come from the route /
segment match pipeline, keyed by route, not loader).

Key properties:

- **Import-free.** It reads `executionContext.tracing` lazily — no
  `cloudflare:workers` import and no `@cloudflare/workers-types` dependency.
- **Transparent off-Cloudflare.** With no `executionContext.tracing` (Node, dev
  without a tracing destination, an older runtime), every span call falls
  through to the work directly, so the request behaves exactly as if tracing
  were off. Whether spans are _recorded_ is governed by the `observability` /
  tracing block in your wrangler config.
- **Best-effort, never buffers.** Instrumentation never wraps or buffers the
  response body, so it cannot regress streaming or response latency. The streaming
  spans (`rango.request`/`render`/`ssr`) end at stream **construction** (the same
  boundary as their co-emitted perf metric), not when the body drains. A child
  that resolves mid-stream therefore keeps a span that can extend **past** its
  render parent — both a `rango.loader` and a `rango.handler` for a route that
  declares `loading()` (its handler promise settles during the stream). Overlapping
  spans are valid; the child really did take that long. Trace consumers that
  enforce strict end-nesting should expect this.
- **Full phase coverage.** Intercept-route middleware emits `rango.middleware`,
  and action-revalidation renders emit `rango.render`, so an action
  revalidation's loaders nest under a `rango.render` parent like a normal
  navigation.

Relationship to `createOTelSink`: the OTel _sink_ is the event surface and emits
only discrete-fact instant spans; the phase spans (`rango.request`/`loader`/…)
come from the `tracing` slot (`createOTelTracing` or `createCloudflareTracing`).
There is no overlap, so you can run a tracing adapter and `createOTelSink`
together without duplicate phase spans.

## Vercel custom spans (`createVercelTracing`)

On Vercel, tracing is OpenTelemetry — there is no native import-free span API
like Cloudflare's. `createVercelTracing()` is a thin convenience over
`createOTelTracing` that reads the global OTel tracer
[`@vercel/otel`](https://www.npmjs.com/package/@vercel/otel)'s `registerOTel()`
installs, so the router's phases show up in Vercel's trace waterfall.

```typescript
// instrumentation.ts — installs the global OTel provider, then builds the
// tracing config off it. Export the config so importing this module is what
// runs registerOTel(): a Rango/Vite app does NOT auto-load `instrumentation.ts`
// the way Next.js does, so a standalone registerOTel() that nothing imports is a
// silent no-op (the tracer stays unregistered and every span is dropped).
import { registerOTel } from "@vercel/otel";
import { createVercelTracing } from "@rangojs/router/vercel";

registerOTel({ serviceName: "my-app" });

// All phases on by default; turn individual phases off as needed.
export const tracing = createVercelTracing({ spans: { ssr: false } });
```

```typescript
// router.tsx — importing `tracing` runs instrumentation.ts (and registerOTel).
import { createRouter } from "@rangojs/router";
import { tracing } from "./instrumentation.js";

export const router = createRouter({ document: Document, tracing });
```

Emitted spans are the same set as everywhere else: `rango.request`,
`rango.middleware`, `rango.action`, `rango.loader`, `rango.handler`,
`rango.render`, `rango.ssr`. Options: `enabled`, per-phase `spans`, an
OTel-instrumentation-scope `tracerName` (default `"rango"`), and a `tracer`
override (defaults to the global `trace.getTracer(tracerName)`).

Platform caveats, all inherited from Vercel / OpenTelemetry (not the router):

- **Node.js runtime only.** Vercel custom spans are unsupported on the Edge
  runtime — a span created there silently produces nothing. `startActiveSpan`
  nesting also needs an `AsyncLocalStorageContextManager`, which `@vercel/otel`
  configures on Node. Keep tracing on Node-runtime functions.
- **`registerOTel()` must run before the first request** (the `instrumentation`
  module convention). Reading the tracer via `trace.getTracer` is safe even if
  it runs first — the API's proxy tracer delegates to the provider once
  registered — but with no provider every span is a transparent no-op, exactly
  as if tracing were off.
- **`@vercel/otel` is what unlocks Vercel's Session Tracing + Trace Drains.** A
  hand-rolled OpenTelemetry `NodeSDK` produces valid OTLP but forfeits both;
  `createVercelTracing` is built to ride on `registerOTel`.
- **Self-contained function bundling.** The `preset: "vercel"` deploy bundles
  the server (rsc/ssr) with `noExternal`, so `@vercel/otel` and its
  `@opentelemetry/*` peers must be installed (they go into the bundle, not
  `node_modules`). `@vercel/otel` is bundle-friendly (zero runtime deps, fetch
  instrumentation rather than `require-in-the-middle`). OTel bundling failures
  surface at **runtime** (cold-start), not build time — verify the deployed
  function, not just `vite build`.

A worked hybrid setup (real `@vercel/otel` plus an in-memory recorder for the
e2e) lives in `examples/vercel-basic`. Like `createCloudflareTracing`, these
spans and the `debugPerformance` perf timeline are
[one instrumentation model](#one-instrumentation-model), and `createVercelTracing`
composes with `createOTelSink` without duplicate phase spans.

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
// Event-sink factories (telemetry slot) + OTel phase-span adapter (tracing slot)
import {
  createConsoleSink,
  createOTelSink,
  createOTelTracing,
} from "@rangojs/router";

// Types
import type {
  TelemetrySink,
  TelemetryEvent,
  OTelTracer,
  OTelActiveSpanTracer,
  OTelTracingOptions,
  OTelSpan,
  RequestStartEvent,
  RequestEndEvent,
  RequestErrorEvent,
  LoaderStartEvent,
  LoaderEndEvent,
  LoaderErrorEvent,
  HandlerErrorEvent,
  CacheSegmentStatus,
  CacheSegmentSignal,
  CacheDecisionEvent,
  RevalidationDecisionEvent,
  RequestTimeoutEvent,
  OriginCheckRejectedEvent,
} from "@rangojs/router";
```
