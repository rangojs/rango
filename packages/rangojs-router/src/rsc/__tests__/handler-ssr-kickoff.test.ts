/**
 * Handler-level integration test verifying that response/mime routes
 * never trigger early SSR setup after request classification.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Spy on startSSRSetup before importing the handler
const startSSRSetupSpy = vi.fn();
vi.mock("../ssr-setup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ssr-setup.js")>();
  return {
    ...actual,
    startSSRSetup: (...args: unknown[]) => {
      startSSRSetupSpy(...args);
      return actual.startSSRSetup(
        ...(args as Parameters<typeof actual.startSSRSetup>),
      );
    },
  };
});

// Mock route-map-builder so manifest is always available.
// Also provides getGlobalRouteMap/isRouteRootScoped used by request-context.
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

// Mock the nonce module
vi.mock("../nonce.js", () => ({
  generateNonce: () => undefined,
  nonce: Symbol("nonce"),
}));

// Mock manifest-init to avoid Vite-specific imports
vi.mock("../manifest-init.js", () => ({
  buildRouterTrieFromUrlpatterns: vi.fn(),
}));

// Mock manifest loading used by resolveRoute (inside classifyRequest)
vi.mock("../../router/manifest.js", () => ({
  loadManifest: vi.fn(async () => ({
    type: "route",
    shortCode: "R0",
    parent: null,
    handler: vi.fn(),
  })),
  clearManifestCache: vi.fn(),
}));

// Mock middleware collection used by resolveRoute
vi.mock("../../router/middleware.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../router/middleware.js")>();
  return {
    ...actual,
    collectRouteMiddleware: vi.fn(() => []),
  };
});

// Mock cache-scope used by resolveRoute
vi.mock("../../cache/cache-scope.js", () => ({
  createCacheScope: vi.fn(() => null),
}));

// Mock response-route-handler to return a simple response
vi.mock("../response-route-handler.js", () => ({
  handleResponseRoute: vi.fn(
    async () => new Response("response-route", { status: 200 }),
  ),
}));

// Mock telemetry to avoid ALS dependency
vi.mock("../../router/telemetry.js", () => ({
  resolveSink: () => null,
  safeEmit: vi.fn(),
}));

// Mock router-context
vi.mock("../../router/router-context.js", () => ({
  getRouterContext: () => null,
}));

import { createRSCHandler } from "../handler.js";
import type { RangoInternal } from "../../router/router-interfaces.js";

function createMockRouter(
  matchOverrides?: Record<string, unknown>,
): RangoInternal<unknown, any> {
  return {
    id: "test-router",
    middleware: [],
    timeouts: { renderStartMs: 30000, actionMs: 30000 },
    findMatch: vi.fn(() => ({
      entry: {},
      routeKey: "test",
      params: {},
      ...matchOverrides,
    })),
    previewMatch: vi.fn(async () => null),
    match: vi.fn(async () => ({
      segments: [],
      matched: [],
      diff: [],
    })),
    matchError: vi.fn(async () => null),
    rootLayout: undefined,
    themeConfig: undefined,
    warmupEnabled: false,
  } as any;
}

describe("handler SSR kickoff placement", () => {
  beforeEach(() => {
    startSSRSetupSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT start SSR setup for response/mime routes", async () => {
    const router = createMockRouter({ responseType: "json" });

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    await handler(request, { env: {} });

    expect(router.findMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).not.toHaveBeenCalled();
  });

  it("does NOT start SSR setup for negotiated response routes", async () => {
    const router = createMockRouter({
      responseType: "json",
      negotiateVariants: [
        { routeKey: "products.json", responseType: "application/json" },
      ],
    });

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/products", {
      headers: { accept: "application/json" },
    });

    await handler(request, { env: {} });

    expect(router.findMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).not.toHaveBeenCalled();
  });

  it("starts SSR setup for normal HTML page requests (text/html Accept)", async () => {
    const router = createMockRouter();

    // The handler will throw downstream because rendering isn't fully mocked,
    // but startSSRSetup runs before the error. Assert findMatch was reached
    // to confirm the negative path tests aren't passing due to an early crash.
    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/", {
      headers: { accept: "text/html" },
    });

    try {
      await handler(request, { env: {} });
    } catch {
      // Expected — downstream rendering isn't fully mocked
    }

    expect(router.findMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).toHaveBeenCalledOnce();
  });

  // D7: a full-document request with NO Accept header renders RSC at render
  // time (isRscRequest treats missing Accept as RSC), so the early SSR setup
  // is wasted and its unconsumed Promise.all can reject (orphan rejection).
  // The handler must NOT kick off SSR setup for it.
  it("does NOT start SSR setup for a no-Accept request that returns RSC", async () => {
    const router = createMockRouter();

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/");

    try {
      await handler(request, { env: {} });
    } catch {
      // Expected — downstream rendering isn't fully mocked
    }
    // Settle microtasks so an orphaned SSR setup promise (if any) would surface.
    await Promise.resolve();

    expect(router.findMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).not.toHaveBeenCalled();
  });

  it("does NOT start SSR setup for RSC-only requests (Accept without text/html)", async () => {
    const router = createMockRouter();

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/", {
      headers: { accept: "text/x-component" },
    });

    try {
      await handler(request, { env: {} });
    } catch {
      // Expected — downstream rendering isn't fully mocked
    }

    // Verify findMatch was reached — the negative assertion is from
    // mayNeedSSR classification, not an early crash.
    expect(router.findMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).not.toHaveBeenCalled();
  });
});
