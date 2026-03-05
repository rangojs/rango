import { describe, it, expect, vi } from "vitest";
import { resolveInterceptLoadersOnly } from "../intercept-resolution.js";
import type { InterceptEntry } from "../../server/context";
import type { EntryData } from "../../server/context";
import type { SegmentResolutionDeps } from "../types.js";

// Stub dependencies that resolveInterceptLoadersOnly uses transitively
vi.mock("../revalidation.js", () => ({
  evaluateRevalidation: vi.fn(() => true),
}));
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: vi.fn(() => null),
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
    parallel: [],
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
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
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
});
