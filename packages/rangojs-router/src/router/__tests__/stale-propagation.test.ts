import { describe, it, expect, vi } from "vitest";
import { resolveLoadersOnlyWithRevalidation } from "../segment-resolution/revalidation.js";
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
  resolveWithErrorBoundary: vi.fn(),
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
    handler: null as any,
    loader: [
      {
        loader: { $$id: loaderId } as any,
        revalidate: [vi.fn(() => true)],
      },
    ],
    layout: [],
    parallel: [],
    intercept: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    middleware: [],
    handle: [],
  } as any;
}

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
