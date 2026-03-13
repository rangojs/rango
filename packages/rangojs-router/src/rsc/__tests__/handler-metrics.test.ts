/**
 * Handler-level integration tests verifying that metrics finalization
 * (Server-Timing header, handler:total, middleware :pre/:post) runs
 * after middleware has fully completed, including intercepted redirects.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Mock route-map-builder so manifest is always available.
vi.mock("../../route-map-builder.js", () => ({
  hasCachedManifest: () => true,
  getRouteTrie: () => null,
  getPrecomputedEntries: () => undefined,
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

// handleResponseRoute returns a simple response for response-route tests
vi.mock("../response-route-handler.js", () => ({
  handleResponseRoute: vi.fn(
    async () => new Response("response-route", { status: 200 }),
  ),
}));

vi.mock("../../router/telemetry.js", () => ({
  resolveSink: () => null,
  safeEmit: vi.fn(),
}));

vi.mock("../../router/router-context.js", () => ({
  getRouterContext: () => null,
}));

import { createRSCHandler } from "../handler.js";
import type { RSCRouterInternal } from "../../router/router-interfaces.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Preview result that triggers the response-route short-circuit. */
const RESPONSE_ROUTE_PREVIEW = {
  responseType: "json",
  handler: () => ({ ok: true }),
  params: {},
};

function createMockRouter(
  overrides: Partial<RSCRouterInternal<unknown, any>> = {},
): RSCRouterInternal<unknown, any> {
  return {
    id: "test-router",
    middleware: [],
    timeouts: { renderStartMs: 30000, actionMs: 30000 },
    debugPerformance: true,
    previewMatch: vi.fn(async () => RESPONSE_ROUTE_PREVIEW),
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
          mountPrefix: null,
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
          mountPrefix: null,
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

  it("produces non-negative handler:total with late ctx.debugPerformance()", async () => {
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
          mountPrefix: null,
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
    expect(timing).toContain("handler-total");

    // handler:total row in the console timeline must not show a negative start
    const handlerLine = logs.find((l) => l.includes("handler:total"));
    expect(handlerLine).toBeDefined();
    const match = handlerLine!.match(/^\s*(-?\d+\.\d+)ms/);
    expect(match).toBeDefined();
    expect(parseFloat(match![1])).toBeGreaterThanOrEqual(0);
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
});
