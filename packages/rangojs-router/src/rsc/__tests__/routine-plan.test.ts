import { describe, expect, it } from "vitest";
import {
  createRoutineTrace,
  driveRoutinePlan,
  run,
  schedule,
  start,
  subplan,
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
  return createRoutineTrace(() => ++tick);
}

describe("routine plan protocol", () => {
  it("yields the command before the work runs", () => {
    let executed = false;
    function* plan(): RoutinePlan<string> {
      return yield* run("only", () => {
        executed = true;
        return "value";
      });
    }
    const generator = plan();
    const first = generator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ kind: "run", name: "only" });
    expect(executed).toBe(false);
  });

  it("resumes with the exact result identity and threads data flow", async () => {
    const sentinel = { marker: "exact" };
    let received: unknown;
    function* plan(): RoutinePlan<string> {
      const first = yield* run("first", () => sentinel);
      received = first;
      return yield* run("second", () => `next(${String(first === sentinel)})`);
    }
    const result = await driveRoutinePlan(plan());
    expect(received).toBe(sentinel);
    expect(result).toBe("next(true)");
  });

  it("propagates an uncaught step error with exact identity", async () => {
    const boom = new Error("flight failed");
    function* plan(): RoutinePlan<string> {
      return yield* run("explodes", () => {
        throw boom;
      });
    }
    await expect(driveRoutinePlan(plan())).rejects.toBe(boom);
  });

  it("lets the plan recover from a step failure with plain try/catch", async () => {
    const boom = new Error("html failed");
    function* plan(): RoutinePlan<string> {
      try {
        return yield* run("html", () => {
          throw boom;
        });
      } catch (error) {
        expect(error).toBe(boom);
        return yield* run("fallback", () => "flight-only response");
      }
    }
    await expect(driveRoutinePlan(plan())).resolves.toBe(
      "flight-only response",
    );
  });

  it("rejects a mismatched result handshake", () => {
    function* plan(): RoutinePlan<string> {
      return yield* run("expects-run", () => "value");
    }
    const generator = plan();
    generator.next();
    expect(() => generator.next({ kind: "schedule" })).toThrow(
      /expected run result, received schedule/,
    );
  });

  it("start forks without blocking and a later step joins the handle", async () => {
    const ssr = deferred<string>();
    const order: string[] = [];
    function* plan(): RoutinePlan<string> {
      const handle = yield* start("ssr-setup", () => ssr.promise);
      yield* run("match", () => {
        order.push("match");
      });
      return yield* run("html", async () => {
        const setup = await handle;
        order.push("join");
        return `html(${setup})`;
      });
    }
    const driving = driveRoutinePlan(plan());
    // match ran while ssr-setup was still pending: fork did not serialize.
    expect(order).toEqual(["match"]);
    ssr.resolve("ssr-ready");
    await expect(driving).resolves.toBe("html(ssr-ready)");
    expect(order).toEqual(["match", "join"]);
  });

  it("schedule completes at scheduling; settlement and failure stay background", async () => {
    const capture = deferred<void>();
    const trace = fakeClockTrace();
    function* plan(): RoutinePlan<string> {
      yield* schedule("shell-capture", () => capture.promise);
      return yield* run("response", () => "served");
    }
    await expect(driveRoutinePlan(plan(), { trace })).resolves.toBe("served");
    const entry = trace.entries.find((e) => e.name === "shell-capture")!;
    expect(entry.state).toBe("pending");
    capture.resolve();
    await capture.promise;
    expect(entry.state).toBe("settled");
  });

  it("a schedule rejection marks the trace entry failed without failing the plan", async () => {
    const trace = fakeClockTrace();
    const boom = new Error("capture failed");
    function* plan(): RoutinePlan<string> {
      yield* schedule("shell-capture", () => Promise.reject(boom));
      return yield* run("response", () => "served");
    }
    await expect(driveRoutinePlan(plan(), { trace })).resolves.toBe("served");
    await Promise.resolve();
    const entry = trace.entries.find((e) => e.name === "shell-capture")!;
    expect(entry.state).toBe("failed");
    expect(entry.error).toBe(boom);
  });

  it("subplans flatten into one stream and scope the trace", async () => {
    const trace = fakeClockTrace();
    function* inner(input: string): RoutinePlan<string> {
      const flight = yield* run("flight", () => `flight(${input})`);
      return yield* run("response", () => `response(${flight})`);
    }
    function* outer(): RoutinePlan<string> {
      const payload = yield* run("payload", () => "payload");
      return yield* subplan("render", inner(payload));
    }
    await expect(driveRoutinePlan(outer(), { trace })).resolves.toBe(
      "response(flight(payload))",
    );
    expect(
      trace.entries.map((e) => `${"  ".repeat(e.depth)}${e.kind}:${e.name}`),
    ).toEqual(["run:payload", "plan:render", "  run:flight", "  run:response"]);
  });

  it("trace.begin honors an explicit depth for bridged child entries", async () => {
    const trace = fakeClockTrace();
    function* plan(): RoutinePlan<string> {
      return yield* run("render", () => {
        // A bridge created while a step runs records children one level down.
        const depth = trace.currentDepth() + 1;
        const child = trace.begin("flight", "run", depth);
        trace.end(child);
        return "ok";
      });
    }
    await expect(driveRoutinePlan(plan(), { trace })).resolves.toBe("ok");
    expect(trace.entries.map((e) => `${e.depth}:${e.name}`)).toEqual([
      "0:render",
      "1:flight",
    ]);
  });

  it("an error unwinding through a subplan still exits the scope", async () => {
    const trace = fakeClockTrace();
    const boom = new Error("nested failure");
    function* inner(): RoutinePlan<string> {
      return yield* run("flight", () => {
        throw boom;
      });
    }
    function* outer(): RoutinePlan<string> {
      return yield* subplan("render", inner());
    }
    await expect(driveRoutinePlan(outer(), { trace })).rejects.toBe(boom);
    const scope = trace.entries.find((e) => e.kind === "plan")!;
    const failed = trace.entries.find((e) => e.name === "flight")!;
    expect(failed.state).toBe("failed");
    expect(scope.state).toBe("failed");
  });
});

describe("request plan shape (handleRscRenderingInner spine)", () => {
  it("expresses the request lifecycle as one readable instruction stream", async () => {
    const ssrSetup = deferred<string>();
    const captureSettled = deferred<void>();
    const trace = fakeClockTrace();

    function* renderPlan(
      payload: string,
      ssr: Promise<string>,
    ): RoutinePlan<string> {
      const flight = yield* run("flight", () => `flight(${payload})`);
      const html = yield* run("html", async () => `${await ssr}+${flight}`);
      return yield* run("response", () => `response(${html})`);
    }

    function* requestPlan(): RoutinePlan<string> {
      const ctx = yield* run("context", () => "ctx");
      const ssr = yield* start("ssr-setup", () => ssrSetup.promise);
      const match = yield* run("match+onion", () => `match(${ctx})`);
      const payload = yield* run("payload", () => `payload(${match})`);
      const response = yield* subplan("render", renderPlan(payload, ssr));
      yield* schedule("shell-capture", () => captureSettled.promise);
      return response;
    }

    const driving = driveRoutinePlan(requestPlan(), { trace });
    ssrSetup.resolve("ssr");
    const response = await driving;

    // Data flowed through every step, including the forked join.
    expect(response).toBe("response(ssr+flight(payload(match(ctx))))");

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
      "run:context:done",
      "start:ssr-setup:settled",
      "run:match+onion:done",
      "run:payload:done",
      "plan:render:done",
      "  run:flight:done",
      "  run:html:done",
      "  run:response:done",
      "schedule:shell-capture:settled",
    ]);
  });
});
