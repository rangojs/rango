/**
 * Tests that matchPartial() correctly wires startRevalidationTrace/
 * flushRevalidationTrace around the pipeline execution.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Enable debug mode
vi.mock("../../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: true,
}));

// Spy on logging functions while keeping real implementations
const startSpy = vi.fn();
const flushSpy = vi.fn();
vi.mock("../logging.js", async (importOriginal) => {
  const real = (await importOriginal()) as any;
  return {
    ...real,
    startRevalidationTrace: (...args: any[]) => {
      startSpy(...args);
      return real.startRevalidationTrace(...args);
    },
    flushRevalidationTrace: (...args: any[]) => {
      flushSpy(...args);
      return real.flushRevalidationTrace(...args);
    },
  };
});

// Mock match-api to return a minimal MatchContext
const mockMatchContext = {
  request: new Request("http://localhost/b"),
  url: new URL("http://localhost/b"),
  pathname: "/b",
  prevUrl: new URL("http://localhost/a"),
  prevParams: {},
  routeKey: "test.route",
  stale: false,
  clientSegmentIds: [],
  clientSegmentSet: new Set<string>(),
  entries: [],
  matched: { params: {}, route: "test.route" },
  manifestEntry: {},
  localRouteName: "test",
  handlerContext: {},
  loaderPromises: new Map(),
  routeMap: {},
  env: {},
  metricsStore: undefined,
  Store: { run: (fn: any) => fn() },
  interceptContextMatch: null,
  isFullMatch: false,
};

vi.mock("../match-api.js", () => ({
  createMatchContextForFull: vi.fn(),
  createMatchContextForPartial: vi.fn(async () => mockMatchContext),
  matchError: vi.fn(),
}));

// Mock pipeline to yield nothing (empty result)
vi.mock("../match-pipelines.js", () => ({
  createMatchPartialPipeline: vi.fn(() => {
    return async function* () {
      // empty pipeline
    };
  }),
}));

// Mock collectMatchResult to return a minimal MatchResult
vi.mock("../match-result.js", () => ({
  collectMatchResult: vi.fn(async () => ({
    segments: [],
    matched: [],
    diff: [],
    params: {},
  })),
}));

// Mock router-context
vi.mock("../router-context.js", () => ({
  runWithRouterContext: (_ctx: any, fn: any) => fn(),
}));

// Mock preview-match
vi.mock("../preview-match.js", () => ({
  previewMatch: vi.fn(),
}));

// Mock errors
vi.mock("../../errors.js", () => ({
  sanitizeError: (e: any) => e,
}));

import { createMatchHandlers } from "../match-handlers.js";

function makeDeps(): any {
  return {
    buildRouterContext: () => ({}),
    callOnError: vi.fn(),
    matchApiDeps: {},
    defaultErrorBoundary: undefined,
    findMatch: vi.fn(),
    findInterceptForRoute: vi.fn(() => null),
  };
}

describe("matchPartial trace wiring", () => {
  beforeEach(() => {
    startSpy.mockClear();
    flushSpy.mockClear();
  });

  it("calls startRevalidationTrace before pipeline and flushRevalidationTrace after", async () => {
    const handlers = createMatchHandlers(makeDeps());

    const result = await handlers.matchPartial(
      new Request("http://localhost/b"),
      {},
    );

    expect(result).not.toBeNull();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);

    // start is called with trace meta derived from the context
    const meta = startSpy.mock.calls[0][0];
    expect(meta.method).toBe("GET");
    expect(meta.routeKey).toBe("test.route");
    expect(meta.isAction).toBe(false);
    expect(meta.prevUrl).toBe("http://localhost/a");
    expect(meta.nextUrl).toBe("http://localhost/b");
  });

  it("calls flushRevalidationTrace on pipeline error", async () => {
    // Make collectMatchResult throw
    const { collectMatchResult } = await import("../match-result.js");
    (collectMatchResult as any).mockRejectedValueOnce(
      new Error("test pipeline error"),
    );

    const deps = makeDeps();
    const handlers = createMatchHandlers(deps);

    await expect(
      handlers.matchPartial(new Request("http://localhost/b"), {}),
    ).rejects.toThrow("test pipeline error");

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(deps.callOnError).toHaveBeenCalledTimes(1);
  });

  it("passes isAction=true when actionContext provided", async () => {
    const handlers = createMatchHandlers(makeDeps());

    await handlers.matchPartial(
      new Request("http://localhost/b", { method: "POST" }),
      {},
      { actionId: "test-action" },
    );

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy.mock.calls[0][0].isAction).toBe(true);
    expect(startSpy.mock.calls[0][0].method).toBe("POST");
  });

  it("skips trace when matchContext is null", async () => {
    const { createMatchContextForPartial } = await import("../match-api.js");
    (createMatchContextForPartial as any).mockResolvedValueOnce(null);

    const handlers = createMatchHandlers(makeDeps());

    const result = await handlers.matchPartial(
      new Request("http://localhost/b"),
      {},
    );

    expect(result).toBeNull();
    expect(startSpy).not.toHaveBeenCalled();
    expect(flushSpy).not.toHaveBeenCalled();
  });
});
