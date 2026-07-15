# Rango MCP and agent skills

Status: **Phases 0-2 implemented; render explanation and workflow skills proposed**.

Rango already ships version-matched reference skills, route-manifest inspection,
structured telemetry, performance waterfalls, cache signals, PPR signals, and a
dev/production e2e harness. What it does not have is one machine-readable view of
a running request. An agent can prove what the browser rendered, or inspect one
log stream at a time, but it cannot ask the framework a simple question such as:

> Why did `/products/42` render this way?

Answering that requires route matching, segment `cache()` decisions, PPR shell
and navigation-replay decisions, loader execution and consumption lanes, and
revalidation decisions to be correlated under one request. This design adds that
framework-side view through a development-only Model Context Protocol (MCP)
server, then builds workflow skills on top of it.

The MCP reports facts. Skills turn those facts into a diagnosis, edit strategy,
and verification loop. Keeping that boundary strict lets the same diagnostics
later power a CLI or graphical devtools without teaching the runtime how to edit
an application.

## Current implementation boundary

Phase 0 deliberately establishes the transport and exposes only facts already
owned by Vite route discovery. The running development server provides
`get_project_metadata`, paginated `get_routes`, and `get_discovery_status`.
`rango mcp` is the stdio connector and discovers the server through an
owner-only descriptor under `~/.rango/mcp`.

Routes publish as an atomic generation after successful discovery. A route-file
event marks the previous generation stale before the HMR debounce starts, and a
failed attempt preserves that last-good generation. Attempt tokens prevent a
slower, older discovery from overwriting newer state. On Cloudflare,
`runtimeConvergence` separately reports `ready`, `pending`, or `timeout` for the
initial and HMR workerd route-generation probes; discovery success alone is not
presented as runtime convergence.

Route cursors bind to both the process instance and discovery generation. Pages
are bounded by count and encoded byte size, and both page-level and route-level
truncation are explicit. Router metadata includes routers with zero routes.
The project-metadata router list is capped at 32 entries and reports
`routersTruncated`; its URL list is capped at 16 entries and reports
`urlsTruncated`; `routerCount` remains the total discovered count. Every complete
MCP tool result, including its text and structured representations, is capped at
256 KiB using its actual UTF-8 serialization size.
Discovery error text is bounded, strips control characters, makes project paths
relative, and redacts credential-shaped and URL-query values before MCP output.

Phase 1 adds a development-only runtime diagnostic core. One server-owned
request ID now joins logging, telemetry, and bounded request traces; inbound
browser/proxy IDs remain separate client-correlation hints. Existing request
classification, phase/loader timing, coarse cache events, errors, revalidation
traces, and foreground render stages project into a fail-open in-memory hub even
when the application has no `TelemetrySink`. PPR shell-capture work is excluded
until it can receive a separate linked background trace.

Phase 2 bridges the realm-local runtime hub into Vite over the RSC environment's
custom hot channel. Node's module runner and Cloudflare's workerd runner use the
same versioned, bounded batch envelope. Vite validates and redacts each batch
again, deduplicates realm sequences, retains request receipt time on the host
clock, and never lets transport or ingestion failure affect a request.

The MCP now exposes bounded compilation issues, runtime errors, request summaries,
and exact request traces. Structured Vite transform errors are current until a
successful update for their file; Vite logger warnings are explicitly
`recent-only` because Vite has no stable current-warning registry. Detailed
scope-level cache/PPR decisions, loader consumption lanes, browser state, and logs
remain outside the implemented boundary.

## Goals

1. Give an agent a truthful, structured explanation of a running Rango request.
2. Join the three parts of Rango's render-cache model in one trace:
   segment `cache()`, the PPR shell, and the live loader data layer.
3. Make the ordinary edit-and-verify loop inspect both the framework and a real
   browser instead of treating a successful build as runtime proof.
4. Ship workflow skills that are version-matched with `@rangojs/router`, just as
   the existing reference skills are.
5. Keep diagnostics read-only, bounded, secret-safe, development-only, and out
   of production bundles.
6. Reuse existing instrumentation sites rather than creating a second execution
   model that can drift from the router.

## Non-goals

- The MCP does not control a browser. Skills use `agent-browser`, Playwright, or
  another browser driver and cross-check its view against Rango's view.
- The MCP does not edit source files, invalidate caches, submit actions, or replay
  requests. All MCP tools are observational.
- The MCP is not a production observability backend. `TelemetrySink`, tracing,
  and platform monitoring continue to own production diagnostics.
- This design does not merge `cache()` with `ppr`. They cache different
  artifacts and retain independent keys, policies, and decisions.
- This design does not fold `"use cache"`, document caching, or external CDN
  caching into the render-cache workflow. The MCP may report those layers when
  observed, but their adoption remains in their existing reference skills.
- The MCP never serializes loader return values, request bodies, cookies,
  authorization headers, environment bindings, or cached payloads.

## The model the MCP must preserve

The most important design constraint is that a cache hit is not shorthand for
"nothing ran". Rango has a live data layer that deliberately survives rendered
artifact reuse.

| Layer                | Primitive                  | Reused artifact                                              | What still runs or streams                                                |
| -------------------- | -------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Segment render cache | route-tree `cache()`       | serialized non-loader Flight segments and replayable handles | middleware, DSL loaders, HTML rendering                                   |
| PPR document shell   | route `ppr` option         | HTML prelude, postponed state, and eligible handler snapshot | middleware, eligible fresh loader lanes, resumed holes, hydration payload |
| Live data            | `loader()` + `useLoader()` | nothing by default                                           | loader resolves per request and streams through its boundary              |

These layers compose. A PPR route may sit inside an explicit `cache()` scope. The
explicit segment-cache tier keeps its own key, store, TTL, SWR, tags, condition,
and bypass semantics; PPR keeps its separate shell and navigation-replay
decision. The MCP must show both outcomes instead of collapsing them into a
single `cacheHit` boolean.

Loaders need equally precise language. "The loader ran" and "the user saw the
fresh value" are not always the same statement during shared-artifact capture:

- A DSL loader consumed with `useLoader()` is the normal **live lane**. Under a
  route `cache()` hit it runs fresh because loader segments are excluded from the
  segment cache.
- Under PPR, a DSL loader with renderable `loading()` is structurally live: it is
  masked during capture and resolves fresh behind the hole on every serve.
- Under PPR without renderable `loading()`, the loader executes during capture;
  its settled container is bake-lane shell material, while promises nested in
  that container remain live under the consumer's Suspense boundary.
- A handler calling `await ctx.use(loader)` consumes the loader in the **baked
  lane** for `cache()`, `"use cache"`, and PPR. The per-request execution may be
  memoized with a registered DSL loader, but the handler-rendered copy belongs to
  the shared artifact.
- `loader(Fn, () => [cache({...})])` opts the loader's data into its own cache.
  That is not the route-level render cache, but it changes the loader's freshness
  and therefore belongs in the request explanation.

One loader can have more than one consumer. Diagnostics must model one execution
and multiple consumption lanes rather than assigning one ambiguous `live` flag
to the loader.

## User-facing explanation

The primary MCP result is not a bag of low-level events. It is an explanation of
one request:

```text
GET /products/42 (document)
route: shop.product

middleware
  auth                         completed
  locale                       completed

render reuse
  cache() product-scope        HIT, runtime, fresh
  PPR document shell           HIT, runtime, fresh
  PPR navigation replay        not applicable

loaders
  ProductLoader                ran 18 ms
    DSL/useLoader consumer     live, visible this request
  PriceLoader                  ran 31 ms
    loading() boundary         live hole, visible this request
  BreadcrumbLoader             ran 4 ms
    handler ctx.use consumer   baked, capture-generation copy rendered

result
  shell committed after middleware
  handlers replayed
  two live loader regions resumed
```

The structured response underneath this rendering remains stable and is what
skills consume. Human formatting is a presentation layer, not the protocol.

## Architecture

```text
router and Vite instrumentation sites
                 |
                 v
       development diagnostic hub (Phase 1)
       - request-correlated events
       - bounded in-memory retention
       - redacted raw request traces
                 |
                 v
   bounded RSC hot-channel bridge (Phase 2)
   - Node module runner or Cloudflare workerd
   - versioned batches, duplicate rejection
   - second-pass validation and redaction
                 |
                 v
        Vite-hosted diagnostic hub
                 |
                 v
        Vite development endpoint
          /__rango/mcp
                 |
                 v
       MCP tools used by skills

browser driver ----------------------> browser DOM, console, network, React tree
```

### Diagnostic hub

The hub is the source of truth. MCP is one adapter over it.

It receives events from existing execution sites:

- route classification and manifest loading;
- middleware entry, exit, and short-circuit;
- segment-cache lookup/store and SWR decisions;
- PPR document-shell lookup, capture, commit, refusal, and healing;
- PPR partial-navigation replay and bounded bypass reasons;
- loader registration, execution, cache lookup, boundary/lane selection, and
  consumption;
- handler execution or replay;
- revalidation evaluation;
- foreground render stages and response completion;
- Vite compilation and HMR failures.

The public `TelemetrySink` remains optional and production-safe. The development
hub must not require an application to configure a sink. Event construction
should still happen at one instrumentation site: the runtime may project a
public telemetry event and a richer development event from the same local facts,
but two independently maintained emit paths are rejected.

`router/request-identity.ts` is the single request and transaction identity
service used by logging, telemetry, testing dispatch, and the diagnostic hub.
The server ID is cryptographically random. A bounded
`x-rsc-router-request-id`, `x-request-id`, or `cf-ray` value is retained only as
`clientCorrelationId`, never trusted as the trace identity.

### Vite endpoint and MCP transport

The Rango Vite plugin mounts `/__rango/mcp` before application routing. The
endpoint implements the MCP Streamable HTTP transport (including the methods the
transport requires) and is available only from the development server.

Requirements:

- It is never mounted by a production build or preview server.
- It accepts authenticated loopback requests only. Every method requires a
  random per-process bearer credential; requests with an `Origin` header and
  non-loopback socket peers are rejected. Host and forwarded headers are not an
  authentication boundary.
- Runtime descriptors accept only a literal `127.0.0.1` or `::1` endpoint at the
  exact reserved path. The connector uses a direct HTTP dispatcher, rejects
  redirects, and does not send the credential through environment-configured
  proxies.
- It lives in a reserved framework namespace and does not enter the Rango route
  trie, middleware, cache, PPR, or telemetry pipeline.
- Multiple routers are addressed by `routerId`; a tool rejects ambiguity rather
  than silently selecting the first router.
- Tool and diagnostic schemas carry independent integer versions. MCP protocol
  compatibility remains the SDK-negotiated MCP protocol version.
- A tool result has a bounded maximum size and reports truncation explicitly.

The `rango mcp` stdio proxy is the supported connector. It obtains the endpoint
and credential from an owner-only, non-symlink descriptor in an owner-only,
non-symlink directory, forwards the same tool calls, and contains no diagnostic
logic. Descriptors rotate with the dev process and stale process descriptors are
ignored.

### Browser correlation

Framework and browser views need a shared identifier. Every trace receives a
cryptographically random server-owned `traceId`. A bounded, validated
`x-rsc-router-request-id` may be retained separately as `clientCorrelationId`,
but it never replaces the server identity: browser counters restart, callers can
reuse values, and arbitrary header values are untrusted.

The initial document request cannot be stamped by client JavaScript. In
development, the outer response adapter echoes the server-owned ID as
`X-Rango-Request-Id` after cache capture or retrieval. It is never baked into a
document or PPR shell cache, and protocol-switch/WebSocket responses are exempt
when rewrapping would lose platform state. The response header and all
browser-side correlation code are absent from production builds.

When a driver cannot set a request header, tools support bounded lookup by
router, pathname, transport kind, and start time. That fallback must report
ambiguity. Selecting "the latest `/products/42`" without saying that three
prefetches matched is not acceptable evidence.

`navigationId` is separate from `requestId`: one browser navigation can adopt an
in-flight prefetch or trigger an action request followed by a revalidation
request. A completed-prefetch navigation may have no new HTTP request at all, so
its browser transaction refers to the adopted prefetch request ID. The first
implementation may leave `navigationId` absent until the browser runtime has a
stable navigation transaction identifier, but the schema reserves it.

## Diagnostic schema

Request-scoped events begin with:

```ts
interface DiagnosticEventBase {
  schemaVersion: 1;
  sequence: number;
  timestamp: number;
  requestId: string;
  transactionId: string;
  navigationId?: string;
  routerId: string;
  routeKey?: string;
  segmentId?: string;
  type: string;
}
```

Project diagnostics such as Vite compilation, discovery, and HMR failures use a
separate base without request, transaction, or router IDs. They can occur before
an application router exists and must not be forced into a fabricated request.
Background work that outlives a response uses its own trace linked through
`causedByTraceId`; it is not silently appended to a completed request.

`sequence` provides deterministic ordering when monotonic timestamps are equal.
`transactionId` distinguishes full matching, partial matching, actions,
progressive enhancement, and background capture work associated with one HTTP
request.

The hub projects events into a request trace:

```ts
interface RequestTrace {
  schemaVersion: 1;
  request: {
    requestId: string;
    transactionIds: string[];
    navigationId?: string;
    method: string;
    pathname: string;
    transport:
      | "document"
      | "navigation"
      | "prefetch"
      | "action"
      | "progressive-enhancement"
      | "loader-fetch"
      | "response-route";
  };
  match?: MatchExplanation;
  middleware: MiddlewareExplanation[];
  renderCache: RenderCacheExplanation;
  loaders: LoaderExplanation[];
  handlers: HandlerExplanation[];
  revalidation: RevalidationExplanation[];
  render: RenderExplanation;
  errors: DiagnosticError[];
  truncated: boolean;
}
```

The exact TypeScript declarations are implementation work, but the following
semantic requirements are fixed.

### Segment `cache()` explanation

Each evaluated scope reports:

- owning segment and route;
- whether the scope is explicit, inherited, implicit shell replay, or disabled;
- store kind, without serializing binding values;
- outcome: `hit`, `miss`, `stale`, `prerendered`, `bypass`, or `error`;
- bounded reason when bypassed or errored;
- runtime or prerender source;
- TTL/SWR policy and freshness when the store provides it;
- whether background revalidation was claimed;
- tag names only when they are static or already emitted as diagnostics;
- a digest of dynamic cache identity, never a raw key that may contain secrets.

The existing `cache.decision` event is coarse and route-level. It remains a
compatible public signal; the diagnostic hub adds genuine scope-level events at
the lookup site instead of pretending the current `segments` array has
per-segment precision.

### PPR explanation

PPR has two related but independent decisions:

1. **Document shell:** lookup, freshness, runtime/build producer, commit, capture
   scheduling, capture result, and healing.
2. **Partial-navigation replay:** hit freshness or one bounded bypass reason,
   whether an explicit `cache()` tier won first, and whether a navigation-only
   capture was scheduled.

The explanation preserves existing status vocabulary from `x-rango-shell` and
`x-rango-ppr-replay`; headers remain useful black-box assertions. MCP enriches
them with the request-correlated path that led to the status.

Capture refusals must name the class without exposing values: identity read,
dynamic opt-out, handler-live hole, pending handle, timeout, nonce, unsupported
store, corrupt entry, invalidated generation, or internal error.

### Loader explanation

Each loader reports identity, registration segment, execution timing, execution
source, and all consumers:

```ts
interface LoaderExplanation {
  loaderId: string;
  loaderName: string;
  registeredBy?: string;
  execution:
    | { outcome: "ran"; durationMs: number }
    | { outcome: "memoized"; fromLoaderId: string }
    | { outcome: "cached"; freshness: "fresh" | "stale" }
    | { outcome: "skipped"; reason: string }
    | { outcome: "error"; handledByBoundary: boolean };
  consumers: Array<{
    kind: "dsl-client" | "dsl-server" | "handler" | "loader-dependency";
    lane: "live" | "baked";
    boundary: "loading" | "consumer-suspense" | "none";
    containerValue: "request" | "capture-generation";
    nestedPromises: "none" | "request";
  }>;
}
```

The names may change during implementation; the distinctions may not. In
particular, the MCP must never infer liveness only from whether the loader body
executed. Container and nested-promise generations are independent because PPR
can retain a capture-generation container while resolving promise holes from the
current request.

### Revalidation explanation

The existing revalidation trace already records defaults, custom predicates,
final decisions, sources, and reasons. MCP exposes that structure directly and
adds action identity, whether the path changed, previous/next search-parameter
names, and whether the decision affected a handler segment or loader
registration. Raw URLs and search values remain private.

This keeps Rango's two freshness axes visible:

- render/data cache decisions answer **which stored value is fresh**;
- `revalidate()` decisions answer **which client-visible segments recompute**.

A stale-data skill must never recommend changing one axis based only on a signal
from the other.

## MCP tools

The first protocol should stay small. High-level tools are more stable than one
tool per internal event.

| Tool                     | Phase    | Returns                                                                                                                                              |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_project_metadata`   | shipped  | project root, package version, Vite mode, routers, dev-server URLs, capabilities and tool schema version                                             |
| `get_routes`             | shipped  | paginated runtime route maps, router source ownership, patterns, names, search schemas, trailing-slash behavior, generation and freshness            |
| `get_discovery_status`   | shipped  | route-discovery phase, attempts, generation, counts, freshness and the latest discovery error                                                        |
| `match_route`            | proposed | the route, params, layouts, parallels, intercept candidates, middleware, loaders, and cache/PPR declarations for a URL without executing handlers    |
| `get_compilation_issues` | shipped  | current structured Vite/RSC transform errors plus bounded recent-only logger warnings, with sanitized source locations and explicit capture coverage |
| `get_errors`             | shipped  | Rango request/runtime errors retained by the hub, filterable by request, router, or receipt time                                                     |
| `list_requests`          | shipped  | bounded request summaries with exact request-ID selection, route declaration ownership, opaque cursors, and bridge drop statistics                   |
| `get_request_trace`      | shipped  | the bounded structured trace and route declaration ownership for one exact server request ID                                                         |
| `explain_render`         | shipped  | concise projection joining `cache()`, PPR, handlers, and loader lanes for one request                                                                |
| `explain_revalidation`   | shipped  | segment/loader recomputation decisions for an action or navigation request                                                                           |

`match_route` is read-only discovery, not a dry-run render. It must not execute
middleware, handlers, loaders, cache stores, or user predicates with side
effects. If a decision depends on runtime context, the tool says `runtime` and
points the caller to an observed request trace.

Tools use opaque pagination cursors and bounded filters. They do not expose a
generic "evaluate code" escape hatch.

## Retention, redaction, and failure posture

The hub retains a ring bounded by request count, event count, age, and encoded
size. Exact defaults should be measured during implementation, but all four
bounds are required. A trace says which bound truncated it.

Collection follows these rules:

- Store route patterns and parameter names by default, not raw pathname parameter
  values. Where exact-value correlation is necessary, use a per-process keyed
  digest that cannot be compared across restarts.
- Store search-parameter names but redact values by default.
- Never store request or response bodies, cookie values, authorization headers,
  environment bindings, loader values, React payloads, cache payloads, or raw
  form data.
- Serialize errors as independently bounded and sanitized name, message, stack,
  phase, and project-relative source location. Redact URL query values and
  credential-like values before insertion into the hub; output escaping alone is
  not redaction.
- Do not store raw dynamic cache keys. Store their owning scope and a one-way
  digest when correlation is necessary.
- Treat application-provided labels, route names, tags, and error messages as
  untrusted data, not agent instructions. Results preserve provenance and skills
  never interpolate those values into commands or edit instructions.

Diagnostics are best-effort and fail open. A hub allocation, projection, or MCP
serialization failure must not alter routing, rendering, caching, or response
timing beyond the development-only observation cost. The hub reports its own
dropped-event counter so missing evidence is visible.

## Skills built on the MCP

Rango's current skills remain the API references. The new skills are workflows:
they inspect a running app, make a scoped change, and prove the result.

### `/dev-loop`

This is the base workflow used after an application edit.

Preflight:

1. Confirm compatible Rango, Vite, React, MCP schema, and browser-driver
   versions.
2. Connect to the running Vite server and list routers/routes.
3. Open the target URL in a worktree-scoped browser session.

Verification loop:

1. Ask `get_compilation_issues` before driving stale output.
2. Perform the intended document load, navigation, prefetch, or action.
3. Capture the browser-visible result, console, network, and React/Suspense state.
4. Select the exact request by the shared request ID.
5. Read `explain_render`, `get_errors`, and, for mutations,
   `explain_revalidation`.
6. Cross-check the two views. A clean framework trace does not prove the DOM is
   correct; a correct DOM does not prove loaders stayed live or a cache tier
   behaved as intended.
7. Run the relevant production build/e2e check before declaring the change done.

The skill refuses to replace browser verification with `curl` for interactive
behavior. It also refuses to call a request "verified" when trace selection was
ambiguous.

### `/render-cache-adoption`

This workflow owns the integration of route-tree `cache()`, PPR, and loaders.
It does not absorb the broader cache API reference.

The decision starts with the artifact the consumer wants to reuse:

```text
Reuse expensive non-loader Flight segments       -> cache()
Flush a reusable HTML shell before live regions  -> ppr
Need both                                        -> cache() + ppr
Keep request data live                           -> DSL loader + useLoader()
Guarantee a PPR live hole                        -> loader + renderable loading()
Cache only one loader's data                     -> loader(... cache())
```

Route-by-route loop:

1. Record an uncached baseline: route match, handler/loader timings, first byte,
   shell behavior, and browser result.
2. Classify every data read as middleware control, handler render material,
   DSL-loader live data, handler-consumed baked data, or nested-promise data.
3. Choose `cache()`, `ppr`, or both from the required artifact, not from API-name
   familiarity.
4. Configure a shell-capable store when PPR is selected.
5. Move per-request or per-user render data to a DSL loader consumed through the
   live lane. Add renderable `loading()` when the hole must stay live even if the
   loader resolves quickly.
6. Warm the route and use `explain_render` to prove the selected tier hit and the
   intended loaders remained request-visible.
7. Exercise invalidation and SWR. Use `explain_revalidation` separately when an
   action should also recompute selected client segments.
8. Verify document load, soft navigation, action revalidation, and progressive
   enhancement where the route supports them.
9. Add paired dev and production e2e coverage.

The skill treats these findings as blockers:

- request identity baked into a shared handler artifact;
- a handler `ctx.use(loader)` assumed to be live because the loader also ran;
- a PPR shell hit without proof that middleware guarded the request;
- an explicit `cache()` bypass silently served by PPR replay;
- a claimed optimization with no cache hit, no visible shell improvement, and no
  measured server-work reduction.

### `/render-cache-optimizer`

This skill starts only after the route's semantics are correct. It has two loops:

- **Initial document:** reduce time to useful shell and avoid unnecessary
  handler/Flight work on warmed requests.
- **Soft navigation:** reuse eligible handler material while preserving loader
  freshness, loading behavior, intercept selection, and revalidation semantics.

Each optimization captures a browser and MCP baseline, changes one boundary, and
captures the same evidence afterward. A passing build is necessary but not the
success criterion. The result must show at least one intended delta: an actual
segment/shell hit, less handler work, a smaller or earlier useful shell, reduced
server timing, or elimination of a loading flash without freezing data.

### `/stale-data-debugger`

This workflow begins with evidence, not a cache API guess:

1. Did the loader execute, and which consumer lane supplied the visible value?
2. Did a segment, loader-data, or PPR lookup hit a fresh/stale generation?
3. Was the relevant tag invalidated, and did the store observe it?
4. Did `revalidate()` select the visible segment after the mutation?
5. Did the browser reuse a prefetched/history value under the current Rango
   state?

It then recommends one axis-specific fix: move data to a live loader, adjust a
`cache()` policy, add/fix tag invalidation, change a `revalidate()` predicate, or
invalidate the client cache. It never presents those operations as synonyms.

## Skill packaging

Workflow skills live beside the existing references under `skills/` and are
included in the generated `skills/catalog.json`. They link to `/rango`,
`/caching`, `/ppr`, `/loader`, `/observability`, and `/testing` rather than
copying those API references.

Every workflow skill follows the same document shape:

1. `requires`
2. `preflight`
3. scope selection
4. diagnostic loop
5. edit rules
6. browser verification
7. dev and production verification
8. bailout conditions
9. teardown
10. reference links

Descriptions name user intents and failure symptoms so agents load the workflow
only when it can act. The broad `/rango` skill remains the mental model and
catalog; there is no new catch-all "best practices" skill.

## Production boundary

The MCP endpoint is deliberately absent in production. Workflow skills prove
production behavior through the existing black-box surfaces:

- `pnpm build` and the target preview server;
- `createRangoE2E().parityDescribe()` for paired dev/build suites;
- `x-rango-shell`, `x-rango-ppr-replay`, and gated `X-Rango-Cache` assertions;
- browser-visible behavior and progressive-enhancement parity;
- production bundle analysis when Vite/plugin output changes.

An e2e test for the MCP itself therefore has a pair: development proves the
tools and request correlation work; production proves `/__rango/mcp` is absent
and no diagnostic client/runtime code leaked into the output.

## Implementation phases

### Phase 0: MCP transport and route discovery (implemented)

- Mount the token-protected, loopback-only Streamable HTTP endpoint from the Vite
  development plugin.
- Register the runtime through an owner-only descriptor and proxy it through
  `rango mcp` over stdio.
- Implement project metadata, paginated runtime routes, and discovery status.
- Preserve last-good snapshots with attempt/process-bound cursors, explicit
  truncation, redacted errors, and Cloudflare workerd-convergence status.
- Prove the endpoint is absent from production and never enters application
  middleware or route manifests.

Exit criterion: an MCP client can inspect truthful runtime route state in both
Node and Cloudflare development, while paired production tests receive no MCP
response.

### Phase 1: correlation and diagnostic core (implemented)

- Unify request and transaction identity across logging, telemetry, debug
  signals, and the new hub.
- Add the bounded, redacting diagnostic hub behind a compile-time development
  gate.
- Project current request, loader, error, cache, and revalidation events into
  traces without changing the public telemetry event vocabulary or sink
  delivery. Telemetry `requestId` values become server-owned; inbound IDs remain
  separate, bounded client correlation.
- Add dropped-event and truncation reporting.

Exit criterion: one full request and one partial request can be retrieved by
request ID with route, loader timing, coarse cache state, revalidation, and
errors inside the runtime realm. Cross-realm MCP retrieval remains Phase 2.

### Phase 2: MCP and Vite integration (implemented)

- Add the explicit bounded ingestion bridge from Node module-runner realms and
  Cloudflare workerd into the Vite-hosted hub.
- Implement compilation, error, request-list, and trace tools over retained hub
  state.
- Add structural source ownership through a dev-only side table; do not execute
  user handlers or lazy include providers from inspection tools.

The bridge uses `import.meta.hot.send()` from the development-only RSC bootstrap.
Both supported server runners already transport that custom event to Vite, so the
implementation does not add a Cloudflare-only side channel. Runtime queues and
batches have independent count and encoded-byte bounds; the Vite host applies the
same limits again, tracks duplicate/rejected batches, and uses host receipt time
for retention so workerd and Vite monotonic clocks are never compared.

Route declaration ownership comes from the existing static include-tree parser
and is committed with the last-good discovery generation. Statically resolvable
named routes point to their declaration module; factory-only and otherwise
unresolvable routes fall back truthfully to the router module. The side table
never enters the runtime route manifest or a production application bundle.

Exit criterion: an MCP client can select a request generated by a browser and
cross-check its route and errors without reading terminal logs.

### Phase 3: render explanation

- Add scope-level segment `cache()` decisions.
- Add PPR document, capture, and navigation-replay events.
- Add loader registration, data-cache, consumption-lane, and visible-generation
  events.
- Implement `explain_render` and `explain_revalidation`.

Exit criterion: the MCP distinguishes an explicit segment-cache hit, a PPR shell
hit, a live DSL loader, a bake-lane loader consumer, and a loader-data cache hit
in one composed route.

### Phase 4: workflow skills

- Ship `/dev-loop` first; it is the proving client for the protocol.
- Ship `/render-cache-adoption` once render explanations are complete.
- Add `/render-cache-optimizer` and `/stale-data-debugger` after the adoption
  workflow has exercised the schemas against real apps.

Exit criterion: each skill has a fixture task that fails without the intended
diagnosis or edit and passes in both dev and production verification.

## Verification matrix

| Contract                                     | Unit/integration                    | Dev e2e                                | Production e2e                       |
| -------------------------------------------- | ----------------------------------- | -------------------------------------- | ------------------------------------ |
| request IDs correlate all events             | hub and identity tests              | browser request selects one trace      | black-box request behavior unchanged |
| MCP tools are read-only and bounded          | schema, pagination, redaction tests | tools return live project/request data | endpoint absent                      |
| `cache()` and PPR remain independent         | explanation projection tests        | composed route reports both decisions  | headers and browser output agree     |
| DSL loaders remain the live data layer       | lane/execution tests                | warmed route shows fresh loader region | same fresh region after build        |
| handler loader consumption is reported baked | lane projection test                | capture-generation copy identified     | same semantics after build           |
| revalidation stays a separate axis           | trace projection tests              | action shows selected/skipped segments | same action/PE behavior after build  |
| diagnostics cannot break requests            | throwing hub/serializer tests       | injected diagnostic failure fails open | no diagnostic code active            |

Changes under the Vite plugin also run the route-types HMR test and build the
router before local dev verification. Changes to segment resolution or PPR
rendering run the semantic matrix. The implementation must update the internal
feature maps when source ownership is established.

## Rejected alternatives

### Build the skills before framework diagnostics

A browser-only `/dev-loop` can prove visible behavior, but render-cache skills
would fall back to log scraping and temporary application telemetry sinks. That
is too ambiguous for decisions about baked versus live data. The base skill may
be drafted early, but it is not complete until it consumes request-correlated
framework facts.

### Put diagnostic logic in the MCP adapter

This makes MCP the only usable client and couples event collection to a transport
lifecycle. The diagnostic hub owns facts and projections; MCP only validates
arguments and serializes results.

### One `cacheHit` field

A route can simultaneously have an explicit `cache()` miss, a PPR shell hit, a
loader-data cache hit, and a fresh DSL loader. One boolean destroys the exact
information the adoption and stale-data workflows need.

### Infer loader liveness from execution

Handler consumption can bake a loader-derived value into a shared artifact even
when the loader body executed. PPR can also execute a loader during capture while
only nested promises remain live. Consumption lane and visible generation must
be recorded explicitly.

### Expose an MCP cache-invalidation tool

Mutation would make diagnostics alter the behavior they are trying to explain
and creates a dangerous capability around shared stores. Skills exercise
invalidation through application code and ordinary browser actions, then observe
the result.

### Enable MCP in production behind a flag

Production has different trust, retention, and availability requirements. The
existing telemetry/tracing APIs are the supported production surface. Keeping
MCP dev-only makes absence testable and prevents a debug flag from becoming an
accidental remote introspection service.

## Open questions

1. What count, age, and byte limits preserve enough concurrent loader/PPR detail
   without making large applications expensive? Measure before fixing defaults.
2. Can every supported browser driver inject `x-rsc-router-request-id` into
   document and framework fetches, or should the browser runtime expose a
   development-only navigation ID hook?
3. Should background shell capture have its own root trace linked by
   `causedByRequestId`, or remain a child transaction of the triggering request?
   The answer must preserve captures that outlive request completion.
