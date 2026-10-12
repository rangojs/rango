import { describe, it, expect, vi } from "vitest";
import {
  resolveInterceptEntry,
  resolveInterceptLoadersOnly,
} from "../intercept-resolution.js";
import { evaluateRevalidation } from "../revalidation.js";
import type { InterceptEntry } from "../../server/context";
import type { EntryData } from "../../server/context";
import type { SegmentResolutionDeps } from "../types.js";

// Stub dependencies that resolveInterceptLoadersOnly uses transitively
vi.mock("../revalidation.js", () => ({
  evaluateRevalidation: vi.fn(() => true),
}));
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: vi.fn(() => null),
  // resolveLoaderData (intercept loaders' funnel) reads it for the PPR lane.
  _getRequestContext: vi.fn(() => undefined),
}));
vi.mock("../middleware.js", () => ({
  executeInterceptMiddleware: vi.fn(() => null),
}));
vi.mock("../handler-context.js", () => ({
  createReverseFunction: vi.fn(),
}));
vi.mock("../../route-map-builder.js", () => ({
  getGlobalRouteMap: vi.fn(),
}));
vi.mock("../segment-resolution.js", () => ({
  handleHandlerResult: vi.fn((x: any) => x),
  buildLoaderErrorContext: vi.fn(() => ({})),
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
    params: {},
    pathname: "/test",
    var: {},
    use: vi.fn(() => Promise.resolve({ data: "loader-result" })),
  };
}

function makeParentEntry(): EntryData {
  return {
    type: "route",
    shortCode: "L0R0",
    id: "test-route",
    handler: null as any,
    loader: [],
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

function makeInterceptEntry(
  loading: InterceptEntry["loading"],
): InterceptEntry {
  return {
    slotName: "@modal",
    routeName: "test",
    handler: null as any,
    middleware: [],
    loader: [
      {
        loader: { $$id: "test-loader" } as any,
        revalidate: [],
      },
    ],
    loading,
    when: [],
  };
}

const revalidationContext = (clientSegmentIds: string[] = []) => ({
  clientSegmentIds: new Set(clientSegmentIds),
  prevParams: {},
  request: new Request("http://localhost/"),
  prevUrl: new URL("http://localhost/prev"),
  nextUrl: new URL("http://localhost/next"),
  routeKey: "test",
});

/**
 * Deps whose loader results settle only when `release` is called: whether
 * resolveInterceptLoadersOnly returned before or after that shows whether it
 * awaited them.
 */
function gatedDeps() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let settled = false;
  const deps = makeDeps();
  deps.wrapLoaderPromise = vi.fn(async (promise: any) => {
    await gate;
    settled = true;
    return { data: await promise, error: null };
  }) as any;
  return { deps, release, settled: () => settled };
}

describe("resolveInterceptLoadersOnly loading: false parity", () => {
  // The slot's loaders are loader segments of it; with no loading() they are
  // settled before the slot is built, so a plain click's modal arrives whole.
  for (const [label, loading, awaits] of [
    ["loading: false awaits loaders", false, true],
    ["loading: truthy streams loaders", "LoadingSpinner", false],
    ["loading: undefined awaits loaders (same as false)", undefined, true],
  ] as const) {
    it(label, async () => {
      const { deps, release, settled } = gatedDeps();
      const done = resolveInterceptLoadersOnly(
        makeInterceptEntry(loading as InterceptEntry["loading"]),
        makeParentEntry(),
        makeContext(),
        true,
        deps,
        revalidationContext(),
      );
      setTimeout(release, 5);
      const segments = await done;
      expect(segments.map((s) => s.id)).toEqual(["L0R0.@modalD0.test-loader"]);
      expect(settled()).toBe(awaits);
      await expect(segments[0]!.loaderData).resolves.toMatchObject({
        data: { data: "loader-result" },
      });
    });
  }

  it("flags isPartial:true in the loader errorContext (cache-hit partial path)", async () => {
    // resolveInterceptLoadersOnly is only called on the cache-hit partial-update
    // path, so a throwing intercept loader here must report with isPartial:true
    // (mirroring revalidation.ts), not be mislabeled as a full render.
    const entry = makeInterceptEntry(false);
    const deps = makeDeps();
    await resolveInterceptLoadersOnly(
      entry,
      makeParentEntry(),
      makeContext(),
      true,
      deps,
      revalidationContext(),
    );

    // The 5th arg to wrapLoaderPromise is the errorContext that drives onError +
    // loader.error telemetry; assert it carries isPartial:true.
    const errorContext = (deps.wrapLoaderPromise as any).mock.calls[0][4];
    expect(errorContext).toMatchObject({ isPartial: true });
  });
});

describe("resolveInterceptLoadersOnly on a slot the client holds", () => {
  it("every loader held and skipped: no loader segment is sent, the client keeps its own", async () => {
    vi.mocked(evaluateRevalidation).mockResolvedValueOnce(false);
    const deps = makeDeps();
    const segments = await resolveInterceptLoadersOnly(
      makeInterceptEntry(false),
      makeParentEntry(),
      makeContext(),
      true,
      deps,
      revalidationContext(["L0R0.@modal", "L0R0.@modalD0.test-loader"]),
    );

    expect(segments).toEqual([]);
    expect(deps.wrapLoaderPromise).not.toHaveBeenCalled();
  });

  it("a loader the client lacks runs although the slot is held", async () => {
    vi.mocked(evaluateRevalidation).mockClear();
    const segments = await resolveInterceptLoadersOnly(
      makeInterceptEntry(false),
      makeParentEntry(),
      makeContext(),
      true,
      makeDeps(),
      revalidationContext(["L0R0.@modal"]),
    );

    expect(segments.map((s) => s.id)).toEqual(["L0R0.@modalD0.test-loader"]);
    expect(evaluateRevalidation).not.toHaveBeenCalled();
  });

  it("pins the slot's id as the loaders' handle push owner at their kickoff", async () => {
    const context = makeContext();
    const owners: unknown[] = [];
    context.use = vi.fn(() => {
      owners.push(context._currentSegmentId);
      return Promise.resolve({ data: "loader-result" });
    });
    await resolveInterceptLoadersOnly(
      makeInterceptEntry(false),
      makeParentEntry(),
      context,
      true,
      makeDeps(),
      revalidationContext(),
    );

    expect(owners).toEqual(["L0R0.@modal"]);
  });
});

describe("resolveInterceptEntry handle push owner", () => {
  it("pins the slot's id for its loaders' kickoff and its handler's run", async () => {
    const context = makeContext();
    const owners: Record<string, unknown[]> = { loader: [], handler: [] };
    context.use = vi.fn(() => {
      owners.loader.push(context._currentSegmentId);
      return Promise.resolve({ data: "loader-result" });
    });
    const entry: InterceptEntry = {
      ...makeInterceptEntry(false),
      handler: (ctx: any) => {
        owners.handler.push(ctx._currentSegmentId);
        return "modal";
      },
    };

    await resolveInterceptEntry(
      entry,
      makeParentEntry(),
      {},
      context,
      true,
      makeDeps(),
    );

    expect(owners).toEqual({
      loader: ["L0R0.@modal"],
      handler: ["L0R0.@modal"],
    });
  });
});

describe("resolveInterceptEntry: the slot and its loader segments", () => {
  const twoLoaders = (): InterceptEntry => ({
    ...makeInterceptEntry("Loading"),
    handler: vi.fn(() => "modal") as any,
    layout: vi.fn(() => "chrome") as any,
    loader: [
      { loader: { $$id: "first" } as any, revalidate: [] },
      { loader: { $$id: "second" } as any, revalidate: [] },
    ],
  });

  it("emits the slot with no aggregate, then one loader segment per loader in declaration order", async () => {
    const segments = await resolveInterceptEntry(
      twoLoaders(),
      makeParentEntry(),
      {},
      makeContext(),
      true,
      makeDeps(),
      revalidationContext(),
    );
    expect(segments.map((s) => [s.id, s.type])).toEqual([
      ["L0R0.@modal", "parallel"],
      ["L0R0.@modalD0.first", "loader"],
      ["L0R0.@modalD1.second", "loader"],
    ]);
    expect(segments[0]).not.toHaveProperty("loaderDataPromise");
    expect(segments[0]).not.toHaveProperty("loaderIds");
    expect(segments[1]!.namespace).toBe("intercept:test");
  });

  it("in a fill with the slot held, runs neither handler nor layout, only the loaders the client lacks", async () => {
    const entry = twoLoaders();
    const context = makeContext();
    context._prefetchDeferral = { mode: "fill", held: new Set() };
    const segments = await resolveInterceptEntry(
      entry,
      makeParentEntry(),
      {},
      context,
      true,
      makeDeps(),
      revalidationContext(["L0R0.@modal", "L0R0.@modalD0.first"]),
    );
    expect(entry.handler).not.toHaveBeenCalled();
    expect(entry.layout).not.toHaveBeenCalled();
    expect(segments.map((s) => [s.id, s.component])).toEqual([
      ["L0R0.@modal", null],
      ["L0R0.@modalD1.second", null],
    ]);
  });
});
