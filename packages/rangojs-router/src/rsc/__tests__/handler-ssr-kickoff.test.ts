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
      return Promise.resolve([{}, "stream"]);
    },
  };
});

vi.mock("../../route-map-builder.js", async () =>
  (await import("./handler-mock-factories.js")).routeMapBuilderMock(),
);
vi.mock("@vitejs/plugin-rsc/rsc/server", async () =>
  (await import("./handler-mock-factories.js")).pluginRscMock(),
);
vi.mock("@vitejs/plugin-rsc/rsc/client", async () =>
  (await import("./handler-mock-factories.js")).pluginRscMock(),
);
vi.mock("../nonce.js", async () =>
  (await import("./handler-mock-factories.js")).nonceMock(),
);
vi.mock("../manifest-init.js", async () =>
  (await import("./handler-mock-factories.js")).manifestInitMock(),
);

// Unlike the shared manifestMock, no responseType: routes default to render so
// per-test loadManifest overrides pick response vs render classification.
vi.mock("../../router/manifest.js", () => ({
  loadManifest: vi.fn(async () => ({
    type: "route",
    shortCode: "R0",
    parent: null,
    handler: vi.fn(),
  })),
  clearManifestCache: vi.fn(),
}));

vi.mock("../../router/middleware.js", async (importOriginal) =>
  (await import("./handler-mock-factories.js")).middlewareMock(importOriginal),
);
vi.mock("../../cache/cache-scope.js", async () =>
  (await import("./handler-mock-factories.js")).cacheScopeMock(),
);
vi.mock("../response-route-handler.js", async () =>
  (await import("./handler-mock-factories.js")).responseRouteMock(),
);
vi.mock("../../router/telemetry.js", async () =>
  (await import("./handler-mock-factories.js")).telemetryMock(),
);
vi.mock("../../router/router-context.js", async () =>
  (await import("./handler-mock-factories.js")).routerContextMock(),
);

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
    const waitUntil = vi.fn();

    // The handler will throw downstream because rendering isn't fully mocked,
    // but startSSRSetup runs before the error. Assert findMatch was reached
    // to confirm the negative path tests aren't passing due to an early crash.
    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/", {
      headers: { accept: "text/html" },
    });

    try {
      await handler(request, {
        env: {},
        ctx: { waitUntil } as any,
      });
    } catch {
      // Expected — downstream rendering isn't fully mocked
    }

    expect(router.findMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  // A full-document request with NO Accept header is a generic client
  // (missing Accept ≡ */* per RFC 9110) and renders the HTML document —
  // flight is explicit-opt-in only (acceptsFlightExplicitly, ssr-setup.ts).
  // SSR setup must kick off for it. (This flipped with the opt-in rule: the
  // old Accept heuristic treated a missing Accept as RSC, so the D7
  // orphan-rejection concern — a wasted, unconsumed SSR Promise.all — applied
  // here. It now applies only to explicit flight requests, below.)
  it("starts SSR setup for a no-Accept request (renders HTML)", async () => {
    const router = createMockRouter();
    const waitUntil = vi.fn();

    const handler = createRSCHandler({ router });
    const request = new Request("https://example.com/");

    try {
      await handler(request, {
        env: {},
        ctx: { waitUntil } as any,
      });
    } catch {
      // Expected — downstream rendering isn't fully mocked
    }

    expect(router.findMatch).toHaveBeenCalled();
    expect(startSSRSetupSpy).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  // D7: an explicit flight request renders RSC at render time, so an early
  // SSR setup would be wasted and its unconsumed Promise.all can reject
  // (orphan rejection). The handler must NOT kick off SSR setup for it.
  it("does NOT start SSR setup for RSC-only requests (explicit Accept: text/x-component)", async () => {
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
