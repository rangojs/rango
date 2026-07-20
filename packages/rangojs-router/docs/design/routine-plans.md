# Routine plans: the request-level render orchestration

If you have ever tried to answer "what was this request doing when it hung?" or
just wanted to read `handleRscRenderingInner` top to bottom, you know why this
exists. The function was ~465 lines of correct but opaque orchestration: PPR
shell serving, two matching paths, payload assembly, rendering, and background
capture handoffs, all interleaved with their own bookkeeping. The order was
real, but nothing made it visible — not to a reader, and not to diagnostics.

Routine plans make the order the artifact. Every standard render orchestration
is now a synchronous generator that emits each unit of work as data before it
runs, executed by one interpreter (`driveRoutinePlan` in
`src/rsc/routine-plan.ts`): `requestRenderPlan` in `src/rsc/rsc-rendering.ts`
(navigation documents and partials), `actionRevalidationPlan` in
`src/rsc/server-action.ts` (post-action revalidation, success and deferred
error boundary), and `peRenderPlan` / `peErrorBoundaryPlan` in
`src/rsc/progressive-enhancement.ts` (no-JS re-render and error boundary). The
code you read and the execution you observe are projections of the same
instruction sequence, so they cannot drift apart.

This extends the render stage driver
([render-stage-driver.md](./render-stage-driver.md)) one level up. That design
deliberately scoped itself to the post-payload foreground (Flight -> HTML ->
response); this one owns the request spine above it and delegates to the render
driver unchanged. Its invariants are inherited wholesale: a command is yielded
before its work runs, `execute` runs exactly once, results and errors resume
the plan with exact identity, and a plan-level `try/catch` around a step is the
recovery mechanism.

## The vocabulary

Three effect shapes plus composition, all in `src/rsc/routine-plan.ts`:

| Primitive             | Contract                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `run(name, fn)`       | Sequential effect; the plan suspends until its result.                                                          |
| `start(name, fn)`     | Fork: completes at invocation, returns the promise as a handle a later step may join. Settlement is background. |
| `schedule(name, fn)`  | Background handoff: scheduling completes the effect; a rejection marks the trace, never fails the plan.         |
| `subplan(name, plan)` | Nested plan as a named scope; `yield*` flattens it into one instruction stream.                                 |

Settlement tracking follows the returned value. A scheduler that
fires-and-forgets internally (`scheduleShellCapture` via `runBackground`)
returns void, so its trace entry settles at the handoff — deliberately: the
plan's contract ends there, and pretending otherwise would require threading
capture-internal promises out of `shell-capture.ts` for a debug display.

## What stays plan code and what must be an effect

Plan bodies are orchestration: branching, data flow between steps, recovery.
Async work and anything a trace should attribute always goes through a step.
Two sync exceptions are deliberate and small: stamping the shell MISS status
header on the response, and `attachLocationStateIfPresent` on the payload —
both single-line response/payload bookkeeping whose failure modes are the
plan's own.

The boundaries the render-stage design drew still hold. The middleware onion
wraps downstream execution and cannot be a flat yield sequence — it stays one
opaque `match:*` effect (`ctx.router.match` and `matchPartialWithPprReplay`
own their internals, including the matching generator's own protocol). Loader
and segment parallelism stay inside their effects. Redirect Flight interception
keeps its synchronous callback contract and never joins an async plan. Plans
compose by level, not by absorption.

## The flow trace

`INTERNAL_RANGO_DEBUG=1` (the existing internal debug surface —
`vite/inject-client-debug.ts` bakes the flag at build/dev-server start, so
ordinary production builds fold the whole branch away) prints one tree per
request. The header names the path: `(document)`, `(partial)`,
`(action-revalidation)`, or `(pe)` — a PE request shares one trace across its
error-boundary and re-render plans, so it still prints a single tree:

```
[routine] GET / (document)
plan shell-serve 0.0ms
plan prepare:full 2.8ms
  run match 2.7ms
run render 420.1ms
  run flight 0.3ms
  run html 418.8ms
  run response 0.5ms
```

Nothing declares this; it is the interpreter's program counter. A failed step
prints `FAILED` on the exact instruction in hand, and `trace.active()` answers
"what is running now" for timeouts. The render step's children come from
`createRenderStageTraceBridge` in `rsc-rendering.ts`, which feeds the render
stage driver's existing `tracking.onEvent` stream into the trace as depth+1
entries — no new machinery inside the render driver.

## Costs, stated plainly

This is not a simplification. The change is net +~900 lines (+330 machinery,
+325 tests/bench, +235 reorganization), `rsc-rendering.ts` grew, and
contributors must learn the plan/effect discipline. A plain-function
decomposition with the same outcome unions would have delivered most of the
readability for less. What plain functions cannot deliver is the derived
tracking — truthful per-step attribution with zero per-step instrumentation —
which is the reason this design exists. The layer earns its keep by becoming
the diagnostics substrate, not by existing once.

Overhead is measured, not assumed (`src/rsc/__tests__/routine-plan.bench.ts`,
dev-machine diagnostic numbers): a six-effect spine costs ~0.14us as direct
awaits, ~0.88us through the driver with tracing off, ~1.18us with tracing on.
Per request that is roughly 0.7us against paths measured in milliseconds —
three orders of magnitude under the repo's 3% regression gate. The
render-pipeline bench keeps Flight-only ahead of the removed legacy
choreography; the Flight+HTML microbench read ~6% behind legacy on one busy-
machine run at 1.8us vs 1.7us means — rerun idle medians before publishing a
percentage.

## Verification record (2026-07-20)

Behavior preservation was pinned by running, on the converted tree: the full
router unit suite (5599), `semantic-matrix` plus all six router PPR suites
(222 in the combined shared-server run), cloudflare-basic's four PPR suites
(417), and — after the action/PE conversions — `semantic-matrix` again with
the progressive-enhancement suite and all nine action suites (139 in that
combined run). Protocol invariants (yield-before-execute, exact identity,
recovery, fork non-blocking, schedule isolation, subplan flattening,
error-unwind-through-scope) are unit-pinned in
`src/rsc/__tests__/routine-plan.test.ts`.

## Not built yet, on purpose

- **observePhase ownership stays where it was.** The render driver wraps HTML
  in `PHASES.ssr`; match effects carry their own instrumentation. The generic
  interpreter does not open spans. If a step ever needs one, the command
  gains an `observe` spec and the driver executes inside the callback — do not
  reconstruct spans from trace events.
- **No abort/cleanup discipline.** `driveRoutinePlan` has no `plan.return`
  early-exit path; the render driver's cleanup rules are the template when a
  caller needs one.
- **Action-execution preludes stay plain code.** `executeServerAction` and the
  PE detection/execution section are error-as-data control flow (thrown
  redirects short-circuit, failures become `returnValue`); forcing them into
  step form would make the code look uniform while hiding that. Only the
  render orchestrations are plans.
- **The 404 recovery render in `handler.ts` stays a direct effect.** It is a
  single `renderRscResponse` call inside an error-recovery catch — a one-step
  plan would be ceremony, and the failure that led there is already attributed
  by the request plan's trace.
- **The trace is internal-only.** `INTERNAL_RANGO_DEBUG` is not public API;
  promoting the flow view to a supported surface is a separate decision.
