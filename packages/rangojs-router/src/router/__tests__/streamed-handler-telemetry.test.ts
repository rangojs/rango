import { describe, it, expect, vi, afterEach } from "vitest";
import { runWithRouterContext } from "../router-context";
import {
  resolveSegment,
  resolveParallelEntry,
  resolveParallelSegmentsWithRevalidation,
  resolveOrphanLayoutWithRevalidation,
} from "../segment-resolution";
import type { TelemetrySink, TelemetryEvent } from "../telemetry";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createContext(pathname = "/test") {
  const request = new Request(`https://example.com${pathname}`);
  return {
    params: { slug: "hello" },
    request,
    searchParams: new URLSearchParams(),
    pathname,
    url: new URL(request.url),
    env: {},
    var: {},
    get: () => undefined,
    set: () => {},
    header: () => {},
    status: () => {},
    html: () => new Response(""),
    json: () => new Response(""),
    text: () => new Response(""),
    redirect: () => new Response(""),
    notFound: () => {
      throw new Error("notFound not implemented");
    },
    use: vi.fn(),
  } as any;
}

function createDeps() {
  return {
    wrapLoaderPromise: vi.fn(),
    trackHandler: vi.fn((p: Promise<any>) => p),
    findNearestErrorBoundary: () => undefined,
    findNearestNotFoundBoundary: () => undefined,
    callOnError: vi.fn(),
  } as any;
}

function createRouteEntry(handler: any) {
  return {
    id: "test-route",
    type: "route",
    shortCode: "R0",
    handler,
    loading: "loading-fallback",
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
  } as any;
}

function createParallelEntry(handler: any) {
  return {
    id: "test.sidebar",
    type: "parallel",
    shortCode: "L0P0",
    handler: { "@sidebar": handler },
    loading: "sidebar-loading",
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
  } as any;
}

function createLayoutEntry(parallelEntries: any[]) {
  return {
    id: "test.layout",
    type: "layout",
    shortCode: "L0",
    handler: "layout",
    loading: "layout-loading",
    loader: [],
    layout: [],
    parallel: parallelEntries,
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
  } as any;
}

function collectEvents(events: TelemetryEvent[]): TelemetrySink {
  return { emit: (e) => events.push(e) };
}

function minimalRouterCtx(telemetry?: TelemetrySink) {
  return {
    telemetry,
    resolveAllSegments: vi.fn(),
    resolveAllSegmentsWithRevalidation: vi.fn(),
    findInterceptForRoute: () => null,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamed handler telemetry (handler.error emission)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fresh path — resolveSegment", () => {
    it("emits handler.error when a streamed route handler rejects", async () => {
      const events: TelemetryEvent[] = [];
      const sink = collectEvents(events);
      const ctx = createContext("/blog");
      const deps = createDeps();
      const handlerError = new Error("route handler boom");
      const entry = createRouteEntry(() => Promise.reject(handlerError));

      await runWithRouterContext(minimalRouterCtx(sink), async () => {
        const segments = await resolveSegment(
          entry,
          "blog",
          { slug: "hello" },
          ctx,
          new Map(),
          deps,
        );

        // The component is the rejecting promise (streamed, not awaited)
        const routeSeg = segments.find((s) => s.type === "route");
        expect(routeSeg).toBeDefined();
        expect(routeSeg!.component).toBeInstanceOf(Promise);

        // Let the .catch() handler run
        await new Promise((r) => setTimeout(r, 10));
      });

      const handlerEvents = events.filter((e) => e.type === "handler.error");
      expect(handlerEvents).toHaveLength(1);
      const evt = handlerEvents[0] as any;
      expect(evt.segmentId).toBe("R0");
      expect(evt.segmentType).toBe("route");
      expect(evt.error.message).toBe("route handler boom");
      expect(evt.handledByBoundary).toBe(true);
      expect(evt.pathname).toBe("/blog");
      expect(evt.routeKey).toBe("blog");
      expect(evt.params).toEqual({ slug: "hello" });
    });

    it("does not emit handler.error when telemetry is not configured", async () => {
      const ctx = createContext("/blog");
      const deps = createDeps();
      const entry = createRouteEntry(() => Promise.reject(new Error("boom")));

      await runWithRouterContext(minimalRouterCtx(undefined), async () => {
        const segments = await resolveSegment(
          entry,
          "blog",
          {},
          ctx,
          new Map(),
          deps,
        );
        const routeSeg = segments.find((s) => s.type === "route");
        expect(routeSeg).toBeDefined();
        // Let any potential .catch() run
        await new Promise((r) => setTimeout(r, 10));
      });
      // No crash — the key assertion is that we reach here without error
    });
  });

  describe("fresh path — resolveParallelEntry", () => {
    it("emits handler.error when a streamed parallel slot handler rejects", async () => {
      const events: TelemetryEvent[] = [];
      const sink = collectEvents(events);
      const ctx = createContext("/blog");
      const deps = createDeps();
      const slotError = new Error("sidebar boom");
      const parallelEntry = createParallelEntry(() =>
        Promise.reject(slotError),
      );

      await runWithRouterContext(minimalRouterCtx(sink), async () => {
        const segments = await resolveParallelEntry(
          parallelEntry,
          { slug: "hello" },
          ctx,
          false,
          "L0",
          deps,
          undefined,
          "blog",
        );

        const parallelSeg = segments.find((s) => s.type === "parallel");
        expect(parallelSeg).toBeDefined();
        expect(parallelSeg!.component).toBeInstanceOf(Promise);

        await new Promise((r) => setTimeout(r, 10));
      });

      const handlerEvents = events.filter((e) => e.type === "handler.error");
      expect(handlerEvents).toHaveLength(1);
      const evt = handlerEvents[0] as any;
      expect(evt.segmentId).toBe("L0.@sidebar");
      expect(evt.segmentType).toBe("parallel");
      expect(evt.error.message).toBe("sidebar boom");
      expect(evt.handledByBoundary).toBe(true);
      expect(evt.pathname).toBe("/blog");
      expect(evt.routeKey).toBe("blog");
      expect(evt.params).toEqual({ slug: "hello" });
    });
  });

  describe("revalidation path — resolveParallelSegmentsWithRevalidation", () => {
    it("emits handler.error when a streamed parallel slot handler rejects", async () => {
      const events: TelemetryEvent[] = [];
      const sink = collectEvents(events);
      const ctx = createContext("/blog");
      const deps = createDeps();
      const slotError = new Error("revalidation sidebar boom");
      const parallelEntry = createParallelEntry(() =>
        Promise.reject(slotError),
      );
      const layoutEntry = createLayoutEntry([parallelEntry]);

      await runWithRouterContext(minimalRouterCtx(sink), async () => {
        const result = await resolveParallelSegmentsWithRevalidation(
          layoutEntry,
          { slug: "hello" },
          ctx,
          false,
          new Set<string>(),
          {},
          ctx.request,
          ctx.url,
          ctx.url,
          "blog",
          deps,
        );

        const parallelSeg = result.segments.find((s) => s.type === "parallel");
        expect(parallelSeg).toBeDefined();
        expect(parallelSeg!.component).toBeInstanceOf(Promise);

        await new Promise((r) => setTimeout(r, 10));
      });

      const handlerEvents = events.filter((e) => e.type === "handler.error");
      expect(handlerEvents).toHaveLength(1);
      const evt = handlerEvents[0] as any;
      expect(evt.segmentId).toBe("L0.@sidebar");
      expect(evt.segmentType).toBe("parallel");
      expect(evt.error.message).toBe("revalidation sidebar boom");
      expect(evt.handledByBoundary).toBe(true);
      expect(evt.routeKey).toBe("blog");
    });
  });

  describe("revalidation path — resolveOrphanLayoutWithRevalidation", () => {
    it("emits handler.error when a streamed orphan-parallel slot handler rejects", async () => {
      const events: TelemetryEvent[] = [];
      const sink = collectEvents(events);
      const ctx = createContext("/blog");
      const deps = createDeps();
      const slotError = new Error("orphan sidebar boom");
      const orphan = {
        id: "test.orphan",
        type: "layout",
        shortCode: "L1",
        handler: "layout",
        loading: "layout-loading",
        loader: [],
        layout: [],
        parallel: [createParallelEntry(() => Promise.reject(slotError))],
        intercept: [],
        middleware: [],
        revalidate: [],
        errorBoundary: [],
        notFoundBoundary: [],
      } as any;

      await runWithRouterContext(minimalRouterCtx(sink), async () => {
        const result = await resolveOrphanLayoutWithRevalidation(
          orphan,
          { slug: "hello" },
          ctx,
          new Set<string>(),
          {},
          ctx.request,
          ctx.url,
          ctx.url,
          "blog",
          new Map(),
          false,
          deps,
        );

        const parallelSeg = result.segments.find((s) => s.type === "parallel");
        expect(parallelSeg).toBeDefined();
        expect(parallelSeg!.component).toBeInstanceOf(Promise);

        await new Promise((r) => setTimeout(r, 10));
      });

      const handlerEvents = events.filter((e) => e.type === "handler.error");
      expect(handlerEvents).toHaveLength(1);
      const evt = handlerEvents[0] as any;
      // Orphan parallels use the orphan's shortCode as prefix
      expect(evt.segmentId).toBe("L1.@sidebar");
      expect(evt.segmentType).toBe("parallel");
      expect(evt.error.message).toBe("orphan sidebar boom");
      expect(evt.handledByBoundary).toBe(true);
      expect(evt.routeKey).toBe("blog");
    });
  });

  describe("context fields", () => {
    it("includes pathname, routeKey, and params in the event", async () => {
      const events: TelemetryEvent[] = [];
      const sink = collectEvents(events);
      const ctx = createContext("/products/42");
      const deps = createDeps();
      const entry = createRouteEntry(() =>
        Promise.reject(new Error("context test")),
      );

      await runWithRouterContext(minimalRouterCtx(sink), async () => {
        await resolveSegment(
          entry,
          "products.detail",
          { id: "42" },
          ctx,
          new Map(),
          deps,
        );
        await new Promise((r) => setTimeout(r, 10));
      });

      const evt = events.find((e) => e.type === "handler.error") as any;
      expect(evt).toBeDefined();
      expect(evt.pathname).toBe("/products/42");
      expect(evt.routeKey).toBe("products.detail");
      expect(evt.params).toEqual({ id: "42" });
    });
  });
});
