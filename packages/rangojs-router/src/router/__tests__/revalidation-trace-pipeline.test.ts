/**
 * Tests the trace wiring through actual segment resolution functions,
 * verifying that both early-return paths (new segments) and
 * evaluateRevalidation paths produce trace entries.
 */
import { describe, it, expect, vi } from "vitest";
import { runWithRequestContext } from "../../server/request-context";

// Enable debug mode (must be before importing traced modules)
vi.mock("../../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: true,
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

// Mock loader-cache
vi.mock("../segment-resolution/loader-cache.js", () => ({
  resolveLoaderData: vi.fn(() => Promise.resolve({ data: "test" })),
}));

// Mock helpers
vi.mock("../segment-resolution/helpers.js", () => ({
  handleHandlerResult: vi.fn((x: any) => x),
  tryStaticHandler: vi.fn(),
  tryStaticSlot: vi.fn(),
  resolveLayoutComponent: vi.fn(() => null),
  resolveWithErrorBoundary: vi.fn(
    async (_entry: any, _params: any, resolve: () => any, fallback: any) => {
      try {
        return await resolve();
      } catch {
        return fallback(null);
      }
    },
  ),
}));

import { resolveLoadersWithRevalidation } from "../segment-resolution/revalidation.js";
import {
  runWithRouterLogContext,
  startRevalidationTrace,
  flushRevalidationTrace,
} from "../logging.js";
import type { SegmentResolutionDeps } from "../types.js";
import type { EntryData } from "../../server/context";

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
    request: new Request("http://localhost/b"),
    env: {},
    params: { id: "1" },
    pathname: "/b",
    url: new URL("http://localhost/b"),
    var: {},
    get: vi.fn(),
    set: vi.fn(),
    header: vi.fn(),
    use: vi.fn(),
    reverse: vi.fn(),
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
        revalidate: [],
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

function minimalRequestContext(): any {
  return {
    env: {},
    request: new Request("http://localhost/test"),
    url: new URL("http://localhost/test"),
    originalUrl: new URL("http://localhost/test"),
    pathname: "/test",
    searchParams: new URLSearchParams(),
    _variables: {},
    get: () => undefined,
    set: () => {},
    params: {},
    res: new Response(),
    cookie: () => undefined,
    cookies: () => ({}),
    setCookie: () => {},
    deleteCookie: () => {},
    header: () => {},
    setStatus: () => {},
    _setStatus: () => {},
    use: () => {
      throw new Error("not available");
    },
    method: "GET",
    _handleStore: { stream: () => (async function* () {})(), push: () => {} },
    waitUntil: () => {},
    onResponse: () => {},
    _onResponseCallbacks: [],
    setLocationState: () => {},
    _reportedErrors: new WeakSet(),
    reverse: () => "/",
    _shared: { params: {}, reverse: () => "/" },
  };
}

describe("revalidation trace through segment resolution pipeline", () => {
  it("emits new-segment trace entry when loader is not in client set", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const trace = await runWithRequestContext(minimalRequestContext(), () =>
      runWithRouterLogContext(
        { request: new Request("http://localhost/b"), transaction: "test" },
        async () => {
          startRevalidationTrace({
            method: "GET",
            prevUrl: "http://localhost/a",
            nextUrl: "http://localhost/b",
            routeKey: "test.route",
            isAction: false,
          });

          const entry = makeEntry("loader-1");
          // Empty client set = segment not on client = early return with "new-segment"
          await resolveLoadersWithRevalidation(
            entry,
            makeContext(),
            true, // belongsToRoute
            new Set(), // empty clientSegmentIds
            { id: "0" },
            new Request("http://localhost/b"),
            new URL("http://localhost/a"),
            new URL("http://localhost/b"),
            "test.route",
            makeDeps(),
          );

          return flushRevalidationTrace();
        },
      ),
    );

    expect(trace).not.toBeNull();
    expect(trace!.entries).toHaveLength(1);
    expect(trace!.entries[0].segmentId).toBe("L0R0D0.loader-1");
    expect(trace!.entries[0].source).toBe("loader");
    expect(trace!.entries[0].reason).toBe("new-segment");
    expect(trace!.entries[0].finalShouldRevalidate).toBe(true);

    consoleSpy.mockRestore();
  });

  it("emits evaluateRevalidation trace entry when loader is in client set", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const segmentId = "L0R0D0.loader-1";

    const trace = await runWithRequestContext(minimalRequestContext(), () =>
      runWithRouterLogContext(
        {
          request: new Request("http://localhost/b", { method: "POST" }),
          transaction: "test",
        },
        async () => {
          startRevalidationTrace({
            method: "POST",
            prevUrl: "http://localhost/b",
            nextUrl: "http://localhost/b",
            routeKey: "test.route",
            isAction: true,
          });

          const entry = makeEntry("loader-1");
          // Segment IS in client set, so it flows through evaluateRevalidation
          await resolveLoadersWithRevalidation(
            entry,
            makeContext(),
            true,
            new Set([segmentId]),
            { id: "1" },
            new Request("http://localhost/b", { method: "POST" }),
            new URL("http://localhost/b"),
            new URL("http://localhost/b"),
            "test.route",
            makeDeps(),
            { actionId: "test-action" },
          );

          return flushRevalidationTrace();
        },
      ),
    );

    expect(trace).not.toBeNull();
    expect(trace!.entries).toHaveLength(1);
    expect(trace!.entries[0].segmentId).toBe(segmentId);
    expect(trace!.entries[0].source).toBe("loader");
    expect(trace!.entries[0].segmentType).toBe("loader");
    // POST + loader = action:loader-segment (always revalidate)
    expect(trace!.entries[0].reason).toBe("action:loader-segment");
    expect(trace!.entries[0].finalShouldRevalidate).toBe(true);

    consoleSpy.mockRestore();
  });

  it("emits both early-return and evaluated entries in one trace", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const trace = await runWithRequestContext(minimalRequestContext(), () =>
      runWithRouterLogContext(
        { request: new Request("http://localhost/b"), transaction: "test" },
        async () => {
          startRevalidationTrace({
            method: "GET",
            prevUrl: "http://localhost/a",
            nextUrl: "http://localhost/b",
            routeKey: "test.route",
            isAction: false,
          });

          // Entry with two loaders
          const entry: EntryData = {
            type: "route",
            shortCode: "L0R0",
            id: "test-route",
            handler: null as any,
            loader: [
              { loader: { $$id: "loader-A" } as any, revalidate: [] },
              { loader: { $$id: "loader-B" } as any, revalidate: [] },
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

          // Only loader-B is in client set; loader-A will be "new-segment"
          await resolveLoadersWithRevalidation(
            entry,
            makeContext(),
            true,
            new Set(["L0R0D1.loader-B"]),
            { id: "1" },
            new Request("http://localhost/b"),
            new URL("http://localhost/a"),
            new URL("http://localhost/b"),
            "test.route",
            makeDeps(),
          );

          return flushRevalidationTrace();
        },
      ),
    );

    expect(trace!.entries).toHaveLength(2);

    // First loader (A) is new to the client
    expect(trace!.entries[0].segmentId).toBe("L0R0D0.loader-A");
    expect(trace!.entries[0].reason).toBe("new-segment");

    // Second loader (B) went through evaluateRevalidation (GET, non-route = nav:non-route-skip)
    // Wait - loader type on GET goes through default logic. Loader type is "loader",
    // which is not "route", so it's nav:non-route-skip (false).
    expect(trace!.entries[1].segmentId).toBe("L0R0D1.loader-B");
    expect(trace!.entries[1].reason).toBe("nav:non-route-skip");
    expect(trace!.entries[1].finalShouldRevalidate).toBe(false);

    consoleSpy.mockRestore();
  });
});
