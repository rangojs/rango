import { describe, it, expect, vi } from "vitest";
import { resolveInterceptEntry } from "../intercept-resolution.js";
import type { InterceptEntry, EntryData } from "../../server/context";
import type { MiddlewareFn } from "../middleware-types.js";
import type { SegmentResolutionDeps } from "../types.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";

// Use the REAL executeInterceptMiddleware so we exercise the actual middleware
// execution path. Only stub the transitive helpers the middleware path reaches.
vi.mock("../revalidation.js", () => ({
  evaluateRevalidation: vi.fn(() => true),
}));
vi.mock("../handler-context.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createReverseFunction: vi.fn(() => () => "/"),
}));
vi.mock("../../route-map-builder.js", () => ({
  getGlobalRouteMap: vi.fn(() => ({})),
}));
vi.mock("../segment-resolution.js", () => ({
  handleHandlerResult: vi.fn((x: any) => x),
  warnOnStreamedResponse: vi.fn(),
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
    _variables: {},
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

function makeInterceptEntry(middleware: MiddlewareFn[]): InterceptEntry {
  return {
    slotName: "@modal",
    routeName: "test",
    handler: "modal-content" as any,
    middleware,
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    loader: [],
    when: [],
  };
}

function withReqCtx<T>(fn: () => Promise<T>): Promise<T> {
  const reqCtx = createRequestContext({
    env: {},
    request: new Request("http://localhost/test"),
    url: new URL("http://localhost/test"),
    variables: {},
  });
  return runWithRequestContext(reqCtx, fn);
}

describe("resolveInterceptEntry skipMiddleware (background re-render)", () => {
  it("foreground (default) runs the intercept middleware once", async () => {
    const mw = vi.fn<MiddlewareFn>(async (_ctx, next) => {
      await next();
    });
    const entry = makeInterceptEntry([mw]);

    await withReqCtx(() =>
      resolveInterceptEntry(
        entry,
        makeParentEntry(),
        {},
        makeContext(),
        true,
        makeDeps(),
      ),
    );

    expect(mw).toHaveBeenCalledTimes(1);
  });

  it("background re-render (skipMiddleware) does NOT run the intercept middleware", async () => {
    const mw = vi.fn<MiddlewareFn>(async (_ctx, next) => {
      await next();
    });
    const entry = makeInterceptEntry([mw]);

    await withReqCtx(() =>
      resolveInterceptEntry(
        entry,
        makeParentEntry(),
        {},
        makeContext(),
        true,
        makeDeps(),
        undefined,
        { skipMiddleware: true },
      ),
    );

    expect(mw).not.toHaveBeenCalled();
  });

  it("foreground + background pair runs the middleware exactly once total", async () => {
    // Simulates a navigation: the foreground resolves the intercept (running
    // its middleware), then the post-response proactive/background path
    // re-renders to populate the cache. With skipMiddleware on the background
    // pass, the middleware fires once, not twice.
    const mw = vi.fn<MiddlewareFn>(async (_ctx, next) => {
      await next();
    });
    const entry = makeInterceptEntry([mw]);
    const deps = makeDeps();

    await withReqCtx(async () => {
      // Foreground pass.
      await resolveInterceptEntry(
        entry,
        makeParentEntry(),
        {},
        makeContext(),
        true,
        deps,
      );
      // Background pass (proactive cache write).
      await resolveInterceptEntry(
        entry,
        makeParentEntry(),
        {},
        makeContext(),
        true,
        deps,
        undefined,
        { skipMiddleware: true },
      );
    });

    expect(mw).toHaveBeenCalledTimes(1);
  });

  it("background re-render does not abort when the intercept middleware would short-circuit with a Response", async () => {
    // A middleware that short-circuits (e.g. an auth gate returning a redirect).
    // In the background path this must be skipped entirely so the cache write is
    // produced from the segment tree rather than being aborted by a thrown
    // Response. The foreground already enforced the gate.
    const mw = vi.fn<MiddlewareFn>(
      () =>
        new Response(null, { status: 302, headers: { location: "/login" } }),
    );
    const entry = makeInterceptEntry([mw]);

    const segments = await withReqCtx(() =>
      resolveInterceptEntry(
        entry,
        makeParentEntry(),
        {},
        makeContext(),
        true,
        makeDeps(),
        undefined,
        { skipMiddleware: true },
      ),
    );

    expect(mw).not.toHaveBeenCalled();
    // A real intercept segment was produced (cache write would succeed),
    // not aborted by a thrown short-circuit Response.
    expect(segments).toHaveLength(1);
    expect(segments[0].slot).toBe("@modal");
  });
});
