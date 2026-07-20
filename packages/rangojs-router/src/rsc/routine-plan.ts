/**
 * Routine plans — the request-level extension of the render stage driver
 * (docs/design/routine-plans.md; protocol lineage in render-stage-driver.md).
 * A plan is a synchronous generator that EMITS instructions before their work
 * runs; the driver is the only code that executes them. Three effect shapes:
 *
 *   run(name, fn)      — sequential effect; the plan suspends until its result.
 *   start(name, fn)    — fork; completes at invocation, returns the promise as
 *                        a handle a later step may join. Settlement is tracked,
 *                        never awaited by the driver.
 *   schedule(name, fn) — background handoff (waitUntil-shaped); completes at
 *                        scheduling, returns nothing.
 *
 * Plans compose by level: `yield* subplan(name, plan)` flattens a nested plan
 * into the same instruction stream while the trace records the scope. Tracking
 * is derived, not declared — "what is running" is the instruction in hand.
 *
 * Deliberate boundaries (see the design doc's "Not built yet, on purpose"):
 * the interpreter opens no observability spans — effects own their own
 * instrumentation, and the render driver keeps PHASES.ssr — and there is no
 * plan.return abort/cleanup path; the render driver's cleanup rules are the
 * template if a caller ever needs one.
 */

export type RoutineEffectKind = "run" | "start" | "schedule";

export type RoutineCommand =
  | { kind: "run"; name: string; execute: () => unknown }
  | { kind: "start"; name: string; execute: () => Promise<unknown> }
  | { kind: "schedule"; name: string; execute: () => unknown }
  | { kind: "enter"; name: string }
  | { kind: "exit" };

export type RoutineCommandResult =
  | { kind: "run"; value: unknown }
  | { kind: "start"; handle: Promise<unknown> }
  | { kind: "schedule" }
  | { kind: "enter" }
  | { kind: "exit" };

/** One imperative step: yields a command, returns its typed result. */
export type RoutineStep<T> = Generator<RoutineCommand, T, RoutineCommandResult>;

/** A full plan is shaped like a step; the alias marks intent at call sites. */
export type RoutinePlan<TReturn> = RoutineStep<TReturn>;

function expectResultKind<K extends RoutineCommandResult["kind"]>(
  result: RoutineCommandResult,
  kind: K,
  name: string,
): Extract<RoutineCommandResult, { kind: K }> {
  if (result.kind !== kind) {
    throw new Error(
      `[routine] step "${name}" expected ${kind} result, received ${result.kind}`,
    );
  }
  return result as Extract<RoutineCommandResult, { kind: K }>;
}

/**
 * Sequential effect. The `as Awaited<T>` narrow is the trust boundary with the
 * driver, which resumes with the exact value `execute` produced.
 */
export function* run<T>(
  name: string,
  execute: () => T | Promise<T>,
): RoutineStep<Awaited<T>> {
  const result = yield { kind: "run", name, execute };
  return expectResultKind(result, "run", name).value as Awaited<T>;
}

/**
 * Fork: begins concurrent work and returns its promise as a handle. The step
 * completes at invocation — settlement is a background fact recorded by the
 * trace, joined (if ever) by a later effect awaiting the handle.
 */
export function* start<T>(
  name: string,
  execute: () => Promise<T>,
): RoutineStep<Promise<T>> {
  const result = yield { kind: "start", name, execute };
  return expectResultKind(result, "start", name).handle as Promise<T>;
}

/**
 * Background handoff: scheduling completes the effect. A rejection marks the
 * trace entry failed but never fails the plan — background work is best-effort
 * from the foreground's point of view.
 *
 * Settlement tracking follows the RETURNED value: a returned promise is
 * observed until it settles; a scheduler that fires-and-forgets internally
 * (e.g. scheduleShellCapture via runBackground) returns void, so its trace
 * entry settles at the scheduling call, not at background completion. That is
 * deliberate — the plan's contract ends at the handoff.
 */
export function* schedule(
  name: string,
  execute: () => unknown,
): RoutineStep<void> {
  const result = yield { kind: "schedule", name, execute };
  expectResultKind(result, "schedule", name);
}

/**
 * Run a nested plan as a named scope. `yield*` flattens its instructions into
 * the parent stream; enter/exit only inform the trace. The finally clause
 * emits exit even while an error unwinds through the nested plan.
 */
export function* subplan<TReturn>(
  name: string,
  plan: RoutinePlan<TReturn>,
): RoutineStep<TReturn> {
  yield { kind: "enter", name };
  try {
    return yield* plan;
  } finally {
    yield { kind: "exit" };
  }
}

export interface RoutineTraceEntry {
  name: string;
  kind: RoutineEffectKind | "plan";
  depth: number;
  /** run/plan: running -> done|failed. start/schedule: pending -> settled|failed. */
  state: "running" | "pending" | "done" | "settled" | "failed";
  startedAt: number;
  endedAt?: number;
  settledAt?: number;
  error?: unknown;
}

export interface RoutineTrace {
  readonly entries: readonly RoutineTraceEntry[];
  enterScope(name: string): void;
  exitScope(): void;
  /** Scope depth entries currently record at. Bridges (e.g. render stage
   * events feeding child entries under a running step) capture this once and
   * pass `depth + 1` explicitly. */
  currentDepth(): number;
  begin(
    name: string,
    kind: RoutineEffectKind,
    depth?: number,
  ): RoutineTraceEntry;
  end(entry: RoutineTraceEntry): void;
  fail(entry: RoutineTraceEntry, error: unknown): void;
  settle(entry: RoutineTraceEntry, error?: unknown): void;
  /** Foreground instruction in hand plus unsettled background work. */
  active(): RoutineTraceEntry[];
  format(): string;
}

export function createRoutineTrace(
  now: () => number = () => performance.now(),
): RoutineTrace {
  const entries: RoutineTraceEntry[] = [];
  const scopes: RoutineTraceEntry[] = [];

  const push = (
    name: string,
    kind: RoutineTraceEntry["kind"],
    state: RoutineTraceEntry["state"],
    depth: number = scopes.length,
  ): RoutineTraceEntry => {
    const entry: RoutineTraceEntry = {
      name,
      kind,
      depth,
      state,
      startedAt: now(),
    };
    entries.push(entry);
    return entry;
  };

  return {
    entries,
    enterScope(name) {
      scopes.push(push(name, "plan", "running"));
    },
    exitScope() {
      const scope = scopes.pop();
      if (scope && scope.state === "running") {
        scope.state = "done";
        scope.endedAt = now();
      }
    },
    currentDepth() {
      return scopes.length;
    },
    begin(name, kind, depth) {
      return push(name, kind, kind === "run" ? "running" : "pending", depth);
    },
    end(entry) {
      entry.state = "done";
      entry.endedAt = now();
    },
    fail(entry, error) {
      entry.state = "failed";
      entry.endedAt = now();
      entry.error = error;
      // A failure inside a scope fails the scope unless something recovers;
      // recovery paths that continue will overwrite via exitScope's guard.
      const scope = scopes[scopes.length - 1];
      if (scope) scope.state = "failed";
    },
    settle(entry, error) {
      entry.settledAt = now();
      if (error === undefined) {
        entry.state = "settled";
      } else {
        entry.state = "failed";
        entry.error = error;
      }
    },
    active() {
      return entries.filter(
        (entry) => entry.state === "running" || entry.state === "pending",
      );
    },
    format() {
      return entries
        .map((entry) => {
          const indent = "  ".repeat(entry.depth);
          const duration =
            entry.endedAt !== undefined
              ? ` ${(entry.endedAt - entry.startedAt).toFixed(1)}ms`
              : "";
          const settled =
            entry.settledAt !== undefined
              ? ` [${entry.state} +${(entry.settledAt - entry.startedAt).toFixed(1)}ms]`
              : entry.state === "pending"
                ? " [pending]"
                : "";
          const status =
            entry.state === "failed" && entry.settledAt === undefined
              ? " FAILED"
              : "";
          return `${indent}${entry.kind} ${entry.name}${duration}${settled}${status}`;
        })
        .join("\n");
    },
  };
}

export interface RoutineDriverOptions {
  trace?: RoutineTrace;
}

function invokeAsHandle(execute: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(execute());
  } catch (error) {
    return Promise.reject(error);
  }
}

function observeSettlement(
  handle: Promise<unknown>,
  trace: RoutineTrace | undefined,
  entry: RoutineTraceEntry | undefined,
): void {
  // Attaching both callbacks marks the rejection handled on this branch, so a
  // fire-and-forget failure never surfaces as an unhandled rejection.
  handle.then(
    () => {
      if (trace && entry) trace.settle(entry);
    },
    (error) => {
      if (trace && entry) trace.settle(entry, error);
    },
  );
}

/**
 * Interpret a plan. Invariants shared with driveRscRenderPlan: a command is
 * observable before its work runs, `execute` runs exactly once, results and
 * errors resume the plan with exact identity, and a plan-level try/catch
 * around a step is the recovery mechanism.
 */
export async function driveRoutinePlan<TReturn>(
  plan: RoutinePlan<TReturn>,
  options: RoutineDriverOptions = {},
): Promise<TReturn> {
  const trace = options.trace;
  let step = plan.next();
  while (!step.done) {
    const command = step.value;
    switch (command.kind) {
      case "enter": {
        trace?.enterScope(command.name);
        step = plan.next({ kind: "enter" });
        break;
      }
      case "exit": {
        trace?.exitScope();
        step = plan.next({ kind: "exit" });
        break;
      }
      case "run": {
        const entry = trace?.begin(command.name, "run");
        let value: unknown;
        try {
          value = await command.execute();
        } catch (error) {
          if (trace && entry) trace.fail(entry, error);
          // Throw INTO the plan: a catching plan branches to recovery; an
          // uncaught error propagates out of plan.throw with exact identity.
          step = plan.throw(error);
          break;
        }
        if (trace && entry) trace.end(entry);
        step = plan.next({ kind: "run", value });
        break;
      }
      case "start": {
        const entry = trace?.begin(command.name, "start");
        const handle = invokeAsHandle(command.execute);
        observeSettlement(handle, trace, entry);
        step = plan.next({ kind: "start", handle });
        break;
      }
      case "schedule": {
        const entry = trace?.begin(command.name, "schedule");
        observeSettlement(invokeAsHandle(command.execute), trace, entry);
        step = plan.next({ kind: "schedule" });
        break;
      }
    }
  }
  return step.value;
}
