/**
 * Handler-level integration test verifying that response/mime routes
 * never trigger early SSR setup after previewMatch().
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
import type { RSCRouterInternal } from "../../router/router-interfaces.js";

function createMockRouter(
  previewResult: Record<string, unknown> | null = null,
): RSCRouterInternal<unknown, any> {
  return {
    id: "test-router",
    middleware: [],
    timeouts: { renderStartMs: 30000, actionMs: 30000 },
    previewMatch: vi.fn(async () => previewResult),
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
    const router = createMockRouter({
      responseType: "json",
      handler: () => ({ ok: true }),
      params: {},
    });

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/api/data");

    await handler(request, { env: {} });

    expect(router.previewMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).not.toHaveBeenCalled();
  });

  it("does NOT start SSR setup for negotiated response routes", async () => {
    const router = createMockRouter({
      responseType: "json",
      handler: () => ({ data: [1, 2, 3] }),
      params: {},
      negotiated: true,
    });

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/products", {
      headers: { accept: "application/json" },
    });

    await handler(request, { env: {} });

    expect(router.previewMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).not.toHaveBeenCalled();
  });

  it("starts SSR setup for normal HTML page requests", async () => {
    const router = createMockRouter(null);

    // The handler will throw downstream because rendering isn't fully mocked,
    // but startSSRSetup runs before the error. Assert previewMatch was reached
    // to confirm the negative path tests aren't passing due to an early crash.
    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/");

    try {
      await handler(request, { env: {} });
    } catch {
      // Expected — downstream rendering isn't fully mocked
    }

    expect(router.previewMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).toHaveBeenCalledOnce();
  });

  it("does NOT start SSR setup for RSC-only requests (Accept without text/html)", async () => {
    const router = createMockRouter(null);

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/", {
      headers: { accept: "text/x-component" },
    });

    try {
      await handler(request, { env: {} });
    } catch {
      // Expected — downstream rendering isn't fully mocked
    }

    // Verify previewMatch was reached — the negative assertion is from
    // mayNeedSSR classification, not an early crash.
    expect(router.previewMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).not.toHaveBeenCalled();
  });
});
