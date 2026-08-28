/**
 * Handler-level test pinning the 404 (not-found) Flight payload shape.
 *
 * buildFullPayload (rsc-rendering.ts) always includes params, resolvedIds, and
 * prefetchCacheTTL on a matched full render. The not-found payload must carry
 * the same fields for shape consistency so the client treats a 404 like any
 * other full render (resolvedIds drives segment cleanup, prefetchCacheTTL keeps
 * the client's prefetch policy intact).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Capture the payload passed to renderToReadableStream so we can inspect the
// not-found payload metadata. The actual stream contents are irrelevant here.
const renderToReadableStreamSpy = vi.fn();
function pluginRscMock() {
  return {
    renderToReadableStream: (payload: unknown) => {
      renderToReadableStreamSpy(payload);
      return new ReadableStream();
    },
    decodeReply: vi.fn(),
    createTemporaryReferenceSet: vi.fn(() => new Set()),
    loadServerAction: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createFromReadableStream: vi.fn(),
    encodeReply: vi.fn(),
    createClientTemporaryReferenceSet: vi.fn(() => ({})),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

vi.mock("../../route-map-builder.js", async () =>
  (await import("./handler-mock-factories.js")).routeMapBuilderMock(),
);
vi.mock("../nonce.js", async () =>
  (await import("./handler-mock-factories.js")).nonceMock(),
);
vi.mock("../manifest-init.js", async () =>
  (await import("./handler-mock-factories.js")).manifestInitMock(),
);
vi.mock("../../router/telemetry.js", async () =>
  (await import("./handler-mock-factories.js")).telemetryMock(),
);
vi.mock("../../router/router-context.js", async () =>
  (await import("./handler-mock-factories.js")).routerContextMock(),
);

import { createRSCHandler } from "../handler.js";
import { RouteNotFoundError } from "../../errors.js";
import type { RangoInternal } from "../../router/router-interfaces.js";

function createNotFoundRouter(): RangoInternal<unknown, any> {
  const notFoundError = new RouteNotFoundError("No route matched for /missing");
  return {
    id: "test-router",
    basename: undefined,
    middleware: [],
    timeouts: { renderStartMs: 30000, actionMs: 30000 },
    // findMatch returns null -> classifyRequest throws RouteNotFoundError ->
    // full-render plan -> match() re-throws -> 404 render path.
    findMatch: vi.fn(() => null),
    previewMatch: vi.fn(async () => null),
    match: vi.fn(async () => {
      throw notFoundError;
    }),
    matchPartial: vi.fn(async () => null),
    matchError: vi.fn(async () => null),
    notFound: undefined,
    rootLayout: undefined,
    themeConfig: undefined,
    warmupEnabled: false,
    prefetchCacheTTL: 4242,
    prefetchCacheSize: 7,
    prefetchConcurrency: 5,
    __devDiscoveryEpoch: 17,
  } as any;
}

describe("not-found Flight payload shape", () => {
  afterEach(() => {
    renderToReadableStreamSpy.mockClear();
    vi.restoreAllMocks();
  });

  it("carries params, resolvedIds, and prefetchCacheTTL like buildFullPayload", async () => {
    const router = createNotFoundRouter();
    const handler = createRSCHandler({ router });
    // text/x-component (no text/html) -> isRscRequest true -> RSC 404 branch,
    // which renders the payload directly without SSR.
    const request = new Request("https://example.com/missing", {
      headers: { accept: "text/x-component" },
    });

    const response = await handler(request, { env: {} });
    expect(response.status).toBe(404);

    expect(renderToReadableStreamSpy).toHaveBeenCalled();
    const payload = renderToReadableStreamSpy.mock.calls.at(-1)![0] as {
      metadata: Record<string, unknown>;
    };

    expect(payload.metadata.params).toEqual({});
    // resolvedIds mirrors the rendered segment list (the single notFound segment).
    expect(payload.metadata.resolvedIds).toEqual(["notFound"]);
    expect(payload.metadata.prefetchCacheTTL).toBe(4242);
    // The 404 payload must carry the client prefetch limits like a matched
    // full render, so prefetch config survives a not-found initial load.
    expect(payload.metadata.prefetchCacheSize).toBe(7);
    expect(payload.metadata.prefetchConcurrency).toBe(5);
    expect(payload.metadata.devDiscoveryEpoch).toBe(17);
  });
});
