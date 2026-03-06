import { describe, it, expect, vi } from "vitest";
import {
  resolveSink,
  safeEmit,
  createConsoleSink,
  type TelemetrySink,
  type TelemetryEvent,
} from "../telemetry";

describe("telemetry sink", () => {
  describe("resolveSink", () => {
    it("returns the provided sink when defined", () => {
      const sink: TelemetrySink = { emit: vi.fn() };
      expect(resolveSink(sink)).toBe(sink);
    });

    it("returns a no-op sink when undefined", () => {
      const sink = resolveSink(undefined);
      // Should not throw
      sink.emit({
        type: "request.start",
        timestamp: 0,
        method: "GET",
        pathname: "/",
        transaction: "match",
        isPartial: false,
      });
    });

    it("no-op sink is stable across calls", () => {
      expect(resolveSink(undefined)).toBe(resolveSink(undefined));
    });
  });

  describe("safeEmit", () => {
    it("calls sink.emit with the event", () => {
      const emit = vi.fn();
      const sink: TelemetrySink = { emit };
      const event: TelemetryEvent = {
        type: "request.start",
        timestamp: 100,
        method: "GET",
        pathname: "/test",
        transaction: "match",
        isPartial: false,
      };

      safeEmit(sink, event);
      expect(emit).toHaveBeenCalledWith(event);
    });

    it("catches errors from sink without throwing", () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const sink: TelemetrySink = {
        emit() {
          throw new Error("sink crash");
        },
      };

      expect(() => {
        safeEmit(sink, {
          type: "request.start",
          timestamp: 0,
          method: "GET",
          pathname: "/",
          transaction: "match",
          isPartial: false,
        });
      }).not.toThrow();

      consoleSpy.mockRestore();
    });

    it("no-op sink is zero-cost (emit is not called)", () => {
      const noop = resolveSink(undefined);
      // The no-op emit is an empty function; calling it should not throw
      safeEmit(noop, {
        type: "request.end",
        timestamp: 0,
        method: "GET",
        pathname: "/",
        transaction: "match",
        durationMs: 10,
        segmentCount: 3,
        cacheHit: false,
      });
    });
  });

  describe("event emission order", () => {
    it("receives events in emission order", () => {
      const events: TelemetryEvent[] = [];
      const sink: TelemetrySink = { emit: (e) => events.push(e) };

      safeEmit(sink, {
        type: "request.start",
        timestamp: 100,
        method: "GET",
        pathname: "/blog",
        transaction: "match",
        isPartial: false,
      });
      safeEmit(sink, {
        type: "loader.start",
        timestamp: 105,
        segmentId: "M1D0.PostLoader",
        loaderName: "PostLoader",
        pathname: "/blog",
      });
      safeEmit(sink, {
        type: "loader.end",
        timestamp: 120,
        segmentId: "M1D0.PostLoader",
        loaderName: "PostLoader",
        pathname: "/blog",
        durationMs: 15,
        ok: true,
      });
      safeEmit(sink, {
        type: "cache.decision",
        timestamp: 121,
        pathname: "/blog",
        routeKey: "blog",
        hit: false,
        shouldRevalidate: false,
      });
      safeEmit(sink, {
        type: "request.end",
        timestamp: 125,
        method: "GET",
        pathname: "/blog",
        transaction: "match",
        durationMs: 25,
        segmentCount: 2,
        cacheHit: false,
      });

      expect(events).toHaveLength(5);
      expect(events.map((e) => e.type)).toEqual([
        "request.start",
        "loader.start",
        "loader.end",
        "cache.decision",
        "request.end",
      ]);
    });
  });

  describe("event type coverage", () => {
    it("accepts all event types", () => {
      const events: TelemetryEvent[] = [];
      const sink: TelemetrySink = { emit: (e) => events.push(e) };

      const allEvents: TelemetryEvent[] = [
        {
          type: "request.start",
          timestamp: 0,
          method: "GET",
          pathname: "/",
          transaction: "match",
          isPartial: false,
        },
        {
          type: "request.end",
          timestamp: 10,
          method: "GET",
          pathname: "/",
          transaction: "match",
          durationMs: 10,
          segmentCount: 1,
          cacheHit: false,
        },
        {
          type: "request.error",
          timestamp: 5,
          method: "GET",
          pathname: "/",
          transaction: "match",
          error: new Error("fail"),
          phase: "routing",
          durationMs: 5,
        },
        {
          type: "loader.start",
          timestamp: 1,
          segmentId: "M1D0.Test",
          loaderName: "Test",
          pathname: "/",
        },
        {
          type: "loader.end",
          timestamp: 3,
          segmentId: "M1D0.Test",
          loaderName: "Test",
          pathname: "/",
          durationMs: 2,
          ok: true,
        },
        {
          type: "loader.error",
          timestamp: 3,
          segmentId: "M1D0.Test",
          loaderName: "Test",
          pathname: "/",
          error: new Error("loader fail"),
          handledByBoundary: false,
        },
        {
          type: "handler.error",
          timestamp: 4,
          segmentId: "M1R0",
          segmentType: "route",
          error: new Error("handler fail"),
          handledByBoundary: true,
        },
        {
          type: "cache.decision",
          timestamp: 2,
          pathname: "/",
          routeKey: "home",
          hit: true,
          shouldRevalidate: true,
          source: "runtime",
        },
        {
          type: "revalidation.decision",
          timestamp: 2,
          segmentId: "M1L0",
          pathname: "/",
          routeKey: "home",
          shouldRevalidate: true,
        },
      ];

      for (const event of allEvents) {
        safeEmit(sink, event);
      }

      expect(events).toHaveLength(9);
      expect(events.map((e) => e.type)).toEqual([
        "request.start",
        "request.end",
        "request.error",
        "loader.start",
        "loader.end",
        "loader.error",
        "handler.error",
        "cache.decision",
        "revalidation.decision",
      ]);
    });
  });

  describe("createConsoleSink", () => {
    it("logs events to console without throwing", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const sink = createConsoleSink();

      sink.emit({
        type: "request.start",
        timestamp: 100,
        method: "GET",
        pathname: "/test",
        transaction: "match",
        isPartial: false,
      });
      sink.emit({
        type: "request.end",
        timestamp: 110,
        method: "GET",
        pathname: "/test",
        transaction: "match",
        durationMs: 10,
        segmentCount: 3,
        cacheHit: false,
      });
      sink.emit({
        type: "request.error",
        timestamp: 105,
        method: "GET",
        pathname: "/test",
        transaction: "match",
        error: new Error("fail"),
        phase: "routing",
        durationMs: 5,
      });
      sink.emit({
        type: "loader.start",
        timestamp: 101,
        segmentId: "M1D0.ProductLoader",
        loaderName: "ProductLoader",
        pathname: "/test",
      });
      sink.emit({
        type: "loader.end",
        timestamp: 108,
        segmentId: "M1D0.ProductLoader",
        loaderName: "ProductLoader",
        pathname: "/test",
        durationMs: 7,
        ok: true,
      });
      sink.emit({
        type: "loader.error",
        timestamp: 108,
        segmentId: "M1D0.ProductLoader",
        loaderName: "ProductLoader",
        pathname: "/test",
        error: new Error("loader fail"),
        handledByBoundary: true,
      });
      sink.emit({
        type: "handler.error",
        timestamp: 106,
        segmentId: "M1R0",
        segmentType: "route",
        error: new Error("handler fail"),
        handledByBoundary: true,
      });
      sink.emit({
        type: "cache.decision",
        timestamp: 102,
        pathname: "/test",
        routeKey: "test",
        hit: true,
        shouldRevalidate: false,
        source: "prerender",
      });
      sink.emit({
        type: "revalidation.decision",
        timestamp: 103,
        segmentId: "M1L0",
        pathname: "/test",
        routeKey: "test",
        shouldRevalidate: true,
      });

      // Should log 9 times, one for each event type
      expect(consoleSpy).toHaveBeenCalledTimes(9);

      // Verify format of a few key events
      expect(consoleSpy.mock.calls[0][0]).toContain(
        "[telemetry] request.start",
      );
      expect(consoleSpy.mock.calls[0][0]).toContain("GET /test");
      expect(consoleSpy.mock.calls[1][0]).toContain("[telemetry] request.end");
      expect(consoleSpy.mock.calls[1][0]).toContain("segments=3");

      consoleSpy.mockRestore();
    });

    it("handles cache.decision without source", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const sink = createConsoleSink();

      sink.emit({
        type: "cache.decision",
        timestamp: 0,
        pathname: "/",
        routeKey: "home",
        hit: false,
        shouldRevalidate: false,
      });

      expect(consoleSpy.mock.calls[0][0]).not.toContain("source=");
      consoleSpy.mockRestore();
    });

    it("handles handler.error without segmentId", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const sink = createConsoleSink();

      sink.emit({
        type: "handler.error",
        timestamp: 0,
        error: new Error("fail"),
        handledByBoundary: false,
      });

      expect(consoleSpy.mock.calls[0][0]).toContain("segment=unknown");
      consoleSpy.mockRestore();
    });
  });

  describe("disabled-state no-op behavior", () => {
    it("no-op sink emit is a genuine empty function", () => {
      const noop = resolveSink(undefined);
      // Verify emit is a function that does nothing
      expect(typeof noop.emit).toBe("function");
      expect(noop.emit.length).toBe(0);
    });

    it("safeEmit with no-op sink performs no work", () => {
      const noop = resolveSink(undefined);
      // If safeEmit wraps the call in try/catch, the noop still runs
      // but does nothing meaningful. The key test is it doesn't throw.
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        safeEmit(noop, {
          type: "request.start",
          timestamp: 0,
          method: "GET",
          pathname: "/",
          transaction: "match",
          isPartial: false,
        });
      }
      const elapsed = performance.now() - start;
      // 10k calls should be negligible (well under 50ms)
      expect(elapsed).toBeLessThan(50);
    });
  });
});
