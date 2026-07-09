import { describe, it, expect, beforeEach } from "vitest";
import {
  createOTelSink,
  createOTelTracing,
  type OTelSpan,
  type OTelTracer,
  type OTelActiveSpanTracer,
} from "../telemetry-otel";

// The real OTel Tracer implements both methods; the mock satisfies both the
// event sink's (startSpan) and the tracing adapter's (startActiveSpan) contract.
type MockTracer = OTelTracer & OTelActiveSpanTracer;

// ---------------------------------------------------------------------------
// In-memory OTel exporter (mock tracer + spans)
//
// startSpan powers the event-shaped instant spans (createOTelSink).
// startActiveSpan powers the callback-bound phase spans (createOTelTracing);
// the mock tracks a synchronous active-span stack so nesting can be asserted.
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: number; message?: string };
  exceptions: Error[];
  ended: boolean;
  /** Name of the active span when this one was opened (startActiveSpan only). */
  parent?: string;
}

function createMockTracer(): { tracer: MockTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const activeStack: RecordedSpan[] = [];

  function make(
    name: string,
    attributes: Record<string, string | number | boolean>,
  ): { span: RecordedSpan; handle: OTelSpan } {
    const span: RecordedSpan = {
      name,
      attributes: { ...attributes },
      status: undefined,
      exceptions: [],
      ended: false,
    };
    spans.push(span);
    const handle: OTelSpan = {
      setAttribute(key, value) {
        span.attributes[key] = value;
        return handle;
      },
      setStatus(status) {
        span.status = status;
        return handle;
      },
      recordException(error) {
        span.exceptions.push(error);
      },
      end() {
        span.ended = true;
      },
    };
    return { span, handle };
  }

  const tracer: MockTracer = {
    startSpan(name, options) {
      return make(name, options?.attributes ?? {}).handle;
    },
    startActiveSpan<T>(name: string, fn: (span: OTelSpan) => T): T {
      const { span, handle } = make(name, {});
      span.parent = activeStack[activeStack.length - 1]?.name;
      activeStack.push(span);
      try {
        return fn(handle);
      } finally {
        activeStack.pop();
      }
    },
  };

  return { tracer, spans };
}

// ---------------------------------------------------------------------------
// createOTelTracing — phase spans via startActiveSpan (the `tracing` slot)
// ---------------------------------------------------------------------------

describe("createOTelTracing", () => {
  let tracer: MockTracer;
  let spans: RecordedSpan[];

  beforeEach(() => {
    const mock = createMockTracer();
    tracer = mock.tracer;
    spans = mock.spans;
  });

  it("opens, ends, and returns the value for sync work", () => {
    const { runner } = createOTelTracing(tracer);
    const out = runner("rango.render", (span) => {
      span.setAttribute("rango.k", "v");
      return 42;
    });
    expect(out).toBe(42);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("rango.render");
    expect(spans[0]!.attributes["rango.k"]).toBe("v");
    expect(spans[0]!.ended).toBe(true);
  });

  it("defers span end until an async phase settles, preserving the value", async () => {
    const { runner } = createOTelTracing(tracer);
    let resolve!: (v: string) => void;
    const promise = runner(
      "rango.loader",
      () => new Promise<string>((r) => (resolve = r)),
    );
    // Span is open while the work is in flight.
    expect(spans[0]!.ended).toBe(false);
    resolve("done");
    await expect(promise).resolves.toBe("done");
    expect(spans[0]!.ended).toBe(true);
  });

  it("records the exception + ERROR status and ends on a synchronous throw", () => {
    const { runner } = createOTelTracing(tracer);
    const error = new Error("boom");
    expect(() =>
      runner("rango.request", () => {
        throw error;
      }),
    ).toThrow("boom");
    expect(spans[0]!.ended).toBe(true);
    expect(spans[0]!.exceptions).toEqual([error]);
    expect(spans[0]!.status).toEqual({ code: 2, message: "boom" });
  });

  it("records the exception + ERROR status and ends on a rejected promise", async () => {
    const { runner } = createOTelTracing(tracer);
    const error = new Error("nope");
    const promise = runner("rango.ssr", async () => {
      throw error;
    });
    await expect(promise).rejects.toThrow("nope");
    expect(spans[0]!.ended).toBe(true);
    expect(spans[0]!.exceptions).toEqual([error]);
    expect(spans[0]!.status).toEqual({ code: 2, message: "nope" });
  });

  it("nests child phase spans under the active parent", () => {
    const { runner } = createOTelTracing(tracer);
    runner("rango.render", () => {
      runner("rango.loader", () => "x");
    });
    const render = spans.find((s) => s.name === "rango.render")!;
    const loader = spans.find((s) => s.name === "rango.loader")!;
    expect(render.parent).toBeUndefined();
    expect(loader.parent).toBe("rango.render");
  });

  it("carries enabled and per-phase toggles onto the config", () => {
    const config = createOTelTracing(tracer, {
      enabled: false,
      spans: { ssr: false },
    });
    expect(config.enabled).toBe(false);
    expect(config.spans).toEqual({ ssr: false });
    expect(typeof config.runner).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// createOTelSink — discrete-fact instant spans (the `telemetry` slot)
// ---------------------------------------------------------------------------

describe("createOTelSink", () => {
  let tracer: MockTracer;
  let spans: RecordedSpan[];

  beforeEach(() => {
    const mock = createMockTracer();
    tracer = mock.tracer;
    spans = mock.spans;
  });

  describe("phase events are no-ops (owned by the tracing slot)", () => {
    it("does not emit a span for request.start / request.end", () => {
      const sink = createOTelSink(tracer);
      sink.emit({
        type: "request.start",
        timestamp: 0,
        method: "GET",
        pathname: "/blog",
        transaction: "match",
        isPartial: false,
      });
      sink.emit({
        type: "request.end",
        timestamp: 50,
        method: "GET",
        pathname: "/blog",
        transaction: "match",
        durationMs: 50,
        segmentCount: 3,
        cacheHit: false,
      });
      expect(spans).toHaveLength(0);
    });

    it("does not emit a span for loader.start / loader.end / loader.error", () => {
      const sink = createOTelSink(tracer);
      sink.emit({
        type: "loader.start",
        timestamp: 0,
        segmentId: "L0D0.userLoader",
        loaderName: "userLoader",
        pathname: "/profile",
      });
      sink.emit({
        type: "loader.end",
        timestamp: 10,
        segmentId: "L0D0.userLoader",
        loaderName: "userLoader",
        pathname: "/profile",
        durationMs: 10,
        ok: true,
      });
      sink.emit({
        type: "loader.error",
        timestamp: 11,
        segmentId: "L0D0.userLoader",
        loaderName: "userLoader",
        pathname: "/profile",
        error: new Error("x"),
        handledByBoundary: false,
      });
      expect(spans).toHaveLength(0);
    });

    it("does not emit a span for request.error", () => {
      const sink = createOTelSink(tracer);
      sink.emit({
        type: "request.error",
        timestamp: 30,
        method: "POST",
        pathname: "/api/submit",
        transaction: "matchPartial",
        error: new Error("handler exploded"),
        phase: "action",
        durationMs: 30,
      });
      expect(spans).toHaveLength(0);
    });
  });

  describe("handler error", () => {
    it("creates an instant span with error details", () => {
      const sink = createOTelSink(tracer);
      const error = new Error("render failed");

      sink.emit({
        type: "handler.error",
        timestamp: 10,
        segmentId: "R0",
        segmentType: "route",
        error,
        handledByBoundary: true,
        pathname: "/products/42",
        routeKey: "products.detail",
        params: { id: "42" },
      });

      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("rango.handler.error");
      expect(span.ended).toBe(true);
      expect(span.exceptions).toEqual([error]);
      expect(span.attributes["rango.segment_id"]).toBe("R0");
      expect(span.attributes["rango.segment_type"]).toBe("route");
      expect(span.attributes["http.route"]).toBe("/products/42");
      expect(span.attributes["rango.route_key"]).toBe("products.detail");
      expect(span.attributes["rango.handled_by_boundary"]).toBe(true);
      expect(span.attributes["rango.params"]).toBe('{"id":"42"}');
      expect(span.status).toEqual({ code: 2, message: "render failed" });
    });

    it("handles handler.error with minimal fields", () => {
      const sink = createOTelSink(tracer);
      sink.emit({
        type: "handler.error",
        timestamp: 0,
        error: new Error("boom"),
        handledByBoundary: false,
      });
      const span = spans[0]!;
      expect(span.attributes["rango.handled_by_boundary"]).toBe(false);
      expect(span.attributes["rango.segment_id"]).toBeUndefined();
      expect(span.attributes["http.route"]).toBeUndefined();
    });
  });

  describe("cache decision", () => {
    it("creates an instant span with cache attributes", () => {
      const sink = createOTelSink(tracer);
      sink.emit({
        type: "cache.decision",
        timestamp: 5,
        pathname: "/blog",
        routeKey: "blog",
        hit: true,
        shouldRevalidate: false,
        source: "runtime",
      });
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("rango.cache.decision");
      expect(span.ended).toBe(true);
      expect(span.attributes["rango.cache.hit"]).toBe(true);
      expect(span.attributes["rango.cache.source"]).toBe("runtime");
    });

    it("omits source when not provided", () => {
      const sink = createOTelSink(tracer);
      sink.emit({
        type: "cache.decision",
        timestamp: 0,
        pathname: "/page",
        routeKey: "page",
        hit: false,
        shouldRevalidate: false,
      });
      expect(spans[0]!.attributes["rango.cache.source"]).toBeUndefined();
    });
  });

  describe("revalidation decision", () => {
    it("creates an instant span with revalidation attributes", () => {
      const sink = createOTelSink(tracer);
      sink.emit({
        type: "revalidation.decision",
        timestamp: 10,
        segmentId: "L0",
        pathname: "/dashboard",
        routeKey: "dashboard",
        shouldRevalidate: true,
      });
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("rango.revalidation.decision");
      expect(span.ended).toBe(true);
      expect(span.attributes["rango.revalidate"]).toBe(true);
    });
  });

  describe("request timeout", () => {
    it("creates an error instant span with timeout attributes", () => {
      const sink = createOTelSink(tracer);
      sink.emit({
        type: "request.timeout",
        timestamp: 5,
        phase: "action",
        pathname: "/checkout",
        routeKey: "checkout",
        actionId: "submitOrder",
        durationMs: 10000,
        customHandler: true,
      });
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("rango.request.timeout");
      expect(span.ended).toBe(true);
      expect(span.attributes["rango.phase"]).toBe("action");
      expect(span.attributes["http.route"]).toBe("/checkout");
      expect(span.attributes["rango.duration_ms"]).toBe(10000);
      expect(span.attributes["rango.timeout.custom_handler"]).toBe(true);
      expect(span.attributes["rango.action_id"]).toBe("submitOrder");
      expect(span.status?.code).toBe(2);
    });

    it("adds the frozen foreground render cursor when available", () => {
      const sink = createOTelSink(tracer);
      sink.emit({
        type: "request.timeout",
        timestamp: 5,
        phase: "render-start",
        pathname: "/slow",
        durationMs: 5000,
        customHandler: false,
        render: {
          mode: "full",
          phase: "html",
          state: "running",
          completed: 1,
          total: 3,
          phaseDurationMs: 4500,
        },
      });

      const span = spans[0]!;
      expect(span.attributes["rango.render.mode"]).toBe("full");
      expect(span.attributes["rango.render.phase"]).toBe("html");
      expect(span.attributes["rango.render.state"]).toBe("running");
      expect(span.attributes["rango.render.completed"]).toBe(1);
      expect(span.attributes["rango.render.total"]).toBe(3);
      expect(span.attributes["rango.render.phase_duration_ms"]).toBe(4500);
    });
  });

  describe("origin rejected", () => {
    it("creates an error instant span; omits null origin/host", () => {
      const sink = createOTelSink(tracer);
      sink.emit({
        type: "request.origin-rejected",
        timestamp: 1,
        method: "POST",
        pathname: "/api/act",
        phase: "action",
        origin: "https://evil.example",
        host: null,
      });
      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("rango.request.origin-rejected");
      expect(span.ended).toBe(true);
      expect(span.attributes["http.method"]).toBe("POST");
      expect(span.attributes["rango.origin"]).toBe("https://evil.example");
      expect(span.attributes["http.host"]).toBeUndefined();
      expect(span.status?.code).toBe(2);
    });
  });
});
