---
name: observability
description: Debug Rango request performance with debugPerformance, Server-Timing, structured telemetry, and tracing. Use when a request feels slow and you need to see where time is spent, or wiring up tracing/telemetry for production requests.
argument-hint:
---

# Observability

Use this when you need to understand request latency, cache decisions,
revalidation behavior, loader overlap, or production traces.

Rango exposes three complementary observability surfaces:

1. **Performance timeline** (`debugPerformance`) — per-request waterfall for
   local or targeted debugging. It prints to the console and emits
   `Server-Timing`.
2. **Structured telemetry** (`telemetry`) — discrete lifecycle events sent to a
   pluggable sink for production monitoring, OpenTelemetry, or custom metrics.
3. **Tracing** (`tracing`) — the same phases as the timeline, emitted as spans
   into OpenTelemetry, Cloudflare Workers, or Vercel traces.

All three are off by default. The essentials are below. The exported `TelemetryEvent` union type
(`import type { TelemetryEvent } from "@rangojs/router"`) is the full event
contract — every event kind and its fields are typed there.

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

Or enable for selected requests from middleware (route `middleware()` inside
`urls()`, or `router.use()` for every request):

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
- `render:total:<routeName>` (or `render:total` for unnamed routes) and
  `ssr:render-html` show the render pass.
- `loader:<id>` rows should overlap render work. If a loader starts only after
  the render bar, it is serialized latency.
- Route matching (`match:*`), middleware (`middleware:<name>:pre` / `:post`),
  actions (`action:<id>`), cache, RSC serialization, and SSR setup appear as
  separate rows, so the slow phase is visible without guessing.

### Reading a PPR shell HIT

A `ppr` route serving from its shell cache commits the response as soon as the
stored prelude is read, so its waterfall ends at `ppr:shell-commit`; what runs
after the commit (the capture snapshot, the seeded tail, the resumed holes)
prints as one `shell tail` line when it finishes, and rides the NEXT request's
`Server-Timing` as `ppr-tail`. The store-read rows under `ppr:shell-read` come
from `CFCacheStore`'s prelude-first read; other stores show `ppr:shell-read`,
`ppr:shell-open`, and `ppr:shell-commit` only. From `vite preview` of
`tests/cloudflare-basic` `/ppr-large/holes` (614 KB prelude, 1.0 MB capture
snapshot), with the timeline column dropped:

```
[RSC Perf] GET /ppr-large/holes (4.00ms)
 start     dur  span
1.00ms  0.00ms      middleware:*#2
1.00ms  3.00ms    ppr:shell-read (hit l1)
1.00ms  1.00ms      ppr:shell-match (l1)
1.00ms  3.00ms    render:total:pprLargeHoles
2.00ms  0.00ms      ppr:shell-head (bytes=27943)
2.00ms  2.00ms      ppr:shell-prelude (bytes=628949)
2.00ms  0.00ms      ppr:shell-marker (tags=0 parallel commit-wait=0.00ms)
4.00ms  0.00ms    ppr:shell-open (cpu raw prelude=628949b)
4.00ms  0.00ms    ppr:shell-commit (cpu chunks=20 prelude=628949b)
0.00ms  4.00ms    handler:total
```

and, when the tail finishes, one console line (wrapped here):

```
[RSC Perf] GET /ppr-large/holes shell tail: complete snapshot=4ms
snapshot-read=2ms snapshot-bytes=1019145b snapshot-parse-cpu=2ms
records=segment:1 pruned=item:5 seed=4ms seed-cpu=0ms match=4ms handover=4ms
first-html=5ms complete=55ms prelude=628949b tail=1033762b
```

- `ppr:shell-match` then `head` then `prelude`: the store read. Only the head
  and the prelude are read before the first byte; the snapshot is read off the
  commit path (`snapshot=` in the tail line). A KV hit after a Cache API miss
  starts with a `ppr:shell-l1-miss` row (the L1 attempt and why it missed).
- `ppr:shell-marker` is the tag-marker check, on every `CFCacheStore` read; it
  runs alongside `ppr:shell-prelude`, and `commit-wait` is how much it held the
  commit back (with `tags=0` it resolves at once).
- `records=` counts the snapshot records the tail was seeded with, by
  family; `pruned=` counts the ones the capture dropped because no reader of
  the entry consumes them. Here every HIT tail replays the handler layer from
  the one segment record, so the five `"use cache"` item records that produced
  it were not stored.
- `snapshot=`, `seed=`, `match=`, `first-html=` are offsets from the commit,
  not durations; `snapshot-read=`, `snapshot-parse-cpu=` and `seed-cpu=` are
  durations.
- On a deployed worker the clock only moves on I/O, so the CPU-only numbers
  (`ppr:shell-open`, `ppr:shell-commit`, `snapshot-parse-cpu`, `seed-cpu`)
  read 0 there; the byte counts are the cost to watch.

The console waterfall uses these labels as written. In the `Server-Timing`
header, colons become hyphens and other non-alphanumeric characters are
dropped (`ssr:render-html` → `ssr-render-html`, `handler:total` →
`handler-total`), and nested rows get a `d<depth>-` prefix. The full metric
list is in the repository's `packages/rangojs-router/docs/telemetry.md`.

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
`@opentelemetry/api` dependency. It reads the tracer from the `ctx` your Worker
passes to `router.fetch(request, { env, ctx })`, and is a pass-through when
Workers tracing is not enabled for the Worker:

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
`rango.handler`, `rango.render`, `rango.ssr`, `rango.response`,
`rango.background`. All share the `PHASES` registry and `observePhase`
execution boundary with `debugPerformance`; phases with `metric: false` either
use finer-grained perf rows or, for `response` and `background`, remain
span-only. Off-platform (no Cloudflare tracing destination / no OTel SDK) every
span call is a transparent pass-through, so the request behaves as if tracing
were off.

`rango.response` is the explicit handoff marker: at most one per traced
request, a direct child of `rango.request`, wrapping only response finalization
(redirect interception/guarding, `Server-Timing` mutation, final response
selection) and ending immediately before the handler returns the response to
the host. It is handoff-bound, never drain-bound — it never reads or awaits
`response.body`. Attributes: `http.response.status_code`,
`rango.response.mode` (classified request mode, or `middleware-short-circuit`),
`rango.response.body_kind` (`stream`/`empty`/`websocket`). For request modes
that render nothing (fetchable `_rsc_loader`, response routes, middleware
short-circuits) it shows the trace is complete rather than truncated — those
requests legitimately have no `rango.render`/`rango.ssr`/`rango.handler` spans.
On deployed Workers it may read 0 ms (frozen non-I/O timers); its position and
attributes are the value. Disable per-response billing overhead at volume with
`spans: { response: false }`.

`rango.background` wraps detached waitUntil work — PPR shell captures and SWR
background revalidations — that runs after the foreground spans ended. Without
it, a capture or revalidation shows up as an unexplained wave of orphan
KV/fetch spans minutes into a trace. `rango.background.kind` names the lane
(`shell-capture` / `document-revalidation` / `loader-revalidation` /
`use-cache-revalidation`); the shell-capture lane also carries
`rango.shell_key`, `rango.background.outcome`, and
`rango.background.queue_wait_ms` (a capture parked behind the per-isolate
capture queue reads as span duration, not dead air). Toggle with
`spans: { background: false }`.

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

## Zero-overhead defaults

`debugPerformance` is off by default, `telemetry` emits nothing unless a sink
is configured, and with `tracing` unset every span call runs the work directly.
Per-request `ctx.debugPerformance()` lets you turn on the waterfall only for the
route, user, or query param you are investigating.
