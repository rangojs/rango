/**
 * Shared vi.mock preamble for handler-level tests (createRSCHandler with the
 * manifest/middleware/response-route dependency surface stubbed out). Import
 * for side effects BEFORE any import that (transitively) loads ../handler.js:
 *
 *   import "./handler-test-mocks.js";
 *   import { createRSCHandler } from "../handler.js";
 *
 * vi.mock is NOT hoisted outside a test file, so registration here relies on
 * this module evaluating before the mocked modules load — which ESM import
 * order guarantees as long as this import statement comes first. Mock paths
 * resolve relative to THIS file, so it must stay in src/rsc/__tests__/.
 *
 * The same preamble exists inline (pre-dating this module) in
 * handler-metrics.test.ts, handler-telemetry-events.test.ts,
 * handler-ssr-kickoff.test.ts, redirect-flight-onerror.test.ts, and
 * handler-notfound-payload.test.ts — migrate them here when touched.
 */
import { vi } from "vitest";

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
