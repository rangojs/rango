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

describe("resolveInterceptLoadersOnly loading: false parity", () => {
  it("loading: false awaits loaders (loaderDataPromise is resolved array)", async () => {
    const entry = makeInterceptEntry(false);
    const result = await resolveInterceptLoadersOnly(
      entry,
      makeParentEntry(),
      {},
      makeContext(),
      true,
      makeDeps(),
      {
        clientSegmentIds: new Set(),
        prevParams: {},
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
      },
    );

    expect(result).not.toBeNull();
    // When loading is false, loaderDataPromise should be a resolved array
    // (the function awaited Promise.all), not a pending Promise
    expect(Array.isArray(result!.loaderDataPromise)).toBe(true);
  });

  it("loading: truthy defers loaders (loaderDataPromise is a Promise)", async () => {
    const loadingComponent = "LoadingSpinner" as any;
    const entry = makeInterceptEntry(loadingComponent);
    const result = await resolveInterceptLoadersOnly(
      entry,
      makeParentEntry(),
      {},
      makeContext(),
      true,
      makeDeps(),
      {
        clientSegmentIds: new Set(),
        prevParams: {},
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
      },
    );

    expect(result).not.toBeNull();
    // When loading is truthy, loaderDataPromise should be a Promise (not awaited)
    expect(result!.loaderDataPromise).toBeInstanceOf(Promise);
  });

  it("loading: undefined awaits loaders (same as false)", async () => {
    const entry = makeInterceptEntry(undefined);
    const result = await resolveInterceptLoadersOnly(
      entry,
      makeParentEntry(),
      {},
      makeContext(),
      true,
      makeDeps(),
      {
        clientSegmentIds: new Set(),
        prevParams: {},
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
      },
    );

    expect(result).not.toBeNull();
    expect(Array.isArray(result!.loaderDataPromise)).toBe(true);
  });

  it("flags isPartial:true in the loader errorContext (cache-hit partial path)", async () => {
    // resolveInterceptLoadersOnly is only called on the cache-hit partial-update
    // path, so a throwing intercept loader here must report with isPartial:true
    // (mirroring revalidation.ts), not be mislabeled as a full render.
    const entry = makeInterceptEntry(false);
    const deps = makeDeps();
    await resolveInterceptLoadersOnly(
      entry,
      makeParentEntry(),
      {},
      makeContext(),
      true,
      deps,
      {
        clientSegmentIds: new Set(),
        prevParams: {},
        request: new Request("http://localhost/"),
        prevUrl: new URL("http://localhost/prev"),
        nextUrl: new URL("http://localhost/next"),
        routeKey: "test",
      },
    );

    // The 5th arg to wrapLoaderPromise is the errorContext that drives onError +
    // loader.error telemetry; assert it carries isPartial:true.
    const errorContext = (deps.wrapLoaderPromise as any).mock.calls[0][4];
    expect(errorContext).toMatchObject({ isPartial: true });
  });
});

describe("resolveInterceptLoadersOnly on a slot the client holds", () => {
  const revalidationContext = (clientSegmentIds: string[]) => ({
    clientSegmentIds: new Set(clientSegmentIds),
    prevParams: {},
    request: new Request("http://localhost/"),
    prevUrl: new URL("http://localhost/prev"),
    nextUrl: new URL("http://localhost/next"),
    routeKey: "test",
  });

  it("every loader held: the empty aggregate, not null (the cached one would be sent)", async () => {
    vi.mocked(evaluateRevalidation).mockResolvedValueOnce(false);
    const deps = makeDeps();
    const result = await resolveInterceptLoadersOnly(
      makeInterceptEntry(false),
      makeParentEntry(),
      {},
      makeContext(),
      true,
      deps,
      revalidationContext(["L0R0.@modal"]),
    );

    expect(result).toEqual({ loaderDataPromise: [], loaderIds: [] });
    expect(deps.wrapLoaderPromise).not.toHaveBeenCalled();
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
      {},
      context,
      true,
      makeDeps(),
      revalidationContext([]),
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
