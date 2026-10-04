# Render Stage Driver

The render pipeline already uses a generator, but it does not yet get the main
benefit of one: the caller cannot see what is about to run, pause there, and let
one owner execute and observe the work. Flight construction happens before the
current generator yields; HTML construction happens outside it; response
finalization happens after it resumes. The generator describes checkpoints, not
the work between them.

This design turns the foreground, post-payload render path into a synchronous
typed plan and gives one async driver ownership of its effects. That is a useful
boundary because the driver can always answer two support questions without
guessing: "what is running now?" and "which operation threw?" It also removes the
manual `next()` choreography that each render variant currently has to repeat.

This is not a proposal to turn every request activity into a generator. Matching,
middleware, loaders, parallel segment work, stream draining, and PPR shell work
have different concurrency or lifetime rules. Pulling those into a sequential
plan would make the code look uniform while making its behavior worse.

## Implementation status

The foreground migration is implemented in `src/rsc/render-pipeline.ts`. Normal
full/partial rendering, action revalidation and error rendering, progressive
enhancement success/error rendering, and not-found rendering all use
`renderRscResponse`. The previous async-generator choreography and its fake
payload stage have been removed from `rsc/helpers.ts`.

The request-level orchestration ABOVE this design's payload boundary has since
become a plan of its own: `requestRenderPlan` in `src/rsc/rsc-rendering.ts`,
executed by the generic routine runner — see
[routine-plans.md](./routine-plans.md). That layer delegates to this driver
unchanged and bridges its stage events into the flow trace; everything below
the payload boundary remains as specified here.

PPR shell capture/resume and the synchronous redirect-interception callback keep
the low-level direct Flight constructor. That is deliberate: PPR work runs after
the response commit, while redirect interception must return a `Response`
synchronously. Neither path would gain truthful lifecycle ownership from the
async driver today.

## The boundary

The plan starts once a render path has produced its payload or control response.
Payload creation remains ordinary code because it includes matching, segment
resolution, handler execution, and loader scheduling. The payload is an input or
a caller-visible checkpoint, not an operation the driver pretends to own.

The migration covers every standard foreground response path after that point:

| Path                                               | Planned foreground operations                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Full document                                      | Flight construction -> HTML construction -> response finalization              |
| Partial/navigation                                 | Flight construction -> response finalization                                   |
| Action revalidation, success or error boundary     | Flight construction -> response finalization                                   |
| Progressive enhancement, success or error boundary | Flight construction -> HTML construction -> response finalization              |
| Not found                                          | Flight construction -> optional HTML construction -> 404 response finalization |
| Redirect Flight/control response                   | Direct synchronous Flight construction + response finalization                 |

A PPR miss may use the same foreground document plan for the response served to
the user. The shell capture scheduled after that response does not join the plan.
A shell hit, resume tail, or build-time shell capture also keeps its dedicated
protocol. Those operations have storage and background-lifetime rules described
in [PPR shell caching and resume](./ppr-shell-resume.md); treating them as ordinary
foreground stages would blur the response commit boundary.

The following work stays outside:

- route matching and lazy include discovery;
- middleware onion execution;
- segment resolution, handlers, loaders, and parallel routes;
- SSR module setup, which intentionally overlaps route matching;
- reading, teeing, buffering, cloning, or draining a Flight or HTML stream;
- PPR shell capture, resume tails, and other `waitUntil` work.

The existing matching generator remains a matching protocol. Its yields carry
resolved data between middleware layers; they are not render lifecycle effects,
so sharing a generator syntax is not enough reason to merge the designs.

## What is wrong with the current staging

Before this migration, `src/rsc/helpers.ts` exposed `createRscRenderStages`, but
the important boundaries were distributed across helpers and callers:

- `renderRscFlightStage` constructed the Flight stream before
  `createRscFlightStages` yielded it. A debugger or stage sink saw "yield" only
  after the operation has succeeded, which is too late to identify a stuck or
  throwing constructor.
- `observeRscHtmlStage` lived outside the generator. Normal rendering,
  progressive enhancement, and the not-found path must each pair it manually
  with the right Flight stream and then resume the generator with the HTML body.
- response construction happened inside the generator after resumption, so the
  caller cannot inspect the operation before it executes.
- normal rendering, action rendering, progressive enhancement, not-found, and
  shell capture used different subsets of the helpers. A new diagnostic or
  invariant must therefore be wired into several shapes and is easy to miss.
- the old stage context was eager enough to add clocks and objects even when
  no stage sink consumes them. It does not share `observePhase`'s direct-call
  fast path.
- the async generator added asynchronous `next()` boundaries even though plan
  construction itself has no asynchronous work. Whether that cost matters must
  be measured, but it buys no useful scheduling behavior today.

The result is a pipeline that looks resumable without having one execution owner.
It is harder to support than either a plain function or a real effect plan.

## Protocol

The plan is a synchronous `Generator`. It yields an operation descriptor _before_
that operation runs. The async driver is the only code that invokes the
descriptor and resumes the plan with its result. The implemented shape uses a
tagged result so a phase cannot accidentally consume another phase's value:

```ts
type RenderCommand =
  | { type: "flight"; execute(): RscFlightStage }
  | {
      type: "html";
      prepare(): RscPreparedHtmlRender | Promise<RscPreparedHtmlRender>;
    }
  | { type: "response"; execute(): Response };

type RenderCommandResult =
  | { type: "flight"; value: RscFlightStage }
  | { type: "html"; value: RscHtmlResult }
  | { type: "response"; value: Response };

type RenderPlan = Generator<
  RenderCommand,
  Response | undefined,
  RenderCommandResult
>;
```

A document plan reads linearly: obtain the Flight stream, obtain the HTML stream
from it, finalize the response. A partial plan omits HTML. The tagged handshake
is checked at the generator boundary before a value is used.

The driver follows one rule for each effect:

1. Mark the cursor as running that phase.
2. Invoke `execute` inside the phase's real observation callback.
3. On success, mark the phase complete and resume with the exact returned value.
4. On failure, record that phase and throw the exact value back into the plan.

Throwing into the plan matters. It lets an explicitly designed plan branch from a
failed operation to an error response while leaving ordinary unhandled failures
unchanged. If the plan does not catch the value, the driver rethrows the same
object. The driver does not wrap errors, translate thrown `Response` objects, or
reconstruct them from status and headers.

A thrown `Response` is still a `Response`, with the same identity. A returned
`Response` is also returned unchanged unless an existing semantic operation
already creates a replacement (for example, the existing merged-header response
finalizer). The migration must not introduce a clone merely to make the protocol
uniform.

### Payload is not fake work

No production caller needed to pause and replace the payload/init pair, so the
implemented plan takes them as input and starts with Flight. Progress counts
completed operations, not values that happened to cross a function boundary.

### Driver invariants

These rules are load-bearing:

- An effect is yielded before `execute` is called.
- `execute` is called exactly once.
- The value passed back to the plan is the exact value returned by `execute`.
- A rejection or throw is passed to `plan.throw` unchanged.
- The driver never reads or transforms a response body or stream.
- Construction completes the effect. Stream completion does not.
- Plan code only orchestrates effects. User code and asynchronous work live in
  `execute`, where instrumentation can own the real callback boundary.
- A plan is request-local. There is no module-global "current stage."

## Cursor and diagnostics

The driver may maintain a request-local foreground cursor when a consumer exists:

```ts
interface RenderCursor {
  mode: RenderMode;
  phase: RenderPhase;
  state: "paused" | "running";
  completed: number;
  total: number;
  pipelineStartedAt: number;
  phaseStartedAt?: number;
  routeKey?: string;
  actionId?: string;
}
```

This is a snapshot of foreground construction, not a claim about the whole
request. A loader can still be running after response construction, and a stream
can fail after its constructor returns. Those activities must not overwrite the
foreground cursor.

If support needs visibility into concurrent work, add a separate gated activity
registry later. Entries such as `loader`, `handler`, `ssr-setup`, `shell-capture`,
and `ppr-tail` can overlap and therefore cannot truthfully be represented as the
next yield of one sequential generator.

The cursor is allocated only when something will read it: stage debugging,
tracing attributes, timeout diagnostics, or another explicitly enabled sink.
With every surface disabled, the driver keeps the minimum loop state and does not
create event contexts or call the clock for diagnostics.

## Observability ownership

The driver owns callback placement; it does not replace the router's existing
observability primitives. `observePhase` in `src/router/instrument.ts` remains the
single owner of paired `debugPerformance` metrics and tracing spans.

The operation mapping is deliberately conservative:

| Operation             | Existing observation retained                                                    |
| --------------------- | -------------------------------------------------------------------------------- |
| Flight construction   | `rsc-serialize` metric when the request metrics store is active                  |
| HTML construction     | `observePhase(PHASES.ssr, execute)`, producing `ssr:render-html` and `rango.ssr` |
| Response finalization | Cursor/stage diagnostics only; no new span by default                            |
| Whole plan            | Existing `observePhase(PHASES.render, ...)` parent                               |

The driver owns these callback placements. It must not emit start and end events
and later try to reconstruct spans from them. Cloudflare tracing and
OpenTelemetry both need the actual callback boundary so nested database, fetch,
and React work lands under the correct active span. A dependency with its own
lifetime stays outside that callback: for example, the HTML effect can await the
early SSR setup promise, then open `PHASES.ssr` only around `renderHTML`, preserving
the current metric and span meaning.

The migration does not add `rango.flight`, `rango.response`, or a second HTML
span by default. The existing `rango.render` and `rango.ssr` hierarchy is
low-cardinality and sufficient. The render parent may receive low-cardinality
attributes such as `rango.render.mode`, `rango.render.phase`, and
`rango.render.error_phase`; route and action identifiers remain attributes, not
span names.

Routine stage start/end records also do not become production telemetry events.
That would multiply event volume for every render without adding a discrete
business fact. A diagnostic sink may receive them when enabled.

`debugPerformance` keeps its current construction-bound meaning. Flight timing
ends when React returns the Flight stream. HTML timing ends when the SSR API
returns its stream. Neither row waits for body delivery.

## Streaming is a hard boundary

A `ReadableStream` is a result, not unfinished generator work. Once an effect
returns one, the driver immediately resumes the plan. It never calls
`getReader()`, `tee()`, `arrayBuffer()`, `clone()`, or `allReady`, and it never
adds a transform solely for timing.

That distinction preserves time to first byte and backpressure. It also keeps
error ownership accurate:

- a synchronous throw or rejected constructor promise is a render-effect error;
- an RSC serialization error reported later through React's `onError` remains a
  rendering error reported through `callOnError`;
- an error while the host drains the response body is a stream/host error, not a
  stage-driver error.

Calling all three "the Flight stage failed" would be easier to log and less
useful to debug.

## Migration sequence

The end state is one driver for all standard foreground post-payload paths, but
the implementation should land in behavior-preserving slices.

1. **Characterize the current behavior.** Pin ordering, statuses, headers,
   content types, thrown-value identity, and stream non-consumption for full,
   partial, action, progressive-enhancement, not-found, and redirect responses.
   Capture an observability-off and observability-on benchmark baseline.
2. **Introduce the typed protocol and driver.** Test it independently, including
   yield-before-execute, pause/resume, exact result/error identity, plan-level
   recovery through `throw`, and the disabled fast path. Keep compatibility
   adapters for existing helpers while call sites move.
3. **Move Flight-only foreground paths.** Migrate partial navigation and action
   revalidation success/error first. They exercise Flight and response effects
   without SSR setup or HTML variables.
4. **Move document paths.** Migrate normal full rendering, then progressive
   enhancement success/error. Keep early SSR setup outside and pass its resolved
   promise into the plan; the HTML effect awaits/reuses it and wraps only
   `renderHTML` with `PHASES.ssr`.
5. **Close standard bypasses.** Move not-found Flight/HTML responses onto the
   same response ownership. Keep redirect Flight interception direct while its
   callback contract is synchronous; do not manufacture an async plan that its
   caller cannot drive truthfully.
6. **Wire support diagnostics.** Once every foreground path reports truthful
   phases, expose the gated cursor to timeout and `onError` metadata and add
   render-span attributes. Until then, a partial cursor would overstate
   coverage.
7. **Remove the old choreography.** Delete `readRscFlightStage`,
   `finishRscRenderStages`, and standalone stage wrappers only after searches
   show that standard foreground paths no longer bypass the driver. Keep
   purpose-built PPR helpers separate.
8. **Re-evaluate the matching generator separately.** Change it only if a
   dedicated profile and simplification case exists. Completion of this design
   is not evidence that matching should use the same driver.

Each slice keeps response bytes and request semantics stable. If a slice needs a
semantic change to become convenient, the convenience loses; propose that change
separately and update the semantic matrix contract explicitly.

## Acceptance gates

The migration is complete only when correctness, support value, and cost are all
demonstrated.

### Correctness

- Unit tests prove an effect is observable before execution, executes once, and
  resumes with the same object.
- Unit tests prove exact identity for `Error`, non-`Error` thrown values, and
  thrown or returned `Response` objects.
- A guarded stream records zero reads, tees, clones, and buffers while the driver
  constructs the response.
- Existing `rsc-serialize`, `ssr:render-html`, `rango.render`, and `rango.ssr`
  boundaries retain their construction semantics and do not duplicate.
- Full, partial, action success/error, progressive-enhancement success/error,
  not-found, and redirect contracts are covered in both development and
  production e2e suites where consumer behavior is involved.
- `semantic-matrix.test.ts` stays green. This migration does not intentionally
  change middleware scope, handler ordering, context visibility, or JS/PE parity.
- PPR shell hit/miss/capture/resume tests prove the foreground migration did not
  pull background work under the driver or delay response delivery.

Regression tests for a discovered bug are demonstrated red without the fix and
green with it. Tests written only to mirror the new implementation shape are not
enough.

### Diagnostics

- A frozen Flight or HTML constructor reports the running phase rather than the
  last completed checkpoint.
- A thrown constructor reports the exact error phase and original object.
- Timeout and `onError` snapshots distinguish foreground phase from concurrent
  activities; absence of a cursor is represented as absence, not `unknown` work.
- Stage diagnostics are absent on paths intentionally outside the driver instead
  of claiming misleading progress.

### Performance

Benchmark partial Flight, full HTML, and action revalidation with observability
off and on. Run enough warm iterations and independent samples to report medians,
not a single favorable run.

The observability-off gate is no statistically meaningful regression in end-to-
end construction throughput or latency. A repeatable median regression above 3%
in any core path stops the migration until explained or removed. Also compare the
driver/protocol in isolation so React rendering noise cannot hide extra promise
hops or allocations.

The disabled-path probe must show no diagnostic context allocation and no
diagnostic `performance.now()` calls. Existing clocks required by an enabled
metrics store are not counted as driver overhead. Observability-on results are
reported rather than assumed to improve; the architectural win there is exact
callback ownership and error attribution. Any claimed speedup must come with the
benchmark output and reproduction command.

The implementation includes a repeatable isolated benchmark at
`src/rsc/__tests__/render-pipeline.bench.ts` (`pnpm --filter @rangojs/router exec
vitest bench --run src/rsc/__tests__/render-pipeline.bench.ts`). An initial run on
a busy development machine put both new paths ahead of the removed choreography,
but those numbers are diagnostic only, not a merge claim. Rerun independent
medians on an idle machine, including observation-on and a real action
revalidation sample, before publishing a percentage. Direct hand-written
baselines remain useful context; the relevant comparison is the orchestration
being replaced, because the driver now also owns attribution and diagnostics.

These gates are what make the generator worthwhile. If the final code merely
rephrases function calls as yields, adds overhead, or still needs every caller to
manage its own HTML and response steps, it has not completed this design.
