# Late-span retention on Cloudflare: what is proven, what is not

Status: partially field-confirmed. The `rango.response` handoff marker is
shipped (`src/router/instrument.ts` `PHASES.response`, wrapped at the tail of
the request span in `src/rsc/handler.ts`); this doc covers the question that
marker deliberately does NOT answer: **does Cloudflare retain Rango phase
spans that settle after `router.fetch()` returns?**

## Field evidence (2026-07-16, deployed hec worker)

A production trace of a canceled partial navigation settled two pieces:

- **Platform spans created ~24 s after handoff, inside shell-capture waitUntil
  work, ARE retained** in the same exported trace, parented by the async
  context captured at task creation — and they survive client cancellation
  (the root showed `outcome: canceled`; the capture still completed and its
  kv_put closed the invocation).
- The "~24 s of zero I/O" before the capture's spans was the per-isolate
  serialized capture queue (`src/rsc/capture-queue.ts`): a predecessor link
  can legitimately occupy the queue for two capture attempts (~15 s each,
  `SHELL_CAPTURE_MAX_WAIT_MS`) plus the 400 ms retry delay. The invocation's
  wall time closes when the LAST waitUntil settles, so a late capture stretches
  the recorded duration; the client-cancel moment is not in the trace at all.

Both findings motivated the `rango.background` span (`PHASES.background` in
`src/router/instrument.ts`): each detached lane is now wrapped at its execution
boundary, so post-handoff spans get an explanatory parent and queue parking
shows up as `rango.background.queue_wait_ms` instead of dead air.
Still unverified on a deployed worker: whether Rango's OWN construction-bound
spans that SETTLE mid-stream (population 1) keep their recorded duration in
the export, and the acceptance criteria below.

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
   the captured request context — and `_tracing` rides along in that context.
   Each lane is now wrapped in a `rango.background` span (kind attribute per
   lane), so these no longer appear as unexplained orphans:
   - `createDocumentCacheMiddleware` in `src/cache/document-cache.ts` re-runs
     the full downstream pipeline on a STALE document hit: fresh
     `rango.middleware` / `rango.render` / `rango.ssr` / `rango.loader` /
     `rango.handler` spans, all post-handoff. It cannot emit a second
     `rango.response` — the finalization tail is outside `next()`.
   - `executeLoaderData` in
     `src/router/segment-resolution/loader-cache.ts` re-executes a STALE loader
     under the captured context: one post-handoff `rango.loader` span plus
     whatever the loader fetches.
   - `registerCachedFunction` in `src/cache/cache-runtime.ts` re-runs a cached
     function under a derived context; the function's own fetch/KV operations
     get platform-automatic spans in the same event.
   - PPR shell capture's `deriveShellCaptureContext` deliberately suppresses
     inner phase spans, while `scheduleShellCapture` retains the outer
     `rango.background` wrapper. Keep that split.
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

## Shipped mitigations (2026-07-16)

Two of the risks this doc surfaced are now bounded in the router:

- `timeouts.streamIdleMs` is ENFORCED (rsc/stream-idle.ts, wired at the
  handler's response tail): a streamed body with no flow for the budget is
  errored and its source render canceled, so a never-settling embedded promise
  can no longer hold a connection open indefinitely. Opt-in, end-to-end idle
  semantics.
- The capture queue drops tasks that waited past
  `CAPTURE_QUEUE_WAIT_BUDGET_MS` (15s) unrun (`skip-queue-timeout`, no
  backoff), so a parked capture can no longer start an attempt the platform's
  post-response waitUntil budget cannot cover; queue parking is observable via
  `rango.background.queue_wait_ms`. Document-shell captures outrank queued
  navigation-only captures (without preempting the active task), so production
  viewport prefetch cannot consume a cold document's whole queue budget first.

## Cancellation policy (decided up front)

Do NOT blanket-register phase promises with `ctx.waitUntil()` and do not wrap
response streams to retain telemetry. Connected response streams already own
their dependent work; keeping canceled UI work alive changes cancellation
semantics and adds duration cost. Only if the deployed repro proves one
specific promise becomes detached and must survive cancellation, retain that
single promise with a targeted `waitUntil(promise.then(noop, noop))` and test
the cost and behavior explicitly.
