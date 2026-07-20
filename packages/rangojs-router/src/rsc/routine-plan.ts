/**
 * Routine plans — the request-level extension of the render stage driver
 * (docs/design/routine-plans.md; protocol lineage in render-stage-driver.md).
 * A plan is a synchronous generator that EMITS instructions before their work
 * runs; the runner is the only code that executes them. Two effect shapes:
 *
 *   step(name, fn)     — sequential work; the plan suspends until its result.
 *   handoff(name, fn)  — background registration (waitUntil-shaped); completes
 *                        at scheduling and returns nothing.
 *
 * Plans compose by level: `yield* scope(name, plan)` flattens a nested plan
 * into the same instruction stream while the trace records the scope. Tracking
 * is derived, not declared — "what is running" is the instruction in hand.
 *
 * Deliberate boundaries (see the design doc's "Not built yet, on purpose"):
 * the runner opens no observability spans — effects own their own
 * instrumentation, and the render driver keeps PHASES.ssr — and there is no
 * plan.return abort/cleanup path; the render driver's cleanup rules are the
 * template if a caller ever needs one.
 */

import { isThenable } from "../handles/is-thenable.js";

export type RoutineEffectKind = "step" | "handoff";

export type RoutineCommand =
  | { kind: "step"; name: string; execute: () => unknown }
  | { kind: "handoff"; name: string; execute: () => unknown }
  | { kind: "enter"; name: string }
  | { kind: "exit"; outcome: "done" | "failed"; error?: unknown };

export type RoutineCommandResult =
  | { kind: "step"; value: unknown }
  | { kind: "handoff" }
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
 * Sequential work. The `as Awaited<T>` narrow is the trust boundary with the
 * runner, which resumes with the exact value `execute` produced.
 */
export function* step<T>(
  name: string,
  execute: () => T | Promise<T>,
): RoutineStep<Awaited<T>> {
  const result = yield { kind: "step", name, execute };
  return expectResultKind(result, "step", name).value as Awaited<T>;
}

/**
 * Background handoff: successful registration completes the foreground step.
 * A synchronous registration failure is thrown back into the plan, matching a
 * direct waitUntil/scheduler call. A returned promise settles in the background;
 * its rejection marks the trace but never fails the foreground response.
 *
 * Settlement tracking follows the RETURNED value: a returned promise is
 * observed until it settles; a scheduler that fires-and-forgets internally
 * (e.g. scheduleShellCapture via runBackground) returns void, so its trace
 * entry settles at the scheduling call, not at background completion. That is
 * deliberate — the plan's contract ends at the handoff.
 */
export function* handoff(
  name: string,
  execute: () => unknown,
): RoutineStep<void> {
  const result = yield { kind: "handoff", name, execute };
  expectResultKind(result, "handoff", name);
}

/**
 * Run a nested plan as a named scope. `yield*` flattens its instructions into
 * the parent stream; enter/exit only inform the trace. The scope reports its
 * terminal outcome after internal recovery has either succeeded or escaped.
 */
export function* scope<TReturn>(
  name: string,
  plan: RoutinePlan<TReturn>,
): RoutineStep<TReturn> {
  yield { kind: "enter", name };
  try {
    const value = yield* plan;
    assertSynchronousReturn(value);
    yield { kind: "exit", outcome: "done" };
    return value;
  } catch (error) {
    yield { kind: "exit", outcome: "failed", error };
    throw error;
  }
}

export interface RoutineTraceEntry {
  name: string;
  kind: RoutineEffectKind | "scope";
  depth: number;
  /** step/scope: running -> done|failed. handoff: pending -> settled|failed. */
  state: "running" | "pending" | "done" | "settled" | "failed";
  startedAt: number;
  endedAt?: number;
  settledAt?: number;
  error?: unknown;
}

export interface RoutineTrace {
  readonly name: string;
  readonly entries: readonly RoutineTraceEntry[];
  enterScope(name: string): void;
  exitScope(outcome: "done" | "failed", error?: unknown): void;
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
  settle(
    entry: RoutineTraceEntry,
    outcome: { status: "fulfilled" } | { status: "rejected"; error: unknown },
  ): void;
  /** Running scopes plus the foreground instruction currently in hand. */
  active(): RoutineTraceEntry[];
  format(): string;
  formatActive(
    entries?: readonly RoutineTraceEntry[],
    activeAt?: number,
  ): string;
}

export function createRoutineTrace(
  name: string,
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

  const active = (): RoutineTraceEntry[] =>
    entries.filter((entry) => entry.state === "running");

  return {
    name,
    entries,
    enterScope(name) {
      scopes.push(push(name, "scope", "running"));
    },
    exitScope(outcome, error) {
      const scope = scopes.pop();
      if (scope) {
        scope.state = outcome;
        scope.endedAt = now();
        if (outcome === "failed") scope.error = error;
      }
    },
    currentDepth() {
      return scopes.length;
    },
    begin(name, kind, depth) {
      return push(name, kind, kind === "step" ? "running" : "pending", depth);
    },
    end(entry) {
      entry.state = "done";
      entry.endedAt = now();
    },
    fail(entry, error) {
      entry.state = "failed";
      entry.endedAt = now();
      entry.error = error;
    },
    settle(entry, outcome) {
      entry.settledAt = now();
      if (outcome.status === "fulfilled") {
        entry.state = "settled";
      } else {
        entry.state = "failed";
        entry.error = outcome.error;
      }
    },
    active,
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
    formatActive(activeEntries = active(), activeAt = now()) {
      return activeEntries
        .map((entry) => {
          const indent = "  ".repeat(entry.depth);
          const duration = (activeAt - entry.startedAt).toFixed(1);
          return `${indent}${entry.kind} ${entry.name} ${duration}ms RUNNING`;
        })
        .join("\n");
    },
  };
}

export interface RoutineTraceOwner {
  _activeRoutine?: RoutineTrace;
}

export interface RoutineRunnerOptions {
  trace?: RoutineTrace;
  owner?: RoutineTraceOwner;
}

function assertSynchronousReturn(value: unknown): void {
  if (isThenable(value)) {
    throw new Error(
      "[routine] plans cannot return promises; await asynchronous work with step()",
    );
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
      if (trace && entry) trace.settle(entry, { status: "fulfilled" });
    },
    (error) => {
      if (trace && entry) {
        trace.settle(entry, { status: "rejected", error });
      }
    },
  );
}

/**
 * Interpret a plan. Invariants shared with driveRscRenderPlan: a command is
 * observable before its work runs, `execute` runs exactly once, results and
 * errors resume the plan with exact identity, and a plan-level try/catch
 * around a step is the recovery mechanism.
 */
export async function runRoutine<TReturn>(
  plan: RoutinePlan<TReturn>,
  options: RoutineRunnerOptions = {},
): Promise<TReturn> {
  const trace = options.trace;
  const owner = options.owner;
  const previousTrace = owner?._activeRoutine;
  if (trace && owner) owner._activeRoutine = trace;

  try {
    let current = plan.next();
    while (!current.done) {
      const command = current.value;
      switch (command.kind) {
        case "enter": {
          trace?.enterScope(command.name);
          current = plan.next({ kind: "enter" });
          break;
        }
        case "exit": {
          trace?.exitScope(command.outcome, command.error);
          current = plan.next({ kind: "exit" });
          break;
        }
        case "step": {
          const entry = trace?.begin(command.name, "step");
          let value: unknown;
          try {
            value = await command.execute();
          } catch (error) {
            if (trace && entry) trace.fail(entry, error);
            // Throw INTO the plan: a catching plan branches to recovery; an
            // uncaught error propagates out of plan.throw with exact identity.
            current = plan.throw(error);
            break;
          }
          if (trace && entry) trace.end(entry);
          current = plan.next({ kind: "step", value });
          break;
        }
        case "handoff": {
          const entry = trace?.begin(command.name, "handoff");
          try {
            const result = command.execute();
            if (isThenable(result)) {
              observeSettlement(Promise.resolve(result), trace, entry);
            } else if (trace && entry) {
              trace.settle(entry, { status: "fulfilled" });
            }
          } catch (error) {
            if (trace && entry) trace.fail(entry, error);
            current = plan.throw(error);
            break;
          }
          current = plan.next({ kind: "handoff" });
          break;
        }
      }
    }
    assertSynchronousReturn(current.value);
    return current.value;
  } finally {
    if (trace && owner?._activeRoutine === trace) {
      owner._activeRoutine = previousTrace;
    }
  }
}
