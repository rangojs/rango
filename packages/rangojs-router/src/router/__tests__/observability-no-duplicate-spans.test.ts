import { describe, it, expect } from "vitest";
import { observePhase, PHASES } from "../instrument.js";
import { resolveTracing } from "../tracing.js";
import {
  createOTelTracing,
  createOTelSink,
  type OTelSpan,
  type OTelTracer,
  type OTelActiveSpanTracer,
} from "../telemetry-otel.js";
import { runWithRequestContext } from "../../server/request-context.js";

// The whole point of the split: phase spans (rango.request/loader/render/…) are
// owned by the `tracing` slot (createOTelTracing), and the `telemetry` sink
// (createOTelSink) emits only discrete-fact spans. A real app passes one tracer
// to BOTH. This proves that wiring produces each phase span exactly once — the
// sink does not also rebuild rango.request / rango.loader from lifecycle events.

type MockTracer = OTelTracer & OTelActiveSpanTracer;

function createMockTracer(): { tracer: MockTracer; names: string[] } {
  const names: string[] = [];
  const handle = (): OTelSpan => ({
    setAttribute: () => handle(),
    setStatus: () => handle(),
    recordException: () => {},
    end: () => {},
  });
  const tracer: MockTracer = {
    startSpan(name) {
      names.push(name);
      return handle();
    },
    startActiveSpan<T>(name: string, fn: (span: OTelSpan) => T): T {
      names.push(name);
      return fn(handle());
    },
  };
  return { tracer, names };
}

describe("tracing + telemetry do not duplicate phase spans", () => {
  it("emits each phase span once (tracing slot) and the sink adds only discrete facts", () => {
    const { tracer, names } = createMockTracer();
    // Same tracer wired into both slots, as a real OTel app would.
    const tracing = resolveTracing(createOTelTracing(tracer));
    const sink = createOTelSink(tracer);

    // 1. Phase spans flow through the tracing slot (observePhase) — once each.
    runWithRequestContext(
      { _metricsStore: undefined, _tracing: tracing } as never,
      () => {
        observePhase(PHASES.request, () => {
          observePhase(PHASES.loader("L0.demo"), () => "data");
          observePhase(PHASES.render, () => "rendered");
        });
      },
    );

    // 2. The SAME phases also arrive at the sink as lifecycle events. The sink
    //    must add NOTHING for them — otherwise we'd get duplicate phase spans.
    sink.emit({
      type: "request.start",
      timestamp: 0,
      method: "GET",
      pathname: "/demo",
      transaction: "match",
      isPartial: false,
    });
    sink.emit({
      type: "loader.start",
      timestamp: 1,
      segmentId: "L0.demo",
      loaderName: "demo",
      pathname: "/demo",
    });
    sink.emit({
      type: "loader.end",
      timestamp: 2,
      segmentId: "L0.demo",
      loaderName: "demo",
      pathname: "/demo",
      durationMs: 1,
      ok: true,
    });
    sink.emit({
      type: "request.end",
      timestamp: 3,
      method: "GET",
      pathname: "/demo",
      transaction: "match",
      durationMs: 3,
      segmentCount: 1,
      cacheHit: false,
    });

    // 3. A genuine discrete fact still flows through the sink — once.
    sink.emit({
      type: "cache.decision",
      timestamp: 4,
      pathname: "/demo",
      routeKey: "demo",
      hit: true,
      shouldRevalidate: false,
    });

    const count = (name: string) => names.filter((n) => n === name).length;

    // Phase spans: exactly one each, all from the tracing slot.
    expect(count("rango.request")).toBe(1);
    expect(count("rango.loader")).toBe(1);
    expect(count("rango.render")).toBe(1);
    // Discrete fact: exactly one, from the sink.
    expect(count("rango.cache.decision")).toBe(1);
    // The whole span set is exactly those four — no duplicates from the sink's
    // request/loader lifecycle events.
    expect(names.sort()).toEqual(
      [
        "rango.cache.decision",
        "rango.loader",
        "rango.render",
        "rango.request",
      ].sort(),
    );
  });
});
