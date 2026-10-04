# Routine plans: the request-level render orchestration

If you have ever tried to answer "what was this request doing when it hung?" or
just wanted to read `handleRscRenderingInner` top to bottom, you know why this
exists. The function was ~465 lines of correct but opaque orchestration: PPR
shell serving, two matching paths, payload assembly, rendering, and background
capture handoffs, all interleaved with their own bookkeeping. The order was
real, but nothing made it visible — not to a reader, and not to diagnostics.

Routine plans make the order the artifact. Every standard render orchestration
is now a synchronous generator that emits each unit of work as data before it
runs, executed by one runner (`runRoutine` in
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

Two effect shapes plus composition, all in `src/rsc/routine-plan.ts`:

| Primitive           | Contract                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step(name, fn)`    | Sequential work; the plan suspends until its result.                                                                                                     |
| `handoff(name, fn)` | Background registration. A synchronous registration failure fails the step; a returned promise settles in the background without failing the foreground. |
| `scope(name, plan)` | Nested plan as a named scope; `yield*` flattens it into one instruction stream.                                                                          |

The names are deliberately plain. A request plan should read as a high-level
program: enter the shell scope, prepare the route, render, hand off capture. The
helpers use `yield*` rather than raw `yield` because TypeScript can then preserve
the result type of each individual step instead of widening every resumed value
to one command-result union.

Plans return completed values, never promises. `runRoutine` rejects a thenable
return so asynchronous work cannot outlive the active trace invisibly; put that
work in a named `step` instead.

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
ordinary production builds fold trace collection and output away) prints one tree per
request. The header names the path: `(document)`, `(partial)`,
`(action-revalidation)`, or `(pe)` — a PE request shares one trace across its
error-boundary and re-render plans, so it still prints a single tree:

```
[routine] GET / (document)
scope shell-serve 0.0ms
scope prepare:full 2.8ms
  step match 2.7ms
step render 420.1ms
  step flight 0.3ms
  step html 418.8ms
  step response 0.5ms
```

Nothing declares this; it is the runner's program counter. A failed step prints
`FAILED` on the exact instruction in hand. While `runRoutine` is suspended, it
publishes the trace on the request context. A render-start timeout therefore logs
the live stack immediately and includes a bounded snapshot in internal-debug
`onError` metadata, for example `prepare:full > match` or `render > html`; it does
not wait for the hung promise to settle. The render step's children come from
`createRenderStageTraceBridge` in `render-pipeline.ts`, which feeds the render
stage driver's existing `tracking.onEvent` stream into the trace as depth+1
entries — no new machinery inside the render driver.

Scope outcome belongs to the scope, not the first failed child. If a scope catches
a step failure and completes its fallback, the scope is `done`. If the error
escapes, every scope it crosses is `failed` with the same error identity and a
terminal timestamp. This is why the exit command carries its outcome explicitly.

## Costs, stated plainly

This is not a simplification. The change adds a runner, protocol tests, trace
integration coverage, and substantial render-path reorganization;
`rsc-rendering.ts` grew, and
contributors must learn the plan/effect discipline. A plain-function
decomposition with the same outcome unions would have delivered most of the
readability for less. What plain functions cannot deliver is the derived
tracking — truthful per-step attribution with zero per-step instrumentation —
which is the reason this design exists. The layer earns its keep by becoming
the diagnostics substrate, not by existing once.

Overhead is measured, not assumed (`src/rsc/__tests__/routine-plan.bench.ts`,
dev-machine diagnostic numbers): one current run measured a six-effect spine at
~0.1us as direct awaits, ~0.9us through the runner with tracing off, and ~1.2us
with tracing on. Per request that is roughly 0.8us against paths measured in milliseconds —
three orders of magnitude under the repo's 3% regression gate. The
render-pipeline bench keeps Flight-only ahead of the removed legacy
choreography; the Flight+HTML microbench read ~6% behind legacy on one busy-
machine run at 1.8us vs 1.7us means — rerun idle medians before publishing a
percentage.

## Verification record (2026-07-21)

Behavior preservation was pinned by running, on the converted tree: the full
router unit suite (5604) plus the RSC suite (71), `semantic-matrix` in dev (25)
and production (28), the routine flow and timeout diagnostics e2e in both modes,
`semantic-matrix` plus all six router PPR suites
(222 in the combined shared-server run), cloudflare-basic's four PPR suites
(417), and — after the action/PE conversions — `semantic-matrix` again with
the progressive-enhancement suite and all nine action suites (139 in that
combined run). Protocol invariants (yield-before-execute, exact identity,
recovery, exact scope outcomes, synchronous handoff failure, asynchronous
handoff isolation, scope flattening, and error-unwind-through-scope) are
unit-pinned in
`src/rsc/__tests__/routine-plan.test.ts`.

## Not built yet, on purpose

- **observePhase ownership stays where it was.** The render driver wraps HTML
  in `PHASES.ssr`; match effects carry their own instrumentation. The generic
  interpreter does not open spans. If a step ever needs one, the command
  gains an `observe` spec and the driver executes inside the callback — do not
  reconstruct spans from trace events.
- **No abort/cleanup discipline.** `runRoutine` has no `plan.return`
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
