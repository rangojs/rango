/**
 * Handler-level integration tests verifying that metrics finalization
 * (Server-Timing header, handler:total, middleware :pre/:post) runs
 * after middleware has fully completed, including intercepted redirects.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Mock route-map-builder so manifest is always available.
vi.mock("../../route-map-builder.js", () => ({
  hasCachedManifest: () => true,
  waitForManifestReady: () => null,
  getRouterManifest: () => ({ home: "/" }),
  getRouterTrie: () => null,
  getGlobalRouteMap: () => ({ home: "/" }),
  isRouteRootScoped: () => false,
}));

// Mock @vitejs/plugin-rsc/rsc with minimal stubs
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  renderToReadableStream: () => new ReadableStream(),
  decodeReply: vi.fn(),
  createTemporaryReferenceSet: vi.fn(() => new Set()),
  loadServerAction: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
}));

vi.mock("../nonce.js", () => ({
  generateNonce: () => undefined,
  nonce: Symbol("nonce"),
}));

vi.mock("../manifest-init.js", () => ({
  buildRouterTrieFromUrlpatterns: vi.fn(),
}));

// Mock dependencies used by classifyRequest → resolveRoute
vi.mock("../../router/manifest.js", () => ({
  loadManifest: vi.fn(async () => ({
    type: "route",
    shortCode: "R0",
    parent: null,
    handler: vi.fn(),
    responseType: "json",
  })),
  clearManifestCache: vi.fn(),
}));

vi.mock("../../router/middleware.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../router/middleware.js")>();
  return {
    ...actual,
    collectRouteMiddleware: vi.fn(() => []),
  };
});

vi.mock("../../cache/cache-scope.js", () => ({
  createCacheScope: vi.fn(() => null),
}));

// handleResponseRoute returns a simple response for response-route tests
vi.mock("../response-route-handler.js", () => ({
  handleResponseRoute: vi.fn(
    async () => new Response("response-route", { status: 200 }),
  ),
}));

vi.mock("../../router/telemetry.js", () => ({
  resolveSink: () => null,
  safeEmit: vi.fn(),
  getRequestId: () => "test-req-id",
}));

vi.mock("../../router/router-context.js", () => ({
  getRouterContext: () => null,
}));

import { createRSCHandler } from "../handler.js";
import { getRequestContext } from "../../server/request-context.js";
import type { RangoInternal } from "../../router/router-interfaces.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createMockRouter(
  overrides: Partial<RangoInternal<unknown, any>> = {},
): RangoInternal<unknown, any> {
  return {
    id: "test-router",
    middleware: [],
    timeouts: { renderStartMs: 30000, actionMs: 30000 },
    debugPerformance: true,
    findMatch: vi.fn(() => ({
      entry: {},
      routeKey: "test",
      params: {},
      responseType: "json",
    })),
    previewMatch: vi.fn(async () => null),
    match: vi.fn(async () => ({
      segments: [],
      matched: [],
      diff: [],
      params: {},
    })),
    matchError: vi.fn(async () => null),
    rootLayout: undefined,
    themeConfig: undefined,
    warmupEnabled: false,
    ...overrides,
  } as any;
}

describe("handler metrics finalization", () => {
  it("includes handler:total in Server-Timing header", async () => {
    const router = createMockRouter();
    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(request, { env: {} });

    const timing = response.headers.get("Server-Timing") ?? "";
    expect(timing).toContain("handler-total");
  });

  it("includes middleware :pre and :post metrics in Server-Timing", async () => {
    async function slowPost(_ctx: any, next: any) {
      await next();
      const start = performance.now();
      while (performance.now() - start < 1) {
        /* busy wait above 0.01ms threshold */
      }
    }

    const router = createMockRouter({
      middleware: [
        {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: slowPost,
        },
      ],
    });

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(request, { env: {} });

    const timing = response.headers.get("Server-Timing") ?? "";
    // :pre becomes -pre and :post becomes -post in Server-Timing names
    expect(timing).toContain("-pre");
    expect(timing).toContain("-post");
    expect(timing).toContain("handler-total");
  });

  it("attaches Server-Timing to intercepted partial redirects", async () => {
    // Middleware short-circuits with a redirect; _rsc_partial causes the
    // handler to intercept it into a flight response. Server-Timing must
    // still be set on the intercepted response.
    async function redirectMw() {
      return new Response(null, {
        status: 302,
        headers: { Location: "/other" },
      });
    }

    const router = createMockRouter({
      middleware: [
        {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: redirectMw,
        },
      ],
    });

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/?_rsc_partial=1", {
      headers: { accept: "text/x-component" },
    });

    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(request, { env: {} });

    const timing = response.headers.get("Server-Timing") ?? "";
    expect(timing).toContain("handler-total");
  });

  it("ctx.debugPerformance() activates full timeline when router option is false", async () => {
    async function enablePerf(ctx: any, next: any) {
      ctx.debugPerformance();
      await next();
    }

    const router = createMockRouter({
      debugPerformance: false,
      middleware: [
        {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: enablePerf,
        },
      ],
    });

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    const response = await handler(request, { env: {} });

    const timing = response.headers.get("Server-Timing") ?? "";

    // handler:total and middleware :pre must appear in Server-Timing
    expect(timing).toContain("handler-total");
    expect(timing).toContain("-pre");

    // Console timeline must be printed (header line + axis + at least 1 row)
    expect(logs.some((l) => l.includes("[RSC Perf]"))).toBe(true);

    // handler:total row must not show a negative start
    const handlerLine = logs.find((l) => l.includes("handler:total"));
    expect(handlerLine).toBeDefined();
    const match = handlerLine!.match(/^\s*(-?\d+\.\d+)ms/);
    expect(match).toBeDefined();
    expect(parseFloat(match![1])).toBeGreaterThanOrEqual(0);
  });

  it("ctx.debugPerformance() called after next() misses upstream metrics", async () => {
    async function lateEnable(ctx: any, next: any) {
      await next();
      ctx.debugPerformance();
    }

    const router = createMockRouter({
      debugPerformance: false,
      middleware: [
        {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: lateEnable,
        },
      ],
    });

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(request, { env: {} });

    const timing = response.headers.get("Server-Timing") ?? "";
    // handler:total is appended after middleware completes, so it's captured
    expect(timing).toContain("handler-total");
    // But the store didn't exist when middleware ran, so middleware :pre
    // is NOT captured (match "d1-" prefix used for depth-1 middleware metrics)
    expect(timing).not.toMatch(/d1-.*-pre/);
  });

  it("emits bootstrap Server-Timing entries without debugPerformance", async () => {
    const router = createMockRouter({ debugPerformance: false });
    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    const response = await handler(request, { env: {} });

    const timing = response.headers.get("Server-Timing") ?? "";
    // Bootstrap entries are always collected (handler-nonce, handler-ctx-create, etc.)
    expect(timing).toContain("handler-");
    // But handler-total is a debug metric, so it should NOT appear
    expect(timing).not.toContain("handler-total");
  });

  it("preserves existing Server-Timing from response routes", async () => {
    // handleResponseRoute is mocked at the top of this file. Override it
    // to return a response with a user-provided Server-Timing header.
    const { handleResponseRoute } =
      await import("../response-route-handler.js");
    vi.mocked(handleResponseRoute).mockResolvedValueOnce(
      new Response("ok", {
        headers: { "Server-Timing": "custom-metric;dur=42.00" },
      }),
    );

    const router = createMockRouter();
    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(request, { env: {} });

    const timing = response.headers.get("Server-Timing") ?? "";
    // User-provided metric must survive
    expect(timing).toContain("custom-metric;dur=42.00");
    // Handler metrics are appended alongside
    expect(timing).toContain("handler-total");
  });

  it("mid-request debugPerformance store anchors :pre to a non-negative offset", async () => {
    // Regression for the mid-request metrics-store offset: ctx.debugPerformance()
    // must anchor its store to the true request entry (the threaded
    // _handlerStart), NOT the opt-in moment. The middleware executor captures
    // each middleware's :pre metricStart BEFORE the handler runs; if the store's
    // requestStart were the opt-in time (after a pre-next() delay) the :pre would
    // land at a NEGATIVE offset. The busy-wait widens that gap so the pre-change
    // anchor is clearly negative and this assertion is red-before-green.
    const captured: {
      metrics?: Array<{ label: string; startTime: number }>;
    } = {};
    async function perfMw(ctx: any, next: any) {
      const spinStart = performance.now();
      while (performance.now() - spinStart < 2) {
        /* burn >1ms before opting in */
      }
      ctx.debugPerformance();
      await next();
      captured.metrics = getRequestContext()._metricsStore?.metrics as
        | Array<{ label: string; startTime: number }>
        | undefined;
    }

    const router = createMockRouter({
      debugPerformance: false,
      middleware: [
        { pattern: null, regex: null, paramNames: [], handler: perfMw },
      ],
    });

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    vi.spyOn(console, "log").mockImplementation(() => {});

    await handler(request, { env: {} });

    const preMetric = captured.metrics?.find((m) => m.label.endsWith(":pre"));
    expect(preMetric).toBeDefined();
    // Anchored to _handlerStart the :pre start is a real positive offset; under
    // the opt-in-time anchor it was negative (metricStart predates the opt-in).
    expect(preMetric!.startTime).toBeGreaterThanOrEqual(0);
  });
});
