# Late-span retention on Cloudflare: what is proven, what is not

Status: open investigation. The `rango.response` handoff marker is shipped
(`src/router/instrument.ts` `PHASES.response`, wrapped at the tail of the
request span in `src/rsc/handler.ts`); this doc covers the question that
marker deliberately does NOT answer: **does Cloudflare retain Rango phase
spans that settle after `router.fetch()` returns?**

## Why you cannot answer this locally

The Cloudflare e2e recorder (`tests/cloudflare-basic/src/trace-debug.ts`)
proves span creation, attributes, and parentage only. It serializes the tree
right after `router.fetch()` resolves and intentionally does not model span
settlement, Cloudflare ingestion, or trace-lifecycle behavior. A
`rango.loader` span that settles while the body streams is still OPEN at
serialize time on real Cloudflare; whether the platform keeps it in the
exported trace is a property of workerd + the tracing pipeline, not of our
runner. Local Node/miniflare also preserve async context in places where edge
workerd does not (scar tissue: the use-cache revalidation ALS bug was
edge-only), so a local pass proves nothing here. Only a deployed worker with a
real tracing destination can settle this.

## The span populations at risk

Three distinct populations settle after handoff; do not conflate them when
reading a trace:

1. **Pre-handoff spans that settle mid-stream.** A `rango.loader` /
   `rango.handler` for a route with `loading()`: the span is ENTERED before
   the response returns (so the recorder sees it), but its callback settles
   while the body streams. This is the population the acceptance criteria
   below target first.
2. **Post-handoff spans from SWR background revalidation.** These are entered
   AFTER `router.fetch()` returned, inside `waitUntil` work that re-establishes
   the captured request context — and `_tracing` rides along in that context:
   - `src/cache/document-cache.ts:387` — a STALE document hit re-runs the full
     downstream pipeline (`runWithRequestContext(requestCtx, () => next())`)
     in `waitUntil`: fresh `rango.middleware` / `rango.render` / `rango.ssr` /
     `rango.loader` / `rango.handler` spans, all post-handoff. It cannot emit
     a second `rango.response` — the finalization tail is outside `next()`.
   - `src/router/segment-resolution/loader-cache.ts:331` — a STALE loader hit
     re-executes the loader under the captured context (`wrapBackground`):
     one post-handoff `rango.loader` span plus whatever the loader fetches.
   - `src/cache/cache-runtime.ts:467` — "use cache" background revalidation
     re-runs the cached fn under a derived context; the fn's own fetch/KV
     operations get platform-automatic spans in the same event.
   - Deliberate exception: PPR shell capture strips tracing
     (`src/rsc/shell-capture.ts:1341` sets `derivedCtx._tracing = undefined`),
     so captures never emit phase spans. Keep it that way.
3. **Detached work after client cancellation.** The client disconnects after
   the first chunk; workerd cancels the stream. Whether dependent work (and
   its spans) survives is a product question, not a telemetry one — see the
   cancellation policy at the end.

## Deployed reproduction protocol

Deploy a worker with `tracing: createCloudflareTracing()` and a wrangler
tracing/observability destination. The route shape that already exists and
matches the requirements is `/ppr-shell` in `tests/cloudflare-basic`
(loader-carried promise behind `loading()`, ~400ms delay, shell flushes
first — verified streaming in `tests/cloudflare-basic/e2e/trace-spans.test.ts`);
lift it or reproduce the shape in the target app:

1. A full HTML route with `loading()` and an uncached delayed loader.
2. Inside the loader, after the delay, perform an automatically traced
   operation (a real `fetch()` or KV/D1 read) so the platform creates a child
   span under `rango.loader` — that child is the retention witness.
3. Tag each request with a unique token in a QUERY param (`?probe=<uuid>`), so
   the trace is findable without putting high-cardinality values in the path —
   `url.path` is a span attribute and must stay aggregatable.
4. `curl -N` (or a reader script): confirm the first chunk arrives before the
   loader settles (timestamps), then drain fully.
5. Wait until the Cloudflare dashboard no longer reports "Trace in Progress"
   (documented transient state), then export the trace.
6. Repeat with client cancellation after the first chunk (`curl -N` + SIGINT,
   or an AbortController after the first read).
7. Repeat against a STALE document-cache hit and a STALE loader-cache hit to
   observe population 2: do the background revalidation's spans land in the
   SAME trace (parented under `rango.request`), a separate trace, or nowhere?

## Acceptance (normal drain)

- `rango.response` marks construction/handoff before body completion.
- The late-settling `rango.loader` remains in the final trace.
- Its delayed Cloudflare fetch/KV child span remains parented under it.
- Response status, headers, byte count, first-chunk timing, and TTFB are
  unchanged versus a tracing-disabled control request.

## Cancellation policy (decided up front)

Do NOT blanket-register phase promises with `ctx.waitUntil()` and do not wrap
response streams to retain telemetry. Connected response streams already own
their dependent work; keeping canceled UI work alive changes cancellation
semantics and adds duration cost. Only if the deployed repro proves one
specific promise becomes detached and must survive cancellation, retain that
single promise with a targeted `waitUntil(promise.then(noop, noop))` and test
the cost and behavior explicitly.
