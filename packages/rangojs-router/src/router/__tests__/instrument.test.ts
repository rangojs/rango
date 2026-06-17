import { describe, it, expect } from "vitest";
import { observePhase, observeEvent, PHASES } from "../instrument.js";
import { runWithRequestContext } from "../../server/request-context.js";
import { runWithRouterContext } from "../router-context.js";
import { createMetricsStore } from "../metrics.js";
import { resolveTracing, type SpanRunner } from "../tracing.js";
import type { TelemetryEvent, TelemetrySink } from "../telemetry.js";

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

const RENDER = PHASES.render;

describe("observePhase", () => {
  it("co-emits the perf metric AND the span from one call", () => {
    const store = createMetricsStore(true)!;
    const { spans, tracing } = recordingTracing();

    const out = withCtx({ store, tracing }, () =>
      observePhase(RENDER, () => 42),
    );

    expect(out).toBe(42);
    // Same call landed on BOTH surfaces — this is the no-drift invariant.
    expect(store.metrics.map((m) => m.label)).toContain("render:total");
    expect(spans).toContain("rango.render");
  });

  it("records the metric even when tracing is off", () => {
    const store = createMetricsStore(true)!;
    withCtx({ store, tracing: undefined }, () => observePhase(RENDER, () => 1));
    expect(store.metrics.map((m) => m.label)).toContain("render:total");
  });

  it("opens the span even when the perf report is off", () => {
    const { spans, tracing } = recordingTracing();
    withCtx({ store: undefined, tracing }, () => observePhase(RENDER, () => 1));
    expect(spans).toContain("rango.render");
  });

  it("is a direct pass-through when both surfaces are off", () => {
    let calls = 0;
    const out = withCtx({ store: undefined, tracing: undefined }, () =>
      observePhase(RENDER, () => {
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
      observePhase(RENDER, async () => {
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
        observePhase(RENDER, () => {
          throw new Error("boom");
        }),
      ),
    ).toThrow("boom");
  });

  it("records the metric on a FAILED phase (sync throw and async reject)", async () => {
    // Parity with the old track().finally() path: a failed loader/render still
    // shows its timing. The fulfilled-only `.then(record)` path dropped it.
    const syncStore = createMetricsStore(true)!;
    expect(() =>
      withCtx({ store: syncStore, tracing: undefined }, () =>
        observePhase(RENDER, () => {
          throw new Error("boom");
        }),
      ),
    ).toThrow("boom");
    expect(syncStore.metrics.map((m) => m.label)).toContain("render:total");

    const asyncStore = createMetricsStore(true)!;
    await expect(
      withCtx({ store: asyncStore, tracing: undefined }, () =>
        observePhase(RENDER, async () => {
          throw new Error("nope");
        }),
      ),
    ).rejects.toThrow("nope");
    expect(asyncStore.metrics.map((m) => m.label)).toContain("render:total");
  });

  it("metric:false opens the span but records NO perf metric", () => {
    const store = createMetricsStore(true)!;
    const { spans, tracing } = recordingTracing();
    // PHASES.request has metric:false (handler:total is metered directly).
    withCtx({ store, tracing }, () => observePhase(PHASES.request, () => 1));
    expect(spans).toContain("rango.request");
    // No metric recorded by the wrap — the caller owns the perf metric.
    expect(store.metrics).toHaveLength(0);
  });

  it("applies the spec's identifying attributes automatically", () => {
    const setKeys: string[] = [];
    const tracing = resolveTracing({
      runner: (name, fn) =>
        fn({
          setAttribute(key) {
            setKeys.push(key);
          },
        }),
    });
    withCtx({ store: undefined, tracing }, () =>
      observePhase(PHASES.loader("Blog#default"), () => 1),
    );
    expect(setKeys).toContain("rango.loader_id");
  });
});

describe("PHASES registry", () => {
  it("loader(id) co-emits loader:<id> at depth 2 with the rango.loader span", () => {
    const spec = PHASES.loader("abc#default");
    expect(spec.spanName).toBe("rango.loader");
    expect(spec.tracePhase).toBe("loader");
    expect(spec.metric).toEqual({ label: "loader:abc#default", depth: 2 });
    expect(spec.attributes).toEqual({ "rango.loader_id": "abc#default" });
  });

  it("loader(id, 1) overrides the depth for the standalone fetchable path", () => {
    expect(PHASES.loader("f#default", 1).metric).toEqual({
      label: "loader:f#default",
      depth: 1,
    });
  });

  it("middleware(name) is span-only and carries the name attribute", () => {
    const spec = PHASES.middleware("auth@*");
    expect(spec.spanName).toBe("rango.middleware");
    expect(spec.metric).toBe(false);
    expect(spec.attributes).toEqual({ "rango.middleware_name": "auth@*" });
  });

  it("action(id) co-emits action:<id> with the rango.action span", () => {
    const spec = PHASES.action("submitOrder#default");
    expect(spec.spanName).toBe("rango.action");
    expect(spec.tracePhase).toBe("action");
    expect(spec.metric).toEqual({ label: "action:submitOrder#default" });
    expect(spec.attributes).toEqual({
      "rango.action_id": "submitOrder#default",
    });
  });

  it("request is span-only; render/ssr carry their metric labels", () => {
    expect(PHASES.request.metric).toBe(false);
    expect(PHASES.ssr.metric).toEqual({ label: "ssr:render-html" });
    // render's label is lazy (it resolves the route name at record time);
    // with no request context it falls back to the bare label.
    const renderMetric = PHASES.render.metric;
    expect(renderMetric).not.toBe(false);
    if (renderMetric !== false) {
      expect(typeof renderMetric.label).toBe("function");
      expect((renderMetric.label as () => string)()).toBe("render:total");
    }
  });

  it("render label includes the route name when set: render:total:<route>", () => {
    const label = runWithRequestContext({ _routeName: "home" } as never, () => {
      const m = PHASES.render.metric;
      return m === false || typeof m.label !== "function" ? "" : m.label();
    });
    expect(label).toBe("render:total:home");
  });
});

describe("observeEvent", () => {
  function withSink<T>(sink: TelemetrySink | undefined, fn: () => T): T {
    return runWithRouterContext(
      { telemetry: sink, requestId: "req-1" } as never,
      fn,
    );
  }

  it("emits the event to the configured sink, stamping the request id", () => {
    const events: TelemetryEvent[] = [];
    const sink: TelemetrySink = { emit: (e) => events.push(e) };
    withSink(sink, () =>
      observeEvent({
        type: "cache.decision",
        timestamp: 1,
        pathname: "/x",
        routeKey: "x",
        hit: true,
        shouldRevalidate: false,
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.requestId).toBe("req-1");
  });

  it("is a no-op when no sink is configured", () => {
    expect(() =>
      withSink(undefined, () =>
        observeEvent({
          type: "cache.decision",
          timestamp: 1,
          pathname: "/x",
          routeKey: "x",
          hit: true,
          shouldRevalidate: false,
        }),
      ),
    ).not.toThrow();
  });

  it("is a no-op (does not throw) outside a router context", () => {
    expect(() =>
      observeEvent({
        type: "cache.decision",
        timestamp: 1,
        pathname: "/x",
        routeKey: "x",
        hit: true,
        shouldRevalidate: false,
      }),
    ).not.toThrow();
  });
});
