/**
 * Pure vi.mock factory bodies for handler-level tests. handler-test-mocks.ts
 * registers the full set as a side-effect preamble; files whose mock surface
 * diverges (spy-instrumented plugin-rsc, deliberately-unmocked telemetry, a
 * manifest without responseType) must NOT import that preamble — they register
 * only the factories they share, via dynamic import so the hoisted vi.mock
 * call never touches an uninitialized binding:
 *
 *   vi.mock("../nonce.js", async () =>
 *     (await import("./handler-mock-factories.js")).nonceMock(),
 *   );
 *
 * No vi.mock calls in this module — importing it must not register anything.
 */
import { vi } from "vitest";

// Manifest is always "available" so the handler does not short-circuit.
export function routeMapBuilderMock(): Record<string, unknown> {
  return {
    hasCachedManifest: () => true,
    waitForManifestReady: () => null,
    getRouterManifest: () => ({ home: "/" }),
    getRouterTrie: () => null,
    getGlobalRouteMap: () => ({ home: "/" }),
    isRouteRootScoped: () => false,
  };
}

// Minimal @vitejs/plugin-rsc stub; register for BOTH /rsc/server and
// /rsc/client (segment-codec imports from both entries), so the shape is the
// union of both: the last three names are the real /rsc/client surface
// (createFromReadableStream, encodeReply, createClientTemporaryReferenceSet)
// — without them a test reaching a cache-deserialize path dies on a module
// link error instead of a meaningful assertion.
export function pluginRscMock(): Record<string, unknown> {
  return {
    renderToReadableStream: () => new ReadableStream(),
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

export function nonceMock(): Record<string, unknown> {
  return {
    generateNonce: () => undefined,
    nonce: Symbol("nonce"),
  };
}

export function manifestInitMock(): Record<string, unknown> {
  return {
    buildRouterTrieFromUrlpatterns: vi.fn(),
  };
}

// Used by classifyRequest -> resolveRoute; responseType "json" classifies
// every route as a response route.
export function manifestMock(): Record<string, unknown> {
  return {
    loadManifest: vi.fn(async () => ({
      type: "route",
      shortCode: "R0",
      parent: null,
      handler: vi.fn(),
      responseType: "json",
    })),
    clearManifestCache: vi.fn(),
  };
}

export async function middlewareMock(
  importOriginal: () => Promise<typeof import("../../router/middleware.js")>,
): Promise<Record<string, unknown>> {
  const actual = await importOriginal();
  return {
    ...actual,
    collectRouteMiddleware: vi.fn(() => []),
  };
}

export function cacheScopeMock(): Record<string, unknown> {
  return {
    createCacheScope: vi.fn(() => null),
  };
}

// handleResponseRoute returns a simple response for response-route tests.
export function responseRouteMock(): Record<string, unknown> {
  return {
    handleResponseRoute: vi.fn(
      async () => new Response("response-route", { status: 200 }),
    ),
  };
}

export function telemetryMock(): Record<string, unknown> {
  return {
    resolveSink: () => null,
    safeEmit: vi.fn(),
    getRequestId: () => "test-req-id",
  };
}

export function routerContextMock(): Record<string, unknown> {
  return {
    getRouterContext: () => null,
  };
}
