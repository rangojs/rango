import { describe, it, expect } from "vitest";
import {
  parseCacheHeader,
  assertCacheStatus,
  createCacheSink,
  filterCacheDecisions,
} from "../cache-status.js";
import type {
  CacheDecisionEvent,
  RequestStartEvent,
} from "../../router/telemetry.js";

describe("parseCacheHeader", () => {
  it("returns an empty map for null/undefined/empty", () => {
    expect(parseCacheHeader(null)).toEqual({});
    expect(parseCacheHeader(undefined)).toEqual({});
    expect(parseCacheHeader("")).toEqual({});
  });

  it("parses a single entry", () => {
    expect(parseCacheHeader("/products/:id=hit")).toEqual({
      "/products/:id": "hit",
    });
  });

  it("parses multiple comma-separated entries", () => {
    expect(parseCacheHeader("/a=hit, /b=stale, /c=miss")).toEqual({
      "/a": "hit",
      "/b": "stale",
      "/c": "miss",
    });
  });

  it("tolerates surrounding whitespace and trailing commas", () => {
    expect(parseCacheHeader("  /a = hit ,  /b=miss ,")).toEqual({
      "/a": "hit",
      "/b": "miss",
    });
  });

  it("ignores malformed entries without a status", () => {
    expect(parseCacheHeader("/a, /b=hit, =miss")).toEqual({ "/b": "hit" });
  });
});

describe("assertCacheStatus", () => {
  function responseWith(headerValue: string): Response {
    return new Response(null, {
      headers: { "X-Rango-Cache": headerValue },
    });
  }

  it("passes when the segment matches the expected status", () => {
    const res = responseWith("/products/:id=hit");
    expect(() => assertCacheStatus(res, "/products/:id", "hit")).not.toThrow();
  });

  it("works against a plain { headers } target", () => {
    const target = { headers: new Headers({ "X-Rango-Cache": "/x=stale" }) };
    expect(() => assertCacheStatus(target, "/x", "stale")).not.toThrow();
  });

  it("throws when the status differs", () => {
    const res = responseWith("/products/:id=miss");
    expect(() => assertCacheStatus(res, "/products/:id", "hit")).toThrow(
      /expected "hit" but got "miss"/,
    );
  });

  it("throws when the segment is absent", () => {
    const res = responseWith("/other=hit");
    expect(() => assertCacheStatus(res, "/products/:id", "hit")).toThrow(
      /not found in X-Rango-Cache/,
    );
  });

  it("throws a clear error when the header is missing (gate off)", () => {
    const res = new Response(null);
    expect(() => assertCacheStatus(res, "/a", "hit")).toThrow(
      /no X-Rango-Cache header/,
    );
  });

  it("distinguishes prerendered and passthrough statuses", () => {
    const res = responseWith("/a=prerendered, /b=passthrough");
    expect(() => assertCacheStatus(res, "/a", "prerendered")).not.toThrow();
    expect(() => assertCacheStatus(res, "/b", "passthrough")).not.toThrow();
  });
});

describe("createCacheSink (telemetry capture path)", () => {
  it("captures emitted events in order", () => {
    const { sink, events } = createCacheSink();
    const start: RequestStartEvent = {
      type: "request.start",
      timestamp: 1,
      method: "GET",
      pathname: "/products/1",
      transaction: "match",
      isPartial: false,
    };
    const decision: CacheDecisionEvent = {
      type: "cache.decision",
      timestamp: 2,
      pathname: "/products/1",
      routeKey: "/products/:id",
      hit: true,
      shouldRevalidate: false,
      source: "runtime",
      segments: [
        {
          id: "/products/:id",
          type: "route",
          cacheStatus: "hit",
          shouldRevalidate: false,
        },
      ],
    };

    sink.emit(start);
    sink.emit(decision);

    expect(events).toHaveLength(2);
    expect(events[0]).toBe(start);
    expect(events[1]).toBe(decision);
  });

  it("filterCacheDecisions extracts cache.decision events with segments", () => {
    const { sink, events } = createCacheSink();
    sink.emit({
      type: "request.start",
      timestamp: 1,
      method: "GET",
      pathname: "/p",
      transaction: "match",
      isPartial: false,
    });
    sink.emit({
      type: "cache.decision",
      timestamp: 2,
      pathname: "/p",
      routeKey: "/p",
      hit: false,
      shouldRevalidate: false,
      segments: [{ id: "/p", type: "route", cacheStatus: "miss" }],
    });

    const decisions = filterCacheDecisions(events);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].segments).toEqual([
      { id: "/p", type: "route", cacheStatus: "miss" },
    ]);
  });

  it("captures a stale (SWR) decision", () => {
    const { sink, events } = createCacheSink();
    sink.emit({
      type: "cache.decision",
      timestamp: 1,
      pathname: "/p",
      routeKey: "/p",
      hit: true,
      shouldRevalidate: true,
      source: "runtime",
      segments: [
        {
          id: "/p",
          type: "route",
          cacheStatus: "stale",
          shouldRevalidate: true,
        },
      ],
    });
    const [decision] = filterCacheDecisions(events);
    expect(decision.segments?.[0].cacheStatus).toBe("stale");
    expect(decision.segments?.[0].shouldRevalidate).toBe(true);
  });
});
