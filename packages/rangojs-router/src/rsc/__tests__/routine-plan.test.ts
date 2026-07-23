import { describe, expect, it } from "vitest";
import {
  createRoutineTrace,
  handoff,
  runRoutine,
  scope,
  step,
  type RoutinePlan,
} from "../routine-plan.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeClockTrace(): ReturnType<typeof createRoutineTrace> {
  let tick = 0;
  return createRoutineTrace("test", () => ++tick);
}

describe("routine plan protocol", () => {
  it("yields the command before the work runs", () => {
    let executed = false;
    function* plan(): RoutinePlan<string> {
      return yield* step("only", () => {
        executed = true;
        return "value";
      });
    }
    const generator = plan();
    const first = generator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ kind: "step", name: "only" });
    expect(executed).toBe(false);
  });

  it("resumes with the exact result identity and threads data flow", async () => {
    const sentinel = { marker: "exact" };
    let received: unknown;
    function* plan(): RoutinePlan<string> {
      const first = yield* step("first", () => sentinel);
      received = first;
      return yield* step("second", () => `next(${String(first === sentinel)})`);
    }
    const result = await runRoutine(plan());
    expect(received).toBe(sentinel);
    expect(result).toBe("next(true)");
  });

  it("propagates an uncaught step error with exact identity", async () => {
    const boom = new Error("flight failed");
    function* plan(): RoutinePlan<string> {
      return yield* step("explodes", () => {
        throw boom;
      });
    }
    await expect(runRoutine(plan())).rejects.toBe(boom);
  });

  it("lets the plan recover from a step failure with plain try/catch", async () => {
    const boom = new Error("html failed");
    function* plan(): RoutinePlan<string> {
      try {
        return yield* step("html", () => {
          throw boom;
        });
      } catch (error) {
        expect(error).toBe(boom);
        return yield* step("fallback", () => "flight-only response");
      }
    }
    await expect(runRoutine(plan())).resolves.toBe("flight-only response");
  });

  it("rejects a mismatched result handshake", () => {
    function* plan(): RoutinePlan<string> {
      return yield* step("expects-step", () => "value");
    }
    const generator = plan();
    generator.next();
    expect(() => generator.next({ kind: "handoff" })).toThrow(
      /expected step result, received handoff/,
    );
  });

  it("handoff completes at scheduling; settlement stays background", async () => {
    const capture = deferred<void>();
    const trace = fakeClockTrace();
    function* plan(): RoutinePlan<string> {
      yield* handoff("shell-capture", () => capture.promise);
      return yield* step("response", () => "served");
    }
    await expect(runRoutine(plan(), { trace })).resolves.toBe("served");
    const entry = trace.entries.find((e) => e.name === "shell-capture")!;
    expect(entry.state).toBe("pending");
    capture.resolve();
    await capture.promise;
    expect(entry.state).toBe("settled");
  });

  it("an asynchronous handoff rejection marks the trace without failing the plan", async () => {
    const trace = fakeClockTrace();
    const boom = new Error("capture failed");
    function* plan(): RoutinePlan<string> {
      yield* handoff("shell-capture", () => Promise.reject(boom));
      return yield* step("response", () => "served");
    }
    await expect(runRoutine(plan(), { trace })).resolves.toBe("served");
    await Promise.resolve();
    const entry = trace.entries.find((e) => e.name === "shell-capture")!;
    expect(entry.state).toBe("failed");
    expect(entry.error).toBe(boom);
  });

  it("propagates a synchronous handoff failure with exact identity", async () => {
    const trace = fakeClockTrace();
    const boom = new Error("waitUntil registration failed");
    let continued = false;
    function* plan(): RoutinePlan<string> {
      yield* handoff("shell-capture", () => {
        throw boom;
      });
      continued = true;
      return "served";
    }

    await expect(runRoutine(plan(), { trace })).rejects.toBe(boom);
    expect(continued).toBe(false);
    expect(trace.entries[0]).toMatchObject({
      name: "shell-capture",
      state: "failed",
      error: boom,
    });
  });

  it("records an undefined rejection reason as a failed handoff", async () => {
    const trace = fakeClockTrace();
    function* plan(): RoutinePlan<string> {
      yield* handoff("shell-capture", () => Promise.reject(undefined));
      return "served";
    }

    await expect(runRoutine(plan(), { trace })).resolves.toBe("served");
    await Promise.resolve();
    expect(trace.entries[0]).toMatchObject({
      name: "shell-capture",
      state: "failed",
      error: undefined,
    });
  });

  it("rejects promise-valued plan returns so async work stays visible", async () => {
    function* plan(): RoutinePlan<Promise<string>> {
      yield* step("before-return", () => undefined);
      return Promise.resolve("hidden work");
    }
    await expect(runRoutine(plan())).rejects.toThrow(
      /plans cannot return promises.*step/,
    );
  });

  it("scopes flatten into one stream and group the trace", async () => {
    const trace = fakeClockTrace();
    function* inner(input: string): RoutinePlan<string> {
      const flight = yield* step("flight", () => `flight(${input})`);
      return yield* step("response", () => `response(${flight})`);
    }
    function* outer(): RoutinePlan<string> {
      const payload = yield* step("payload", () => "payload");
      return yield* scope("render", inner(payload));
    }
    await expect(runRoutine(outer(), { trace })).resolves.toBe(
      "response(flight(payload))",
    );
    expect(
      trace.entries.map((e) => `${"  ".repeat(e.depth)}${e.kind}:${e.name}`),
    ).toEqual([
      "step:payload",
      "scope:render",
      "  step:flight",
      "  step:response",
    ]);
  });

  it("trace.begin honors an explicit depth for bridged child entries", async () => {
    const trace = fakeClockTrace();
    function* plan(): RoutinePlan<string> {
      return yield* step("render", () => {
        // A bridge created while a step runs records children one level down.
        const depth = trace.currentDepth() + 1;
        const child = trace.begin("flight", "step", depth);
        trace.end(child);
        return "ok";
      });
    }
    await expect(runRoutine(plan(), { trace })).resolves.toBe("ok");
    expect(trace.entries.map((e) => `${e.depth}:${e.name}`)).toEqual([
      "0:render",
      "1:flight",
    ]);
  });

  it("marks a scope done when it recovers internally", async () => {
    const trace = fakeClockTrace();
    function* inner(): RoutinePlan<string> {
      try {
        return yield* step("primary", () => {
          throw new Error("primary failed");
        });
      } catch {
        return yield* step("fallback", () => "recovered");
      }
    }
    function* outer(): RoutinePlan<string> {
      return yield* scope("recovering", inner());
    }

    await expect(runRoutine(outer(), { trace })).resolves.toBe("recovered");
    const recovered = trace.entries.find((entry) => entry.kind === "scope")!;
    expect(recovered).toMatchObject({
      name: "recovering",
      state: "done",
    });
    expect(recovered.error).toBeUndefined();
    expect(recovered.endedAt).toBeDefined();
  });

  it("marks every scope crossed by an escaping error as failed", async () => {
    const trace = fakeClockTrace();
    const boom = new Error("nested failure");
    function* inner(): RoutinePlan<string> {
      return yield* step("flight", () => {
        throw boom;
      });
    }
    function* middle(): RoutinePlan<string> {
      return yield* scope("inner", inner());
    }
    function* outer(): RoutinePlan<string> {
      return yield* scope("outer", middle());
    }
    await expect(runRoutine(outer(), { trace })).rejects.toBe(boom);
    const scopes = trace.entries.filter((entry) => entry.kind === "scope");
    const failed = trace.entries.find((e) => e.name === "flight")!;
    expect(failed.state).toBe("failed");
    expect(scopes).toHaveLength(2);
    for (const failedScope of scopes) {
      expect(failedScope.state).toBe("failed");
      expect(failedScope.error).toBe(boom);
      expect(failedScope.endedAt).toBeDefined();
    }
  });

  it("publishes the active routine to its owner until completion", async () => {
    const pending = deferred<string>();
    const trace = fakeClockTrace();
    const owner: { _activeRoutine?: typeof trace } = {};
    function* plan(): RoutinePlan<string> {
      return yield* scope(
        "prepare:full",
        (function* (): RoutinePlan<string> {
          return yield* step("match", () => pending.promise);
        })(),
      );
    }

    const driving = runRoutine(plan(), { trace, owner });
    expect(owner._activeRoutine).toBe(trace);
    expect(trace.active().map((entry) => entry.name)).toEqual([
      "prepare:full",
      "match",
    ]);
    expect(trace.formatActive()).toContain("step match");

    pending.resolve("matched");
    await expect(driving).resolves.toBe("matched");
    expect(owner._activeRoutine).toBeUndefined();
  });
});

describe("request plan shape (handleRscRenderingInner spine)", () => {
  it("expresses the request lifecycle as one readable instruction stream", async () => {
    const captureSettled = deferred<void>();
    const trace = fakeClockTrace();

    function* shellServePlan(): RoutinePlan<"miss"> {
      return yield* step("shell-read", () => "miss" as const);
    }

    function* preparePlan(): RoutinePlan<string> {
      const match = yield* step("match", () => "route");
      return `payload(${match})`;
    }

    function* requestPlan(): RoutinePlan<string> {
      yield* scope("shell-serve", shellServePlan());
      const payload = yield* scope("prepare:full", preparePlan());
      const response = yield* step("render", async () =>
        Promise.resolve(`response(${payload})`),
      );
      yield* handoff("shell-capture", () => captureSettled.promise);
      return response;
    }

    const driving = runRoutine(requestPlan(), { trace });
    const response = await driving;

    expect(response).toBe("response(payload(route))");

    // The response returned while shell-capture was still background-pending.
    const capture = trace.entries.find((e) => e.name === "shell-capture")!;
    expect(capture.state).toBe("pending");
    captureSettled.resolve();
    await captureSettled.promise;
    expect(capture.state).toBe("settled");

    expect(
      trace.entries.map(
        (e) => `${"  ".repeat(e.depth)}${e.kind}:${e.name}:${e.state}`,
      ),
    ).toEqual([
      "scope:shell-serve:done",
      "  step:shell-read:done",
      "scope:prepare:full:done",
      "  step:match:done",
      "step:render:done",
      "handoff:shell-capture:settled",
    ]);
  });
});
