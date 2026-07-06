/**
 * Tests that createMatchContextForFull reuses the RouteSnapshot classifyRequest
 * already resolved (recorded on requestContext._classifiedRoute), so a document
 * request resolves the route EXACTLY ONCE instead of re-running findMatch +
 * loadManifest. Reuse is gated on the snapshot's recorded isSSR flag: the full
 * (document/SSR) path only reuses an isSSR:true snapshot; the partial path only
 * reuses a non-isSSR one. HMR discards the snapshot and re-resolves fresh.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../manifest.js", () => ({
  loadManifest: vi.fn(async () => ({
    type: "route",
    shortCode: "R0",
    routeKey: "product.detail",
    parent: null,
    cache: null,
  })),
  clearManifestCache: vi.fn(),
}));

vi.mock("../middleware.js", () => ({
  collectRouteMiddleware: vi.fn(() => []),
}));

vi.mock("../handler-context.js", () => ({
  createHandlerContext: vi.fn(() => ({})),
  stripInternalParams: vi.fn((url: URL) => url),
}));

vi.mock("../loader-resolution.js", () => ({
  setupLoaderAccess: vi.fn(),
}));

vi.mock("../pattern-matching.js", () => ({
  traverseBack: vi.fn(() => []),
}));

vi.mock("../../server/context", () => ({
  getContext: vi.fn(() => ({
    getOrCreateStore: vi.fn(() => ({
      run: (fn: any) => fn(),
      namespace: null,
      parent: null,
    })),
    runWithStore: vi.fn((_s: any, _ns: any, _p: any, fn: any) => fn()),
  })),
  EntryData: {},
  LoaderEntry: {},
  InterceptSelectorContext: {},
}));

vi.mock("../../server/request-context.js", () => ({
  getRequestContext: vi.fn(),
  _getRequestContext: vi.fn(),
  setRequestContextPrevRouteKey: vi.fn(),
}));

vi.mock("../logging.js", () => ({
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
}));

vi.mock("../../cache/cache-scope.js", () => ({
  CacheScope: vi.fn(),
  createCacheScope: vi.fn(() => null),
  // Identity pass-through: these tests exercise snapshot reuse, not the shell
  // fast path's implicit scope substitution (covered in shell-fast-path.test.ts).
  resolveShellImplicitCacheScope: vi.fn((scope) => scope),
}));

vi.mock("../error-handling.js", () => ({
  createErrorInfo: vi.fn(),
  createErrorSegment: vi.fn(),
  findNearestErrorBoundary: vi.fn(() => null),
}));

vi.mock("../../default-error-boundary.js", () => ({
  DefaultErrorFallback: vi.fn(),
}));

vi.mock("../../errors", () => ({
  RouteNotFoundError: class extends Error {},
  invariant: vi.fn(),
}));

import {
  createMatchContextForFull,
  createMatchContextForPartial,
} from "../match-api.js";
import { loadManifest, clearManifestCache } from "../manifest.js";
import { _getRequestContext } from "../../server/request-context.js";
import type { MatchApiDeps } from "../types.js";

const mockLoadManifest = vi.mocked(loadManifest);
const mockClearManifestCache = vi.mocked(clearManifestCache);
const mockGetReqCtx = vi.mocked(_getRequestContext);

function makeDeps(overrides?: Partial<MatchApiDeps<unknown>>): MatchApiDeps {
  return {
    findMatch: vi.fn(() => ({
      params: {},
      route: "product.detail",
      routeKey: "product.detail",
      entry: {},
    })),
    getMetricsStore: vi.fn(() => undefined),
    findInterceptForRoute: vi.fn(() => null),
    callOnError: vi.fn(),
    findNearestErrorBoundary: vi.fn(() => null),
    getRouteMap: vi.fn(() => ({})),
    ...overrides,
  } as unknown as MatchApiDeps;
}

function makeSnapshot(overrides?: Record<string, any>) {
  return {
    matched: { entry: {}, routeKey: "product.detail", params: {} },
    manifestEntry: {
      type: "route",
      shortCode: "R0",
      routeKey: "product.detail",
      parent: null,
    },
    entries: [],
    routeKey: "product.detail",
    localRouteName: "detail",
    params: {},
    routeMiddleware: [],
    cacheScope: null,
    isPassthrough: false,
    isSSR: true,
    ...overrides,
  } as any;
}

function makeCtx(classifiedRoute: any) {
  const url = new URL("https://example.com/product/1");
  return {
    url,
    originalUrl: new URL("https://example.com/product/1"),
    _classifiedRoute: classifiedRoute,
  } as any;
}

function request() {
  return new Request("https://example.com/product/1");
}

describe("createMatchContextForFull classified-snapshot reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadManifest.mockResolvedValue({
      type: "route",
      shortCode: "R0",
      routeKey: "product.detail",
      parent: null,
      cache: null,
    } as any);
  });

  it("reuses an isSSR:true classified snapshot without re-resolving (exactly once)", async () => {
    const deps = makeDeps();
    mockGetReqCtx.mockReturnValue(makeCtx(makeSnapshot({ isSSR: true })));

    const result = await createMatchContextForFull(
      request(),
      {},
      deps,
      deps.findInterceptForRoute,
    );

    // Reuse path: no second findMatch / loadManifest for the current route.
    expect(deps.findMatch).not.toHaveBeenCalled();
    expect(mockLoadManifest).not.toHaveBeenCalled();
    expect("type" in result && (result as any).type === "redirect").toBe(false);
    expect((result as any).routeKey).toBe("product.detail");
  });

  it("does NOT reuse an isSSR:false snapshot on the full path (fresh resolve)", async () => {
    const deps = makeDeps();
    mockGetReqCtx.mockReturnValue(makeCtx(makeSnapshot({ isSSR: false })));

    await createMatchContextForFull(
      request(),
      {},
      deps,
      deps.findInterceptForRoute,
    );

    // A partial-mode snapshot is not reusable for a document render — the full
    // path re-resolves with isSSR:true.
    expect(deps.findMatch).toHaveBeenCalledTimes(1);
    expect(mockLoadManifest).toHaveBeenCalledTimes(1);
    expect(mockLoadManifest.mock.calls[0][4]).toBe(true); // isSSR arg
  });

  it("does NOT reuse when there is no classified snapshot (fresh resolve)", async () => {
    const deps = makeDeps();
    mockGetReqCtx.mockReturnValue(makeCtx(undefined));

    await createMatchContextForFull(
      request(),
      {},
      deps,
      deps.findInterceptForRoute,
    );

    expect(deps.findMatch).toHaveBeenCalledTimes(1);
    expect(mockLoadManifest).toHaveBeenCalledTimes(1);
  });

  it("discards the snapshot and re-resolves on HMR (X-RSC-HMR)", async () => {
    const deps = makeDeps();
    mockGetReqCtx.mockReturnValue(makeCtx(makeSnapshot({ isSSR: true })));

    const hmrRequest = new Request("https://example.com/product/1", {
      headers: { "X-RSC-HMR": "1" },
    });

    await createMatchContextForFull(
      hmrRequest,
      {},
      deps,
      deps.findInterceptForRoute,
    );

    expect(mockClearManifestCache).toHaveBeenCalledTimes(1);
    // Fresh resolve despite an isSSR:true snapshot being present.
    expect(deps.findMatch).toHaveBeenCalledTimes(1);
    expect(mockLoadManifest).toHaveBeenCalledTimes(1);
  });
});

describe("createMatchContextForPartial classified-snapshot reuse guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadManifest.mockResolvedValue({
      type: "route",
      shortCode: "R0",
      routeKey: "product.detail",
      parent: null,
      cache: null,
    } as any);
  });

  it("reuses a non-isSSR snapshot (no loadManifest for the current route)", async () => {
    const deps = makeDeps();
    mockGetReqCtx.mockReturnValue(makeCtx(makeSnapshot({ isSSR: false })));

    await createMatchContextForPartial(
      request(),
      {},
      deps,
      deps.findInterceptForRoute,
    );

    // Reused: no loadManifest for the current route (resolveNavigation may still
    // call findMatch for the previous route, so we assert on loadManifest only).
    expect(mockLoadManifest).not.toHaveBeenCalled();
  });

  it("does NOT reuse an isSSR:true snapshot on the partial path (fresh resolve)", async () => {
    const deps = makeDeps();
    mockGetReqCtx.mockReturnValue(makeCtx(makeSnapshot({ isSSR: true })));

    await createMatchContextForPartial(
      request(),
      {},
      deps,
      deps.findInterceptForRoute,
    );

    // An isSSR:true (full-render) snapshot is not reusable for a partial render.
    expect(mockLoadManifest).toHaveBeenCalledTimes(1);
    expect(mockLoadManifest.mock.calls[0][4]).toBe(false); // isSSR arg
  });
});
