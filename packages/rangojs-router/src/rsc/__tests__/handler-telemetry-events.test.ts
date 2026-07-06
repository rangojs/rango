/**
 * Handler-level telemetry integration tests verifying that discrete lifecycle
 * events emitted OUTSIDE the match() RouterContext ALS (request.timeout,
 * request.origin-rejected) reach a configured TelemetrySink through the real
 * createRSCHandler.
 *
 * Unlike handler-metrics.test.ts, this file deliberately does NOT mock
 * ../../router/telemetry.js or ../../router/router-context.js — those two mocks
 * are exactly what hides the "event never reaches the sink" bug: the real
 * getRouterContext() throws outside runWithRouterContext (only entered inside
 * match()/matchPartial()), so an observeEvent() call at the handler level
 * silently swallows the event.
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

// Mock dependencies used by classifyRequest → resolveRoute. loadManifest
// defaults to a response route (responseType: "json") for case A; case B
// overrides it per-call with mockResolvedValueOnce to a plain render route.
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

// Never resolves — forces the render-start timeout to fire in case A.
vi.mock("../response-route-handler.js", () => ({
  handleResponseRoute: vi.fn(() => new Promise<Response>(() => {})),
}));

import { createRSCHandler } from "../handler.js";
import { getRequestContext } from "../../server/request-context.js";
import type { RangoInternal } from "../../router/router-interfaces.js";
import type { TelemetryEvent } from "../../router/telemetry.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createMockRouter(
  overrides: Partial<RangoInternal<unknown, any>> = {},
): RangoInternal<unknown, any> {
  return {
    id: "test-router",
    middleware: [],
    timeouts: { renderStartMs: 20, actionMs: 20 },
    debugPerformance: false,
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

describe("handler telemetry events reach the sink outside the match ALS", () => {
  it("case A: request.timeout reaches the configured sink", async () => {
    const events: TelemetryEvent[] = [];
    const spySink = { emit: (e: TelemetryEvent) => events.push(e) };

    const router = createMockRouter({ telemetry: spySink } as any);
    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(request, { env: {} });
    expect(response.status).toBe(504);

    const timeoutEvents = events.filter((e) => e.type === "request.timeout");
    expect(timeoutEvents.length).toBeGreaterThan(0);
    const e = timeoutEvents[0] as Extract<
      TelemetryEvent,
      { type: "request.timeout" }
    >;
    expect(e.phase).toBe("render-start");
    expect(e.customHandler).toBe(false);
    expect(typeof e.durationMs).toBe("number");
    expect(typeof e.requestId).toBe("string");
  });

  it("case B: request.origin-rejected reaches the configured sink", async () => {
    const events: TelemetryEvent[] = [];
    const spySink = { emit: (e: TelemetryEvent) => events.push(e) };

    // Plain render route (no responseType) so classification reaches loader
    // mode, whose origin phase is "loader"; the origin guard then rejects.
    const { loadManifest } = await import("../../router/manifest.js");
    vi.mocked(loadManifest).mockResolvedValueOnce({
      type: "route",
      shortCode: "R0",
      parent: null,
      handler: undefined,
      responseType: undefined,
    } as any);

    const router = createMockRouter({
      telemetry: spySink,
      originCheck: () => false,
      findMatch: vi.fn(() => ({
        entry: {},
        routeKey: "test",
        params: {},
      })),
    } as any);
    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/data?_rsc_loader=1", {
      headers: { origin: "https://evil.com" },
    });

    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(request, { env: {} });
    expect(response.status).toBe(403);

    const originEvents = events.filter(
      (e) => e.type === "request.origin-rejected",
    );
    expect(originEvents.length).toBeGreaterThan(0);
    const e = originEvents[0] as Extract<
      TelemetryEvent,
      { type: "request.origin-rejected" }
    >;
    expect(e.origin).toBe("https://evil.com");
    expect(e.phase).toBe("loader");
    expect(e.method).toBe("GET");
    expect(e.pathname).toBe("/data");
  });

  it("case C: late-handle handler.error reaches the configured sink", async () => {
    const events: TelemetryEvent[] = [];
    const spySink = { emit: (e: TelemetryEvent) => events.push(e) };

    // A response-route handler that forces a LATE handle push: it drives the
    // request's real _handleStore to completion (seal -> drain stream() so
    // `completed` flips true), then push()es. push() on a completed store throws
    // LateHandlePushError AND fires store.onError — the leg wired inside
    // executeRequest (handler.ts ~794). That onError runs at the HANDLER level,
    // OUTSIDE the match() RouterContext ALS, so an observeEvent() call there would
    // silently swallow the event (getRouterContext() throws outside match); only
    // safeEmit(resolveSink(router.telemetry), ...) reaches the configured sink.
    const { handleResponseRoute } =
      await import("../response-route-handler.js");
    vi.mocked(handleResponseRoute).mockImplementationOnce(async () => {
      const store = getRequestContext()._handleStore;
      store.seal();
      const it = store.stream();
      // Drain the stream so `completed` flips true (see handle-store.ts stream()).
      while (!(await it.next()).done) {
        /* drain */
      }
      try {
        store.push("late", "seg-1", { v: 1 });
      } catch {
        // LateHandlePushError is expected — push() rethrows after firing onError.
      }
      return new Response("ok", { status: 200 });
    });

    // Generous timeouts so the setTimeout(0) drain never trips the render-start
    // deadline on a slow CI runner.
    const router = createMockRouter({
      telemetry: spySink,
      timeouts: { renderStartMs: 5000, actionMs: 5000 },
    } as any);
    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(request, { env: {} });
    expect(response.status).toBe(200);

    const handlerErrors = events.filter((e) => e.type === "handler.error");
    expect(handlerErrors.length).toBeGreaterThan(0);
    const e = handlerErrors[0] as Extract<
      TelemetryEvent,
      { type: "handler.error" }
    >;
    expect(e.handledByBoundary).toBe(true);
    expect(typeof e.requestId).toBe("string");
  });
});
