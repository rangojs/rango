/**
 * The PPR background shell capture re-runs router.match under a derived request
 * context flagged `_shellCaptureRun: true`. That background render must be
 * INVISIBLE to a configured TelemetrySink: it re-uses the foreground Request, so
 * a second request.start/cache.decision/request.end pair (stamped with the same
 * WeakMap-keyed requestId) would double-count latency dashboards and let a
 * background render masquerade as a foreground request.
 *
 * match()/matchPartial() derive `emitTelemetry = hasTelemetry &&
 * !_getRequestContext()?._shellCaptureRun` — so with the flag set (capture),
 * ZERO events reach the sink; without it (foreground), request.start still
 * arrives. Drives createMatchHandlers with a recording sink under the REAL
 * request-context ALS (only the flag differs between runs).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TelemetryEvent, TelemetrySink } from "../telemetry.js";
import { runWithRequestContext } from "../../server/request-context.js";

const mockCtx = {
  request: new Request("http://localhost/blog"),
  url: new URL("http://localhost/blog"),
  prevUrl: new URL("http://localhost/prev"),
  routeKey: "blog.route",
  stale: false,
  manifestEntry: { type: "route", ppr: false },
};

const OK_RESULT = {
  segments: [],
  matched: [],
  diff: [],
  resolvedIds: [],
  params: {},
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

describe("PPR shell-capture telemetry suppression (_shellCaptureRun)", () => {
  beforeEach(() => {
    (collectMatchResult as any).mockReset();
    (collectMatchResult as any).mockResolvedValue(OK_RESULT);
  });

  it("match() emits ZERO events when run under a _shellCaptureRun context", async () => {
    const { sink, events } = recordingSink();
    const handlers = createMatchHandlers(makeDeps(sink));

    await runWithRequestContext({ _shellCaptureRun: true } as never, () =>
      handlers.match(new Request("http://localhost/blog"), {}),
    );

    expect(events).toEqual([]);
  });

  it("match() still emits request.start for a normal (non-capture) request", async () => {
    const { sink, events } = recordingSink();
    const handlers = createMatchHandlers(makeDeps(sink));

    await handlers.match(new Request("http://localhost/blog"), {});

    const types = events.map((e) => e.type);
    expect(types).toContain("request.start");
    expect(types).toContain("request.end");
  });

  it("matchPartial() emits ZERO events when run under a _shellCaptureRun context", async () => {
    const { sink, events } = recordingSink();
    const handlers = createMatchHandlers(makeDeps(sink));

    await runWithRequestContext({ _shellCaptureRun: true } as never, () =>
      handlers.matchPartial(new Request("http://localhost/blog"), {}),
    );

    expect(events).toEqual([]);
  });

  it("matchPartial() still emits request.start for a normal (non-capture) request", async () => {
    const { sink, events } = recordingSink();
    const handlers = createMatchHandlers(makeDeps(sink));

    await handlers.matchPartial(new Request("http://localhost/blog"), {});

    const types = events.map((e) => e.type);
    expect(types).toContain("request.start");
    expect(types).toContain("request.end");
  });
});
