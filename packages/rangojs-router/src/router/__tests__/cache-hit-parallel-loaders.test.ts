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
    parallel: {},
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

/**
 * Models a cache boundary wrapping a layout that has a loader.
 * The DSL attaches the loader to both the cache entry and the layout entry,
 * so the tree walker visits the same loader via two paths.
 *
 * Entry tree:
 *   cache ($cache.0) ── loader: [CartLoader]
 *     └── layout ($layout.0) ── loader: [CartLoader]  (same $$id)
 */
/**
 * In the real DSL, when a cache boundary wraps a layout that has a loader,
 * the loader entry ends up on both the cache entry and the layout entry
 * with the SAME shortCode (the layout's). This causes resolveLoaders to
 * produce two segments with identical IDs.
 */
function makeCacheBoundaryWithSharedLoader(): EntryData {
  const sharedLoader = {
    loader: { $$id: "src/loaders/cart.ts#Cart" } as any,
    revalidate: [vi.fn(() => true)],
  };

  // Both entries use shortCode "L0" — matching real behavior where
  // the cache boundary inherits the layout's loader with its shortCode.
  const layoutEntry = {
    id: "root.$layout.0",
    type: "layout",
    shortCode: "L0",
    handler: () => null,
    loader: [sharedLoader],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    handle: [],
  } as any;

  return {
    id: "root.$cache.0",
    type: "cache",
    shortCode: "L0",
    handler: () => null,
    loader: [sharedLoader],
    layout: [layoutEntry],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    handle: [],
  } as any;
}

describe("cache-boundary shared loader dedup", () => {
  it("resolveLoadersOnly emits shared loader only once when cache wraps layout", async () => {
    const segments = await resolveLoadersOnly(
      [makeCacheBoundaryWithSharedLoader()],
      makeContext(),
      makeDeps(),
    );

    const cartSegments = segments.filter((s) =>
      s.id.includes("src/loaders/cart.ts#Cart"),
    );
    expect(cartSegments).toHaveLength(1);
  });

  it("resolveLoadersOnlyWithRevalidation emits shared loader only once when cache wraps layout", async () => {
    mockEvaluateRevalidation.mockClear();

    const result = await resolveLoadersOnlyWithRevalidation(
      [makeCacheBoundaryWithSharedLoader()],
      makeContext(),
      new Set(["C0D0.src/loaders/cart.ts#Cart"]),
      {},
      new Request("http://localhost/shop"),
      new URL("http://localhost/"),
      new URL("http://localhost/shop"),
      "shop.category",
      makeDeps(),
    );

    const cartSegments = result.segments.filter((s) =>
      s.id.includes("src/loaders/cart.ts#Cart"),
    );
    expect(cartSegments).toHaveLength(1);
  });
});

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

  it("resolveLoadersOnlyWithRevalidation keeps a SKIPPED loader in matchedIds but drops it from segments", async () => {
    // The reval-only divergence vs the fresh path: when a loader's gate says
    // skip (it's already in the client set and revalidate() returned false), the
    // loader is NOT re-fetched (absent from segments) but its id STAYS in
    // matchedIds so the client keeps advertising it and it stays eligible for
    // future revalidation (otherwise it gets pruned -> force-refetched -> churn).
    mockEvaluateRevalidation.mockClear();
    mockEvaluateRevalidation.mockReturnValueOnce(false); // loader revalidate -> skip

    const result = await resolveLoadersOnlyWithRevalidation(
      [makeParallelLoaderEntry()],
      makeContext(),
      new Set(["L0D0.parallel-loader"]), // loader IS in the client set
      {},
      new Request("http://localhost/blog"),
      new URL("http://localhost/blog"),
      new URL("http://localhost/blog?page=2"),
      "blog",
      makeDeps(),
    );

    expect(result.segments).toHaveLength(0); // not re-fetched
    expect(result.matchedIds).toEqual(["L0D0.parallel-loader"]); // still matched
  });

  it("buildEntryRevalidateMap keys parallel slots by the parent shortCode", () => {
    const map = buildEntryRevalidateMap([makeParallelLoaderEntry()]);

    expect(map.has("L0.@sidebar")).toBe(true);
    expect(map.has("L0P0.@sidebar")).toBe(false);
  });
});
