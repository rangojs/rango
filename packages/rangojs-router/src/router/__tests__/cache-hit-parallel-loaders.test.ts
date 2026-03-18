import { describe, expect, it, vi } from "vitest";
import type { EntryData } from "../../server/context.js";
import { resolveLoadersOnly } from "../segment-resolution/fresh.js";
import {
  buildEntryRevalidateMap,
  resolveLoadersOnlyWithRevalidation,
} from "../segment-resolution/revalidation.js";
import type { SegmentResolutionDeps } from "../types.js";

const mockEvaluateRevalidation = vi.fn((_opts: any) => true);

vi.mock("../revalidation.js", () => ({
  evaluateRevalidation: (opts: any) => mockEvaluateRevalidation(opts),
}));

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

vi.mock("../segment-resolution/loader-cache.js", () => ({
  resolveLoaderData: vi.fn(() => Promise.resolve({ data: "test" })),
}));

vi.mock("../segment-resolution/helpers.js", () => ({
  handleHandlerResult: vi.fn((x: any) => x),
  tryStaticHandler: vi.fn(),
  tryStaticSlot: vi.fn(),
  resolveLayoutComponent: vi.fn(),
  resolveWithErrorBoundary: vi.fn(
    async (_entry: any, _params: any, resolver: () => any) => resolver(),
  ),
}));

vi.mock("../router-context.js", () => ({
  getRouterContext: vi.fn(() => null),
}));

vi.mock("../telemetry.js", () => ({
  resolveSink: vi.fn(() => null),
  safeEmit: vi.fn(),
}));

vi.mock("../../server/context.js", async () => {
  const actual = await vi.importActual("../../server/context.js");
  return {
    ...(actual as object),
    track: vi.fn(() => vi.fn()),
  };
});

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
    request: new Request("http://localhost/blog"),
    env: {},
    params: {},
    pathname: "/blog",
    var: {},
    use: vi.fn(() => Promise.resolve({ data: "loader-result" })),
  };
}

function makeParallelLoaderEntry(): EntryData {
  const parallelEntry = {
    id: "blog.layout.parallel",
    type: "parallel",
    shortCode: "L0P0",
    handler: { "@sidebar": () => null },
    loader: [
      {
        loader: { $$id: "parallel-loader" } as any,
        revalidate: [vi.fn(() => true)],
      },
    ],
    layout: [],
    parallel: [],
    intercept: [],
    middleware: [],
    revalidate: [vi.fn(() => true)],
    errorBoundary: [],
    notFoundBoundary: [],
  } as any;

  return {
    id: "blog.layout",
    type: "layout",
    shortCode: "L0",
    handler: () => null,
    loader: [],
    layout: [],
    parallel: [parallelEntry],
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    handle: [],
  } as any;
}

describe("cache-hit parallel loaders", () => {
  it("resolveLoadersOnly includes loaders from parallel entries using the parent shortCode", async () => {
    const segments = await resolveLoadersOnly(
      [makeParallelLoaderEntry()],
      makeContext(),
      makeDeps(),
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]?.id).toBe("L0D0.parallel-loader");
  });

  it("resolveLoadersOnlyWithRevalidation includes parallel loaders using the parent shortCode", async () => {
    mockEvaluateRevalidation.mockClear();

    const result = await resolveLoadersOnlyWithRevalidation(
      [makeParallelLoaderEntry()],
      makeContext(),
      new Set(["L0D0.parallel-loader"]),
      {},
      new Request("http://localhost/blog"),
      new URL("http://localhost/blog"),
      new URL("http://localhost/blog?page=2"),
      "blog",
      makeDeps(),
    );

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.id).toBe("L0D0.parallel-loader");
    expect(result.matchedIds).toEqual(["L0D0.parallel-loader"]);
  });

  it("buildEntryRevalidateMap keys parallel slots by the parent shortCode", () => {
    const map = buildEntryRevalidateMap([makeParallelLoaderEntry()]);

    expect(map.has("L0.@sidebar")).toBe(true);
    expect(map.has("L0P0.@sidebar")).toBe(false);
  });
});
