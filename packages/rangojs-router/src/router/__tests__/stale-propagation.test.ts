import { describe, it, expect, vi } from "vitest";
import {
  resolveLoadersOnlyWithRevalidation,
  resolveAllSegmentsWithRevalidation,
} from "../segment-resolution/revalidation.js";
import type { SegmentResolutionDeps } from "../types.js";
import type { EntryData } from "../../server/context";

// Mock evaluateRevalidation to capture calls and verify stale parameter
const mockEvaluateRevalidation = vi.fn((_opts: any) => true);
vi.mock("../revalidation.js", () => ({
  evaluateRevalidation: (opts: any) => mockEvaluateRevalidation(opts),
}));

// Mock loader-resolution revalidate helper to pass through
vi.mock("../loader-resolution.js", () => ({
  revalidate: async (
    shouldRevalidate: () => Promise<boolean>,
    onRevalidate: () => Promise<any>,
    onSkip: () => any,
  ) => {
    const result = await shouldRevalidate();
    return result ? await onRevalidate() : onSkip();
  },
}));

// Mock loader-cache (imported by revalidation.ts from ./loader-cache.js)
vi.mock("../segment-resolution/loader-cache.js", () => ({
  resolveLoaderData: vi.fn(() => Promise.resolve({ data: "test" })),
}));

// Mock helpers (imported by revalidation.ts from ./helpers.js)
vi.mock("../segment-resolution/helpers.js", () => ({
  handleHandlerResult: vi.fn((x: any) => x),
  tryStaticHandler: vi.fn(),
  tryStaticSlot: vi.fn(),
  resolveLayoutComponent: vi.fn(),
  // resolveWithErrorBoundary must call the resolver (3rd arg) so the
  // pipeline flows through to evaluateRevalidation.
  resolveWithErrorBoundary: vi.fn(
    async (_entry: any, _params: any, resolver: () => any) => resolver(),
  ),
}));

function makeDeps(): SegmentResolutionDeps<any> {
  return {
    wrapLoaderPromise: vi.fn(async (promise: any) => ({
      data: await promise,
      error: null,
    })) as any,
    trackHandler: vi.fn((p) => p),
    findNearestErrorBoundary: vi.fn(() => null),
    findNearestNotFoundBoundary: vi.fn(() => null),
    callOnError: vi.fn(),
  };
}

function makeContext(): any {
  return {
    request: new Request("http://localhost/"),
    env: {},
    params: { id: "1" },
    pathname: "/test",
    var: {},
    use: vi.fn(() => Promise.resolve({ data: "loader-result" })),
  };
}

function makeEntry(loaderId: string): EntryData {
  return {
    type: "route",
    shortCode: "L0R0",
    id: "test-route",
    handler: vi.fn(() => null),
    loader: [
      {
        loader: { $$id: loaderId } as any,
        revalidate: [vi.fn(() => true)],
      },
    ],
    layout: [],
    parallel: {},
    intercept: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    middleware: [],
    handle: [],
  } as any;
}

// Mock router-context (needed by resolveAllSegmentsWithRevalidation)
vi.mock("../router-context.js", () => ({
  getRouterContext: vi.fn(() => null),
}));

// Mock telemetry (needed by resolveAllSegmentsWithRevalidation)
vi.mock("../telemetry.js", () => ({
  resolveSink: vi.fn(() => null),
  safeEmit: vi.fn(),
}));

// Mock server/context track (needed by resolveAllSegmentsWithRevalidation)
vi.mock("../../server/context.js", async () => {
  const actual = await vi.importActual("../../server/context.js");
  return {
    ...(actual as object),
    track: vi.fn(() => vi.fn()),
  };
});

describe("stale propagation through resolveLoadersOnlyWithRevalidation", () => {
  it("passes stale=true to evaluateRevalidation when provided", async () => {
    mockEvaluateRevalidation.mockClear();

    const entry = makeEntry("my-loader");
    // The segment ID format: `${shortCode}D${index}.${loaderId}`
    const segmentId = "L0R0D0.my-loader";

    await resolveLoadersOnlyWithRevalidation(
      [entry],
      makeContext(),
      new Set([segmentId]), // Must be in clientSegmentIds for evaluateRevalidation to be called
      { id: "1" },
      new Request("http://localhost/"),
      new URL("http://localhost/prev"),
      new URL("http://localhost/next"),
      "test.route",
      makeDeps(),
      undefined, // actionContext
      true, // stale
    );

    expect(mockEvaluateRevalidation).toHaveBeenCalledTimes(1);
    expect(mockEvaluateRevalidation).toHaveBeenCalledWith(
      expect.objectContaining({ stale: true }),
    );
  });

  it("passes stale=undefined when not provided", async () => {
    mockEvaluateRevalidation.mockClear();

    const entry = makeEntry("my-loader");
    const segmentId = "L0R0D0.my-loader";

    await resolveLoadersOnlyWithRevalidation(
      [entry],
      makeContext(),
      new Set([segmentId]),
      { id: "1" },
      new Request("http://localhost/"),
      new URL("http://localhost/prev"),
      new URL("http://localhost/next"),
      "test.route",
      makeDeps(),
      undefined, // actionContext
      // stale omitted
    );

    expect(mockEvaluateRevalidation).toHaveBeenCalledTimes(1);
    expect(mockEvaluateRevalidation).toHaveBeenCalledWith(
      expect.objectContaining({ stale: undefined }),
    );
  });
});

describe("stale propagation through resolveAllSegmentsWithRevalidation (full pipeline)", () => {
  it("passes stale=true to evaluateRevalidation for loaders in the pipeline", async () => {
    mockEvaluateRevalidation.mockClear();

    const entry = makeEntry("pipeline-loader");
    const segmentId = "L0R0D0.pipeline-loader";

    await resolveAllSegmentsWithRevalidation(
      [entry],
      "test.route",
      { id: "1" },
      makeContext(),
      new Set([segmentId, "L0R0"]), // loader + route in client set
      { id: "1" },
      new Request("http://localhost/"),
      new URL("http://localhost/prev"),
      new URL("http://localhost/next"),
      new Map(),
      undefined, // actionContext
      null, // interceptResult
      "test.route",
      "/test",
      makeDeps(),
      true, // stale
    );

    // evaluateRevalidation should have been called with stale: true
    const staleCall = mockEvaluateRevalidation.mock.calls.find(
      ([opts]) => opts.segment?.id === segmentId,
    );
    expect(staleCall).toBeDefined();
    expect(staleCall![0].stale).toBe(true);
  });

  it("passes stale=undefined when not provided to the pipeline", async () => {
    mockEvaluateRevalidation.mockClear();

    const entry = makeEntry("pipeline-loader-no-stale");
    const segmentId = "L0R0D0.pipeline-loader-no-stale";

    await resolveAllSegmentsWithRevalidation(
      [entry],
      "test.route",
      { id: "1" },
      makeContext(),
      new Set([segmentId, "L0R0"]),
      { id: "1" },
      new Request("http://localhost/"),
      new URL("http://localhost/prev"),
      new URL("http://localhost/next"),
      new Map(),
      undefined,
      null,
      "test.route",
      "/test",
      makeDeps(),
      // stale omitted
    );

    const staleCall = mockEvaluateRevalidation.mock.calls.find(
      ([opts]) => opts.segment?.id === segmentId,
    );
    expect(staleCall).toBeDefined();
    expect(staleCall![0].stale).toBeUndefined();
  });
});
