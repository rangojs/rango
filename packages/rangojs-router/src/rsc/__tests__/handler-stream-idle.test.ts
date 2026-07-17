/**
 * Handler-level tests for the stream-idle watchdog wiring (timeouts.
 * streamIdleMs): applied at the response finalization tail, opt-in only,
 * never touching websocket upgrades or bodiless responses, reporting a trip
 * through onError and the request.timeout telemetry event (phase
 * "stream-idle") via the post-handoff emit pattern.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Registers the shared createRSCHandler dependency mocks; must stay the first
// non-vitest import so the mocks land before ../handler.js loads.
import "./handler-test-mocks.js";

import { createRSCHandler } from "../handler.js";
import { handleResponseRoute } from "../response-route-handler.js";
import { safeEmit } from "../../router/telemetry.js";
import { RouterTimeoutError } from "../../router/timeout.js";
import type { RangoInternal } from "../../router/router-interfaces.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createMockRouter(
  overrides: Partial<RangoInternal<unknown, any>> = {},
): RangoInternal<unknown, any> {
  return {
    id: "test-router",
    middleware: [],
    timeouts: { renderStartMs: 30000, actionMs: 30000 },
    debugPerformance: false,
    findMatch: vi.fn(() => ({
      entry: {},
      routeKey: "test",
      params: {},
      responseType: "json",
    })),
    previewMatch: vi.fn(async () => null),
    match: vi.fn(async () => ({
      segments: [],
      matched: [],
      diff: [],
      params: {},
    })),
    matchError: vi.fn(async () => null),
    rootLayout: undefined,
    themeConfig: undefined,
    warmupEnabled: false,
    ...overrides,
  } as any;
}

/** A body that emits one chunk and then wedges (never closes). */
function hangingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      // never closes, never enqueues again
    },
  });
}

describe("handler stream-idle wiring", () => {
  it("errors a wedged stream after streamIdleMs and reports via onError + telemetry", async () => {
    const onError = vi.fn();
    const router = createMockRouter({
      timeouts: { renderStartMs: 30000, actionMs: 30000, streamIdleMs: 30 },
      onError,
      telemetry: { emit: vi.fn() },
    } as never);
    vi.mocked(handleResponseRoute).mockResolvedValueOnce(
      new Response(hangingBody(), { status: 200 }),
    );

    const handler = createRSCHandler({ router });
    const res = await handler(new Request("https://example.com/api/hang"), {
      env: {},
    });

    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");

    let error: unknown;
    try {
      await reader.read();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RouterTimeoutError);
    expect((error as RouterTimeoutError).phase).toBe("stream-idle");

    // onError fired with the trip (post-handoff reporting path).
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].error).toBe(error);

    // request.timeout emitted with the stream-idle phase; onTimeout cannot
    // apply mid-stream, so customHandler is always false.
    const emitted = vi
      .mocked(safeEmit)
      .mock.calls.map((c) => c[1] as { type: string; phase?: string });
    const timeoutEvent = emitted.find((e) => e.type === "request.timeout");
    expect(timeoutEvent).toMatchObject({
      type: "request.timeout",
      phase: "stream-idle",
      pathname: "/api/hang",
      customHandler: false,
    });
  });

  it("leaves the response untouched when streamIdleMs is not configured", async () => {
    const router = createMockRouter();
    const hanging = new Response(hangingBody(), { status: 200 });
    vi.mocked(handleResponseRoute).mockResolvedValueOnce(hanging);

    const handler = createRSCHandler({ router });
    const res = await handler(new Request("https://example.com/api/hang"), {
      env: {},
    });
    // Identity preserved: no watchdog wrap without the opt-in.
    expect(res).toBe(hanging);
  });

  it("never wraps a websocket upgrade response even when enabled", async () => {
    const router = createMockRouter({
      timeouts: { renderStartMs: 30000, actionMs: 30000, streamIdleMs: 30 },
    } as never);
    const upgrade = new Response(hangingBody(), { status: 200 });
    (upgrade as unknown as { webSocket: object }).webSocket = {};
    vi.mocked(handleResponseRoute).mockResolvedValueOnce(upgrade);

    const handler = createRSCHandler({ router });
    const res = await handler(new Request("https://example.com/api/ws"), {
      env: {},
    });
    expect(res).toBe(upgrade);
  });

  it("skips bodiless responses when enabled", async () => {
    const router = createMockRouter({
      timeouts: { renderStartMs: 30000, actionMs: 30000, streamIdleMs: 30 },
    } as never);
    const empty = new Response(null, { status: 204 });
    vi.mocked(handleResponseRoute).mockResolvedValueOnce(empty);

    const handler = createRSCHandler({ router });
    const res = await handler(new Request("https://example.com/api/empty"), {
      env: {},
    });
    expect(res).toBe(empty);
  });
});
