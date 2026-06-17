import { describe, it, expect } from "vitest";
import { measurePhase } from "../instrument.js";
import { runWithRequestContext } from "../../server/request-context.js";
import { createMetricsStore } from "../metrics.js";
import { resolveTracing, type SpanRunner } from "../tracing.js";

function recordingTracing() {
  const spans: string[] = [];
  const runner: SpanRunner = (name, fn) => {
    spans.push(name);
    return fn({ setAttribute() {} });
  };
  return { spans, tracing: resolveTracing({ runner }) };
}

function withCtx<T>(
  fields: { store?: unknown; tracing?: unknown },
  fn: () => T,
): T {
  return runWithRequestContext(
    { _metricsStore: fields.store, _tracing: fields.tracing } as never,
    fn,
  );
}

const SPEC = {
  metricLabel: "render:total",
  tracePhase: "render" as const,
  spanName: "rango.render",
};

describe("measurePhase", () => {
  it("co-emits the perf metric AND the span from one call", () => {
    const store = createMetricsStore(true)!;
    const { spans, tracing } = recordingTracing();

    const out = withCtx({ store, tracing }, () => measurePhase(SPEC, () => 42));

    expect(out).toBe(42);
    // Same call landed on BOTH surfaces — this is the no-drift invariant.
    expect(store.metrics.map((m) => m.label)).toContain("render:total");
    expect(spans).toContain("rango.render");
  });

  it("records the metric even when tracing is off", () => {
    const store = createMetricsStore(true)!;
    withCtx({ store, tracing: undefined }, () => measurePhase(SPEC, () => 1));
    expect(store.metrics.map((m) => m.label)).toContain("render:total");
  });

  it("opens the span even when the perf report is off", () => {
    const { spans, tracing } = recordingTracing();
    withCtx({ store: undefined, tracing }, () => measurePhase(SPEC, () => 1));
    expect(spans).toContain("rango.render");
  });

  it("is a direct pass-through when both surfaces are off", () => {
    let calls = 0;
    const out = withCtx({ store: undefined, tracing: undefined }, () =>
      measurePhase(SPEC, () => {
        calls++;
        return "x";
      }),
    );
    expect(out).toBe("x");
    expect(calls).toBe(1);
  });

  it("records the metric when an async phase settles and preserves the value", async () => {
    const store = createMetricsStore(true)!;
    const { spans, tracing } = recordingTracing();
    const out = await withCtx({ store, tracing }, () =>
      measurePhase(SPEC, async () => {
        await Promise.resolve();
        return "done";
      }),
    );
    expect(out).toBe("done");
    expect(store.metrics.map((m) => m.label)).toContain("render:total");
    expect(spans).toContain("rango.render");
  });

  it("propagates a thrown error", () => {
    const store = createMetricsStore(true)!;
    expect(() =>
      withCtx({ store, tracing: undefined }, () =>
        measurePhase(SPEC, () => {
          throw new Error("boom");
        }),
      ),
    ).toThrow("boom");
  });
});
