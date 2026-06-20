/**
 * Fast unit smoke for the redirect Flight response onError wiring
 * (createRedirectFlightResponse in handler.ts).
 *
 * createRedirectFlightResponse is the redirect short-circuit for partial
 * requests: fetch auto-follows 3xx, so a redirect is sent as a 200 Flight
 * payload carrying { redirect, locationState } instead of an HTTP 3xx. If the
 * locationState carries a value React Flight cannot serialize, the
 * renderToReadableStream stream errors. Every other RSC render path routes
 * that failure through callOnError(..., "rendering", ...) so a consumer's
 * createRouter({ onError }) observes it; this path used to swallow it.
 *
 * This mock fires the onError callback synchronously to prove the wiring
 * (callback -> callOnError -> router.onError with phase "rendering"). It does
 * NOT exercise real async Flight serialization or ALS retention across the
 * await -- that is what the dev+prod e2e adds. Keep this as the fast complement.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const serializationError = new Error("Flight cannot serialize this value");

// renderToReadableStream fires onError, mimicking a serialization failure on
// the redirect payload. The stream contents are irrelevant for this test.
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  renderToReadableStream: (
    _payload: unknown,
    options?: { onError?: (error: unknown) => void },
  ) => {
    options?.onError?.(serializationError);
    return new ReadableStream();
  },
  decodeReply: vi.fn(),
  createTemporaryReferenceSet: vi.fn(() => new Set()),
  loadServerAction: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
}));

// Manifest is always "available" so the handler does not short-circuit.
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

// Drive the partial-redirect short-circuit (handler.ts plan.mode === "redirect"
// with _rsc_partial): resolveRoute returns a redirect so classifyRequest yields
// mode "redirect" and the handler calls createRedirectFlightResponse.
vi.mock("../../router/route-snapshot.js", () => ({
  resolveRoute: vi.fn(async () => ({
    type: "redirect",
    redirectTo: "/destination",
  })),
}));

vi.mock("../nonce.js", () => ({
  generateNonce: () => undefined,
  nonce: Symbol("nonce"),
}));

vi.mock("../manifest-init.js", () => ({
  buildRouterTrieFromUrlpatterns: vi.fn(),
}));

vi.mock("../../router/telemetry.js", () => ({
  resolveSink: () => null,
  safeEmit: vi.fn(),
}));

vi.mock("../../router/router-context.js", () => ({
  getRouterContext: () => null,
}));

import { createRSCHandler } from "../handler.js";
import type { RangoInternal } from "../../router/router-interfaces.js";

function createRedirectRouter(
  onError: (...args: any[]) => void,
): RangoInternal<unknown, any> {
  return {
    id: "test-router",
    basename: undefined,
    middleware: [],
    onError,
    timeouts: { renderStartMs: 30000, actionMs: 30000 },
    findMatch: vi.fn(() => null),
    previewMatch: vi.fn(async () => null),
    match: vi.fn(async () => null),
    matchPartial: vi.fn(async () => null),
    matchError: vi.fn(async () => null),
    notFound: undefined,
    rootLayout: undefined,
    themeConfig: undefined,
    warmupEnabled: false,
  } as any;
}

describe("redirect Flight response onError wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes a redirect-payload serialization failure to onError with phase rendering", async () => {
    const onError = vi.fn();
    const router = createRedirectRouter(onError);
    const handler = createRSCHandler({ router });

    // _rsc_partial + text/x-component -> partial-redirect short-circuit, which
    // calls createRedirectFlightResponse -> renderToReadableStream (mocked to
    // fire onError). The response still succeeds (200); the failure is only
    // observable through the router's onError, which is the point of the fix.
    const request = new Request("https://example.com/start?_rsc_partial=1", {
      headers: { accept: "text/x-component" },
    });

    const response = await handler(request, { env: {} });
    expect(response.status).toBe(200);

    expect(onError).toHaveBeenCalledTimes(1);
    const errorContext = onError.mock.calls[0]![0] as {
      error: unknown;
      phase: string;
    };
    expect(errorContext.error).toBe(serializationError);
    expect(errorContext.phase).toBe("rendering");
  });
});
