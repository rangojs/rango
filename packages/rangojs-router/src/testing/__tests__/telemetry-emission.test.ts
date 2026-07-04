import { describe, it, expect } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc, whose
// top-level body imports Vite virtual modules that do not resolve in plain
// node/vitest. dispatch() itself never renders RSC, so a stub is sufficient
// (same recipe as dispatch.test.ts).
import { vi } from "vitest";
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  createFromReadableStream: vi.fn(),
  renderToReadableStream: vi.fn(),
  loadServerAction: vi.fn(),
  decodeReply: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
  createTemporaryReferenceSet: vi.fn(),
}));

import { dispatch } from "../dispatch.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import type { MiddlewareFn } from "../../router/middleware.js";
import type {
  TelemetryEvent,
  TelemetrySink,
  RequestStartEvent,
  RequestEndEvent,
  RequestErrorEvent,
} from "../../router/telemetry.js";

// Pins dispatch's match-transaction telemetry emission — the dogfood gap the
// RSC-free dispatch left: a consumer configuring createRouter({ telemetry })
// could not, before this, unit-test that their sink receives lifecycle events
// without an e2e run. dispatch owns only request.start/end/error; cache.decision
// and loader.* originate in the real match()/RSC pipeline dispatch does not run.

function collectSink(): { sink: TelemetrySink; events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  const sink: TelemetrySink = {
    emit(event: TelemetryEvent): void {
      events.push(event);
    },
  };
  return { sink, events };
}

describe("dispatch telemetry emission", () => {
  it("emits request.start then request.end sharing one requestId for a response route", async () => {
    const { sink, events } = collectSink();
    let mwRan = false;
    const tagMw: MiddlewareFn = async (_ctx, next) => {
      mwRan = true;
      return next();
    };
    const router = createRouter<{}>({ telemetry: sink })
      .use(tagMw)
      .routes(
        urls(({ path }) => [
          path.json("/api/data", () => ({ hello: "world" }), {
            name: "api.data",
          }),
        ]),
      ) as Parameters<typeof dispatch>[0];

    const res = await dispatch(router, { request: "/api/data" });
    expect(res.status).toBe(200);
    expect(mwRan).toBe(true);

    const starts = events.filter(
      (e): e is RequestStartEvent => e.type === "request.start",
    );
    const ends = events.filter(
      (e): e is RequestEndEvent => e.type === "request.end",
    );
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(events.some((e) => e.type === "request.error")).toBe(false);

    const start = starts[0]!;
    const end = ends[0]!;
    expect(start.transaction).toBe("match");
    expect(start.isPartial).toBe(false);
    expect(start.method).toBe("GET");
    expect(start.pathname).toBe("/api/data");
    expect(end.transaction).toBe("match");
    expect(end.method).toBe("GET");
    expect(end.pathname).toBe("/api/data");
    // One correlation id spans the whole transaction.
    expect(start.requestId).toBeDefined();
    expect(end.requestId).toBe(start.requestId);
    // Duration is a finite, non-negative number.
    expect(Number.isFinite(end.durationMs)).toBe(true);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
    // dispatch renders no RSC segments and holds no match-cache state.
    expect(end.segmentCount).toBe(0);
    expect(end.cacheHit).toBe(false);
  });

  it("carries isPartial=true on a partial (?_rsc_partial) request", async () => {
    const { sink, events } = collectSink();
    const router = createRouter<{}>({ telemetry: sink }).routes(
      urls(({ path }) => [
        path.json("/api/data", () => ({ hello: "world" }), {
          name: "api.data",
        }),
      ]),
    ) as Parameters<typeof dispatch>[0];

    await dispatch(router, { request: "/api/data?_rsc_partial=1" });

    const start = events.find(
      (e): e is RequestStartEvent => e.type === "request.start",
    )!;
    expect(start.isPartial).toBe(true);
    expect(events.some((e) => e.type === "request.end")).toBe(true);
  });

  it("emits request.error (phase routing) and NO request.end when middleware throws a non-Response error", async () => {
    const { sink, events } = collectSink();
    const boomMw: MiddlewareFn = async () => {
      throw new Error("mw boom");
    };
    const router = createRouter<{}>({ telemetry: sink })
      .use(boomMw)
      .routes(
        urls(({ path }) => [
          path.json("/api/data", () => ({ ok: true }), { name: "api.data" }),
        ]),
      ) as Parameters<typeof dispatch>[0];

    await expect(dispatch(router, { request: "/api/data" })).rejects.toThrow(
      "mw boom",
    );

    const errors = events.filter(
      (e): e is RequestErrorEvent => e.type === "request.error",
    );
    expect(errors).toHaveLength(1);
    expect(events.some((e) => e.type === "request.end")).toBe(false);
    // request.start still opened the transaction before the throw.
    expect(events.some((e) => e.type === "request.start")).toBe(true);

    const err = errors[0]!;
    expect(err.phase).toBe("routing");
    expect(err.transaction).toBe("match");
    expect(err.error).toBeInstanceOf(Error);
    expect(err.error.message).toBe("mw boom");
    expect(err.requestId).toBeDefined();
  });

  it("is inert without a sink: identical response, and the lifecycle only fires when a sink is present", async () => {
    const build = (sink?: TelemetrySink): Parameters<typeof dispatch>[0] =>
      createRouter<{}>(sink ? { telemetry: sink } : {}).routes(
        urls(({ path }) => [
          path.json("/api/data", () => ({ hello: "world" }), {
            name: "api.data",
          }),
        ]),
      ) as Parameters<typeof dispatch>[0];

    const { sink, events } = collectSink();
    const withSink = await dispatch(build(sink), { request: "/api/data" });
    const noSink = await dispatch(build(), { request: "/api/data" });

    expect(withSink.status).toBe(noSink.status);
    expect(withSink.headers.get("content-type")).toBe(
      noSink.headers.get("content-type"),
    );
    expect(await withSink.json()).toEqual(await noSink.json());
    // With a sink the lifecycle fired exactly once; the no-sink router has
    // nowhere to emit and produced the same Response.
    expect(events.map((e) => e.type)).toEqual(["request.start", "request.end"]);
  });
});
