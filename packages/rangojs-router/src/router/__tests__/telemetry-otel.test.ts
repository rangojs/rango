import { describe, it, expect, beforeEach } from "vitest";
import {
  createOTelSink,
  type OTelSpan,
  type OTelTracer,
} from "../telemetry-otel";
import type { TelemetryEvent } from "../telemetry";

// ---------------------------------------------------------------------------
// In-memory OTel exporter (mock tracer + spans)
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  events: {
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }[];
  status?: { code: number; message?: string };
  exceptions: Error[];
  ended: boolean;
}

function createMockTracer(): { tracer: OTelTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];

  const tracer: OTelTracer = {
    startSpan(
      name: string,
      options?: { attributes?: Record<string, string | number | boolean> },
    ): OTelSpan {
      const span: RecordedSpan = {
        name,
        attributes: { ...(options?.attributes ?? {}) },
        events: [],
        status: undefined,
        exceptions: [],
        ended: false,
      };
      spans.push(span);

      return {
        setAttribute(key: string, value: string | number | boolean) {
          span.attributes[key] = value;
          return this;
        },
        addEvent(
          eventName: string,
          attrs?: Record<string, string | number | boolean>,
        ) {
          span.events.push({ name: eventName, attributes: attrs });
          return this;
        },
        setStatus(status: { code: number; message?: string }) {
          span.status = status;
          return this;
        },
        recordException(error: Error) {
          span.exceptions.push(error);
        },
        end() {
          span.ended = true;
        },
      };
    },
  };

  return { tracer, spans };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOTelSink", () => {
  let tracer: OTelTracer;
  let spans: RecordedSpan[];

  beforeEach(() => {
    const mock = createMockTracer();
    tracer = mock.tracer;
    spans = mock.spans;
  });

  describe("request lifecycle", () => {
    it("creates a span on request.start and ends it on request.end", () => {
      const sink = createOTelSink(tracer);

      sink.emit({
        type: "request.start",
        timestamp: 0,
        method: "GET",
        pathname: "/blog",
        transaction: "match",
        isPartial: false,
      });

      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("rango.request");
      expect(span.attributes["http.method"]).toBe("GET");
      expect(span.attributes["http.route"]).toBe("/blog");
      expect(span.attributes["rango.transaction"]).toBe("match");
      expect(span.attributes["rango.is_partial"]).toBe(false);
      expect(span.ended).toBe(false);

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

      expect(span.ended).toBe(true);
      expect(span.attributes["rango.duration_ms"]).toBe(50);
      expect(span.attributes["rango.segment_count"]).toBe(3);
      expect(span.attributes["rango.cache.hit"]).toBe(false);
      expect(span.status).toEqual({ code: 1 });
    });

    it("records error and ends span on request.error", () => {
      const sink = createOTelSink(tracer);
      const error = new Error("handler exploded");

      sink.emit({
        type: "request.start",
        timestamp: 0,
        method: "POST",
        pathname: "/api/submit",
        transaction: "matchPartial",
        isPartial: true,
      });

      sink.emit({
        type: "request.error",
        timestamp: 30,
        method: "POST",
        pathname: "/api/submit",
        transaction: "matchPartial",
        error,
        phase: "action",
        durationMs: 30,
      });

      const span = spans[0]!;
      expect(span.ended).toBe(true);
      expect(span.exceptions).toEqual([error]);
      expect(span.status).toEqual({ code: 2, message: "handler exploded" });
      expect(span.attributes["rango.phase"]).toBe("action");
      expect(span.attributes["rango.duration_ms"]).toBe(30);
    });

    it("handles concurrent requests to different paths", () => {
      const sink = createOTelSink(tracer);

      sink.emit({
        type: "request.start",
        timestamp: 0,
        method: "GET",
        pathname: "/a",
        transaction: "match",
        isPartial: false,
      });
      sink.emit({
        type: "request.start",
        timestamp: 1,
        method: "GET",
        pathname: "/b",
        transaction: "match",
        isPartial: false,
      });

      expect(spans).toHaveLength(2);
      expect(spans[0]!.ended).toBe(false);
      expect(spans[1]!.ended).toBe(false);

      // End /b first
      sink.emit({
        type: "request.end",
        timestamp: 10,
        method: "GET",
        pathname: "/b",
        transaction: "match",
        durationMs: 9,
        segmentCount: 1,
        cacheHit: true,
      });

      expect(spans[0]!.ended).toBe(false);
      expect(spans[1]!.ended).toBe(true);

      // End /a
      sink.emit({
        type: "request.end",
        timestamp: 20,
        method: "GET",
        pathname: "/a",
        transaction: "match",
        durationMs: 20,
        segmentCount: 2,
        cacheHit: false,
      });

      expect(spans[0]!.ended).toBe(true);
    });

    it("correlates concurrent same-path requests via requestId", () => {
      const sink = createOTelSink(tracer);

      // Two concurrent GET /blog requests with different requestIds
      sink.emit({
        type: "request.start",
        timestamp: 0,
        requestId: "req-1",
        method: "GET",
        pathname: "/blog",
        transaction: "match",
        isPartial: false,
      });
      sink.emit({
        type: "request.start",
        timestamp: 1,
        requestId: "req-2",
        method: "GET",
        pathname: "/blog",
        transaction: "match",
        isPartial: false,
      });

      expect(spans).toHaveLength(2);

      // End req-1 first (out of LIFO order — would fail without requestId keying)
      sink.emit({
        type: "request.end",
        timestamp: 15,
        requestId: "req-1",
        method: "GET",
        pathname: "/blog",
        transaction: "match",
        durationMs: 15,
        segmentCount: 3,
        cacheHit: false,
      });

      // req-1 span ended, req-2 still open
      expect(spans[0]!.ended).toBe(true);
      expect(spans[0]!.attributes["rango.segment_count"]).toBe(3);
      expect(spans[1]!.ended).toBe(false);

      // End req-2
      sink.emit({
        type: "request.end",
        timestamp: 25,
        requestId: "req-2",
        method: "GET",
        pathname: "/blog",
        transaction: "match",
        durationMs: 24,
        segmentCount: 5,
        cacheHit: true,
      });

      expect(spans[1]!.ended).toBe(true);
      expect(spans[1]!.attributes["rango.segment_count"]).toBe(5);
    });

    it("correlates concurrent same-path loaders via requestId", () => {
      const sink = createOTelSink(tracer);

      // Two concurrent loaders with the same segment/path but different requestIds
      sink.emit({
        type: "loader.start",
        timestamp: 0,
        requestId: "req-1",
        segmentId: "L0D0.productList",
        loaderName: "productList",
        pathname: "/products",
      });
      sink.emit({
        type: "loader.start",
        timestamp: 1,
        requestId: "req-2",
        segmentId: "L0D0.productList",
        loaderName: "productList",
        pathname: "/products",
      });

      expect(spans).toHaveLength(2);

      // End req-1's loader first (out of LIFO order)
      sink.emit({
        type: "loader.end",
        timestamp: 8,
        requestId: "req-1",
        segmentId: "L0D0.productList",
        loaderName: "productList",
        pathname: "/products",
        durationMs: 8,
        ok: true,
      });

      expect(spans[0]!.ended).toBe(true);
      expect(spans[0]!.attributes["rango.duration_ms"]).toBe(8);
      expect(spans[1]!.ended).toBe(false);

      // End req-2's loader
      sink.emit({
        type: "loader.end",
        timestamp: 12,
        requestId: "req-2",
        segmentId: "L0D0.productList",
        loaderName: "productList",
        pathname: "/products",
        durationMs: 11,
        ok: true,
      });

      expect(spans[1]!.ended).toBe(true);
      expect(spans[1]!.attributes["rango.duration_ms"]).toBe(11);
    });
  });

  describe("loader lifecycle", () => {
    it("creates a span on loader.start and ends it on loader.end", () => {
      const sink = createOTelSink(tracer);

      sink.emit({
        type: "loader.start",
        timestamp: 5,
        segmentId: "L0D0.userLoader",
        loaderName: "userLoader",
        pathname: "/profile",
      });

      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("rango.loader");
      expect(span.attributes["rango.segment_id"]).toBe("L0D0.userLoader");
      expect(span.attributes["rango.loader_name"]).toBe("userLoader");
      expect(span.attributes["http.route"]).toBe("/profile");
      expect(span.ended).toBe(false);

      sink.emit({
        type: "loader.end",
        timestamp: 15,
        segmentId: "L0D0.userLoader",
        loaderName: "userLoader",
        pathname: "/profile",
        durationMs: 10,
        ok: true,
      });

      expect(span.ended).toBe(true);
      expect(span.attributes["rango.duration_ms"]).toBe(10);
      expect(span.attributes["rango.loader.ok"]).toBe(true);
      expect(span.status).toEqual({ code: 1 });
    });

    it("records error on loader.error with matching start", () => {
      const sink = createOTelSink(tracer);
      const error = new Error("DB connection lost");

      sink.emit({
        type: "loader.start",
        timestamp: 0,
        segmentId: "L0D0.dbLoader",
        loaderName: "dbLoader",
        pathname: "/data",
      });

      sink.emit({
        type: "loader.error",
        timestamp: 5,
        segmentId: "L0D0.dbLoader",
        loaderName: "dbLoader",
        pathname: "/data",
        error,
        handledByBoundary: true,
      });

      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.ended).toBe(true);
      expect(span.exceptions).toEqual([error]);
      expect(span.attributes["rango.handled_by_boundary"]).toBe(true);
      expect(span.status).toEqual({ code: 2, message: "DB connection lost" });
    });

    it("creates standalone span for loader.error without matching start", () => {
      const sink = createOTelSink(tracer);
      const error = new Error("validation failed");

      sink.emit({
        type: "loader.error",
        timestamp: 0,
        segmentId: "L0D0.validator",
        loaderName: "validator",
        pathname: "/form",
        error,
        handledByBoundary: false,
      });

      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.name).toBe("rango.loader");
      expect(span.ended).toBe(true);
      expect(span.exceptions).toEqual([error]);
      expect(span.attributes["rango.handled_by_boundary"]).toBe(false);
    });

    it("handles failed loader with ok=false via loader.end", () => {
      const sink = createOTelSink(tracer);

      sink.emit({
        type: "loader.start",
        timestamp: 0,
        segmentId: "L0D0.apiLoader",
        loaderName: "apiLoader",
        pathname: "/api",
      });

      sink.emit({
        type: "loader.end",
        timestamp: 10,
        segmentId: "L0D0.apiLoader",
        loaderName: "apiLoader",
        pathname: "/api",
        durationMs: 10,
        ok: false,
      });

      const span = spans[0]!;
      expect(span.status).toEqual({ code: 2 });
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
      expect(span.attributes["http.route"]).toBe("/blog");
      expect(span.attributes["rango.route_key"]).toBe("blog");
      expect(span.attributes["rango.cache.hit"]).toBe(true);
      expect(span.attributes["rango.cache.should_revalidate"]).toBe(false);
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

      const span = spans[0]!;
      expect(span.attributes["rango.cache.source"]).toBeUndefined();
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
      expect(span.attributes["rango.segment_id"]).toBe("L0");
      expect(span.attributes["http.route"]).toBe("/dashboard");
      expect(span.attributes["rango.route_key"]).toBe("dashboard");
      expect(span.attributes["rango.revalidate"]).toBe(true);
    });
  });

  describe("integration: full request with loaders and decisions", () => {
    it("produces correct spans for a realistic request flow", () => {
      const sink = createOTelSink(tracer);

      // 1. Request starts
      sink.emit({
        type: "request.start",
        timestamp: 0,
        method: "GET",
        pathname: "/products",
        transaction: "matchPartial",
        isPartial: true,
      });

      // 2. Cache decision
      sink.emit({
        type: "cache.decision",
        timestamp: 1,
        pathname: "/products",
        routeKey: "products",
        hit: false,
        shouldRevalidate: false,
      });

      // 3. Revalidation decisions
      sink.emit({
        type: "revalidation.decision",
        timestamp: 2,
        segmentId: "L0",
        pathname: "/products",
        routeKey: "products",
        shouldRevalidate: true,
      });

      // 4. Loader starts and completes
      sink.emit({
        type: "loader.start",
        timestamp: 3,
        segmentId: "L0D0.productList",
        loaderName: "productList",
        pathname: "/products",
      });
      sink.emit({
        type: "loader.end",
        timestamp: 13,
        segmentId: "L0D0.productList",
        loaderName: "productList",
        pathname: "/products",
        durationMs: 10,
        ok: true,
      });

      // 5. Request ends
      sink.emit({
        type: "request.end",
        timestamp: 20,
        method: "GET",
        pathname: "/products",
        transaction: "matchPartial",
        durationMs: 20,
        segmentCount: 4,
        cacheHit: false,
      });

      // Verify span count: request + cache + revalidation + loader = 4
      expect(spans).toHaveLength(4);

      const requestSpan = spans.find((s) => s.name === "rango.request")!;
      const cacheSpan = spans.find((s) => s.name === "rango.cache.decision")!;
      const revalSpan = spans.find(
        (s) => s.name === "rango.revalidation.decision",
      )!;
      const loaderSpan = spans.find((s) => s.name === "rango.loader")!;

      // All spans ended
      expect(requestSpan.ended).toBe(true);
      expect(cacheSpan.ended).toBe(true);
      expect(revalSpan.ended).toBe(true);
      expect(loaderSpan.ended).toBe(true);

      // Request span has final attributes
      expect(requestSpan.attributes["rango.segment_count"]).toBe(4);
      expect(requestSpan.status).toEqual({ code: 1 });

      // Loader span has duration
      expect(loaderSpan.attributes["rango.duration_ms"]).toBe(10);
      expect(loaderSpan.attributes["rango.loader.ok"]).toBe(true);

      // Cache and revalidation are instant spans with correct attributes
      expect(cacheSpan.attributes["rango.cache.hit"]).toBe(false);
      expect(revalSpan.attributes["rango.revalidate"]).toBe(true);
    });
  });
});
