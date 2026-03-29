import { describe, it, expect, vi } from "vitest";

// Enable debug mode
vi.mock("../../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: true,
}));

import { evaluateRevalidation } from "../revalidation.js";
import {
  runWithRouterLogContext,
  startRevalidationTrace,
  flushRevalidationTrace,
} from "../logging.js";
import { runWithRequestContext } from "../../server/request-context";
import type { ResolvedSegment, HandlerContext } from "../../types";

function makeSegment(overrides?: Partial<ResolvedSegment>): ResolvedSegment {
  return {
    id: "R0",
    namespace: "test-ns",
    type: "route",
    index: 0,
    component: null,
    params: { id: "1" },
    belongsToRoute: true,
    ...overrides,
  };
}

function makeContext(): HandlerContext<any, any> {
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
    json: vi.fn(),
    text: vi.fn(),
    html: vi.fn(),
    redirect: vi.fn(),
    notFound: vi.fn(),
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

describe("evaluateRevalidation trace integration", () => {
  it("pushes trace entry for default decision (no custom revalidators)", async () => {
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

          await evaluateRevalidation({
            segment: makeSegment({ type: "route", params: { id: "2" } }),
            prevParams: { id: "1" },
            getPrevSegment: null,
            request: new Request("http://localhost/b"),
            prevUrl: new URL("http://localhost/a"),
            nextUrl: new URL("http://localhost/b"),
            revalidations: [],
            routeKey: "test.route",
            context: makeContext(),
          });

          return flushRevalidationTrace();
        },
      ),
    );

    expect(trace).not.toBeNull();
    expect(trace!.entries).toHaveLength(1);

    const entry = trace!.entries[0];
    expect(entry.segmentId).toBe("R0");
    expect(entry.segmentType).toBe("route");
    expect(entry.belongsToRoute).toBe(true);
    expect(entry.source).toBe("segment-resolution");
    expect(entry.defaultShouldRevalidate).toBe(true);
    expect(entry.finalShouldRevalidate).toBe(true);
    expect(entry.reason).toBe("nav:params-changed");

    consoleSpy.mockRestore();
  });

  it("pushes trace entry with hard decision from custom revalidator", async () => {
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

          await evaluateRevalidation({
            segment: makeSegment({ type: "layout", belongsToRoute: false }),
            prevParams: {},
            getPrevSegment: null,
            request: new Request("http://localhost/b"),
            prevUrl: new URL("http://localhost/a"),
            nextUrl: new URL("http://localhost/b"),
            revalidations: [{ name: "always", fn: () => true }],
            routeKey: "test.route",
            context: makeContext(),
          });

          return flushRevalidationTrace();
        },
      ),
    );

    expect(trace!.entries).toHaveLength(1);
    const entry = trace!.entries[0];
    expect(entry.defaultShouldRevalidate).toBe(false); // layout default is false on GET
    expect(entry.finalShouldRevalidate).toBe(true); // hard override to true
    expect(entry.reason).toBe("hard:always");
    expect(entry.customRevalidators).toBe(1);

    consoleSpy.mockRestore();
  });

  it("uses traceSource when provided", async () => {
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

          await evaluateRevalidation({
            segment: makeSegment({ type: "loader", id: "L0D0.loader1" }),
            prevParams: {},
            getPrevSegment: null,
            request: new Request("http://localhost/b"),
            prevUrl: new URL("http://localhost/a"),
            nextUrl: new URL("http://localhost/b"),
            revalidations: [],
            routeKey: "test.route",
            context: makeContext(),
            traceSource: "loader",
          });

          return flushRevalidationTrace();
        },
      ),
    );

    expect(trace!.entries[0].source).toBe("loader");

    consoleSpy.mockRestore();
  });

  it("pushes trace entry for POST action revalidation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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

          // Route segment on POST — default revalidate true
          await evaluateRevalidation({
            segment: makeSegment({ type: "route" }),
            prevParams: { id: "1" },
            getPrevSegment: null,
            request: new Request("http://localhost/b", { method: "POST" }),
            prevUrl: new URL("http://localhost/b"),
            nextUrl: new URL("http://localhost/b"),
            revalidations: [],
            routeKey: "test.route",
            context: makeContext(),
            actionContext: { actionId: "test-action" },
          });

          // Layout segment not belonging to route — default revalidate false
          await evaluateRevalidation({
            segment: makeSegment({
              type: "layout",
              id: "L0",
              belongsToRoute: false,
            }),
            prevParams: { id: "1" },
            getPrevSegment: null,
            request: new Request("http://localhost/b", { method: "POST" }),
            prevUrl: new URL("http://localhost/b"),
            nextUrl: new URL("http://localhost/b"),
            revalidations: [],
            routeKey: "test.route",
            context: makeContext(),
            actionContext: { actionId: "test-action" },
          });

          return flushRevalidationTrace();
        },
      ),
    );

    expect(trace!.entries).toHaveLength(2);
    expect(trace!.entries[0].finalShouldRevalidate).toBe(true);
    expect(trace!.entries[0].reason).toBe("action:route-segment");
    expect(trace!.entries[1].finalShouldRevalidate).toBe(false);
    expect(trace!.entries[1].reason).toBe("action:parent-chain-skip");

    consoleSpy.mockRestore();
  });

  it("pushes trace with soft-chain reason including revalidator names", async () => {
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

          await evaluateRevalidation({
            segment: makeSegment({ type: "layout", belongsToRoute: false }),
            prevParams: {},
            getPrevSegment: null,
            request: new Request("http://localhost/b"),
            prevUrl: new URL("http://localhost/a"),
            nextUrl: new URL("http://localhost/b"),
            revalidations: [
              {
                name: "myRevalidator",
                fn: () => ({ defaultShouldRevalidate: true }),
              },
            ],
            routeKey: "test.route",
            context: makeContext(),
          });

          return flushRevalidationTrace();
        },
      ),
    );

    expect(trace!.entries[0].reason).toBe("soft-chain:myRevalidator");
    expect(trace!.entries[0].finalShouldRevalidate).toBe(true);
    expect(trace!.entries[0].defaultShouldRevalidate).toBe(false);

    consoleSpy.mockRestore();
  });

  it("uses nav:params-unchanged when route params don't change", async () => {
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

          await evaluateRevalidation({
            segment: makeSegment({ type: "route", params: { id: "1" } }),
            prevParams: { id: "1" },
            getPrevSegment: null,
            request: new Request("http://localhost/b"),
            prevUrl: new URL("http://localhost/a"),
            nextUrl: new URL("http://localhost/b"),
            revalidations: [],
            routeKey: "test.route",
            context: makeContext(),
          });

          return flushRevalidationTrace();
        },
      ),
    );

    expect(trace!.entries[0].reason).toBe("nav:params-unchanged");
    expect(trace!.entries[0].finalShouldRevalidate).toBe(false);

    consoleSpy.mockRestore();
  });
});
