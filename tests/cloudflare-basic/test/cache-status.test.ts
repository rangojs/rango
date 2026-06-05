import { describe, expect, it } from "vitest";
import {
  assertCacheStatus,
  createCacheSink,
  filterCacheDecisions,
  parseCacheHeader,
} from "@rangojs/router/testing";

// The cache-status primitives. The HEADER path (assertCacheStatus on a real
// response) and telemetry capture both require a RUNNING app with the debug
// gate on (createRouter({ debugCacheSignal: true }) or RANGO_TEST_SIGNALS=1) and
// the full RSC render path — `dispatch` does not emit cache decisions, and the
// full app router cannot be imported in bare vitest (see test/FINDINGS.md). So
// the end-to-end hit/miss/stale assertions live in the e2e suite; here we pin
// the pure, runtime-free pieces a consumer relies on.
describe("cache-status primitives (pure pieces)", () => {
  describe("parseCacheHeader", () => {
    it("parses a multi-segment X-Rango-Cache value (keys are route NAMES)", () => {
      expect(parseCacheHeader("product.detail=hit, layout=stale")).toEqual({
        "product.detail": "hit",
        layout: "stale",
      });
    });

    it("tolerates whitespace and ignores malformed entries", () => {
      expect(
        parseCacheHeader("  home = miss ,, blog=,=stale, products=hit"),
      ).toEqual({
        home: "miss",
        products: "hit",
      });
    });

    it("returns an empty map for null/empty", () => {
      expect(parseCacheHeader(null)).toEqual({});
      expect(parseCacheHeader("")).toEqual({});
    });
  });

  describe("assertCacheStatus", () => {
    it("passes when the header reports the expected status", () => {
      // The segment key is the route NAME, exactly as the header carries it.
      const res = new Response(null, {
        headers: { "X-Rango-Cache": "product.detail=hit" },
      });
      expect(() =>
        assertCacheStatus(res, "product.detail", "hit"),
      ).not.toThrow();
    });

    it("throws a clear error when the segment status differs", () => {
      const res = new Response(null, {
        headers: { "X-Rango-Cache": "product.detail=miss" },
      });
      expect(() => assertCacheStatus(res, "product.detail", "hit")).toThrow(
        /expected "hit" but got "miss"/,
      );
    });

    it("throws a 'header missing' directive when the gate is off (no header)", () => {
      const res = new Response(null);
      expect(() => assertCacheStatus(res, "home", "hit")).toThrow(
        /no X-Rango-Cache header/,
      );
    });
  });

  describe("createCacheSink + filterCacheDecisions", () => {
    it("captures emitted telemetry events and filters to cache.decision", () => {
      const { sink, events } = createCacheSink();
      sink.emit({
        type: "cache.decision",
        routeKey: "product.detail",
      } as never);
      sink.emit({ type: "request.start" } as never);
      sink.emit({ type: "cache.decision", routeKey: "layout" } as never);

      expect(events).toHaveLength(3);
      const decisions = filterCacheDecisions(events);
      expect(decisions).toHaveLength(2);
      expect(
        decisions.map((d) => (d as { routeKey: string }).routeKey),
      ).toEqual(["product.detail", "layout"]);
    });
  });
});
