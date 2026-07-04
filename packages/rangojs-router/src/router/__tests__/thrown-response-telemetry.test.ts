/**
 * A thrown Response is documented short-circuit control flow (middleware auth
 * gates, redirects), not an error. match()/matchPartial() must therefore emit a
 * request.end telemetry event for it — the same completed-request event the
 * non-thrown redirect path already emits — NOT a request.error with a synthetic
 * `new Error("[object Response]")` and phase "redirect". Otherwise every auth
 * redirect inflates telemetry error counts and no request.end fires.
 *
 * Drives createMatchHandlers with a pipeline that rejects with a Response and
 * asserts the recording sink saw request.end and never request.error, for both
 * the full-document (match) and partial (matchPartial, action + non-action)
 * transactions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TelemetryEvent, TelemetrySink } from "../telemetry.js";

const mockCtx = {
  request: new Request("http://localhost/protected"),
  url: new URL("http://localhost/protected"),
  prevUrl: new URL("http://localhost/prev"),
  routeKey: "protected.route",
  stale: false,
};

vi.mock("../match-api.js", () => ({
  createMatchContextForFull: vi.fn(async () => mockCtx),
  createMatchContextForPartial: vi.fn(async () => mockCtx),
  matchError: vi.fn(),
}));

vi.mock("../match-pipelines.js", () => ({
  createMatchPartialPipeline: vi.fn(() => async function* () {}),
}));

vi.mock("../match-result.js", () => ({
  collectMatchResult: vi.fn(),
}));

vi.mock("../router-context.js", () => ({
  runWithRouterContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../logging.js", () => ({
  runWithRouterLogContext: (_meta: unknown, fn: () => unknown) => fn(),
  withRouterLogScope: (_name: unknown, fn: () => unknown) => fn(),
  isRouterDebugEnabled: () => false,
  startRevalidationTrace: () => {},
  flushRevalidationTrace: () => {},
}));

vi.mock("../preview-match.js", () => ({
  previewMatch: vi.fn(),
}));

vi.mock("../../errors.js", () => ({
  sanitizeError: (e: unknown) => e,
}));

import { createMatchHandlers } from "../match-handlers.js";
import { collectMatchResult } from "../match-result.js";

function recordingSink(): { sink: TelemetrySink; events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  return { sink: { emit: (e) => events.push(e) }, events };
}

function makeDeps(telemetry: TelemetrySink): any {
  return {
    buildRouterContext: () => ({}),
    callOnError: vi.fn(),
    matchApiDeps: {},
    defaultErrorBoundary: undefined,
    findMatch: vi.fn(),
    findInterceptForRoute: vi.fn(() => null),
    telemetry,
  };
}

describe("thrown-Response telemetry (request.end, not request.error)", () => {
  beforeEach(() => {
    (collectMatchResult as any).mockReset();
  });

  it("match() emits request.end (not request.error) when the pipeline throws a Response", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/login" },
    });
    (collectMatchResult as any).mockRejectedValueOnce(redirect);

    const { sink, events } = recordingSink();
    const deps = makeDeps(sink);
    const handlers = createMatchHandlers(deps);

    await expect(
      handlers.match(new Request("http://localhost/protected"), {}),
    ).rejects.toBe(redirect);

    const types = events.map((e) => e.type);
    expect(types).toContain("request.end");
    expect(types).not.toContain("request.error");

    const end = events.find((e) => e.type === "request.end")!;
    expect(end).toMatchObject({
      transaction: "match",
      segmentCount: 0,
      cacheHit: false,
      method: "GET",
      pathname: "/protected",
      // The short-circuit request.end carries the thrown Response's status.
      status: 302,
    });

    // callOnError must NOT fire for a control-flow Response.
    expect(deps.callOnError).not.toHaveBeenCalled();
  });

  it("match() still emits request.error when the pipeline throws a real Error", async () => {
    (collectMatchResult as any).mockRejectedValueOnce(new Error("boom"));

    const { sink, events } = recordingSink();
    const deps = makeDeps(sink);
    const handlers = createMatchHandlers(deps);

    await expect(
      handlers.match(new Request("http://localhost/protected"), {}),
    ).rejects.toThrow("boom");

    const types = events.map((e) => e.type);
    expect(types).toContain("request.error");
    expect(types).not.toContain("request.end");

    const err = events.find((e) => e.type === "request.error")! as Extract<
      TelemetryEvent,
      { type: "request.error" }
    >;
    expect(err.phase).toBe("routing");
    expect(deps.callOnError).toHaveBeenCalledTimes(1);
  });

  it("matchPartial() emits request.end (not request.error) when the pipeline throws a Response", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/login" },
    });
    (collectMatchResult as any).mockRejectedValueOnce(redirect);

    const { sink, events } = recordingSink();
    const deps = makeDeps(sink);
    const handlers = createMatchHandlers(deps);

    await expect(
      handlers.matchPartial(new Request("http://localhost/protected"), {}),
    ).rejects.toBe(redirect);

    const types = events.map((e) => e.type);
    expect(types).toContain("request.end");
    expect(types).not.toContain("request.error");

    const end = events.find((e) => e.type === "request.end")!;
    expect(end).toMatchObject({
      transaction: "matchPartial",
      segmentCount: 0,
      cacheHit: false,
      // The short-circuit request.end carries the thrown Response's status.
      status: 302,
    });
    expect(deps.callOnError).not.toHaveBeenCalled();
  });

  it("matchPartial() action still emits request.error with phase 'action' for a real Error", async () => {
    (collectMatchResult as any).mockRejectedValueOnce(new Error("boom"));

    const { sink, events } = recordingSink();
    const deps = makeDeps(sink);
    const handlers = createMatchHandlers(deps);

    await expect(
      handlers.matchPartial(
        new Request("http://localhost/protected", { method: "POST" }),
        {},
        { actionId: "submit" },
      ),
    ).rejects.toThrow("boom");

    const err = events.find((e) => e.type === "request.error")! as Extract<
      TelemetryEvent,
      { type: "request.error" }
    >;
    expect(err).toBeDefined();
    expect(err.phase).toBe("action");
    expect(deps.callOnError).toHaveBeenCalledTimes(1);
  });
});
