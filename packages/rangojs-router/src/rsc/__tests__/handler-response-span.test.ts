/**
 * Handler-level tests for the rango.response phase span: the explicit
 * final-response-construction/host-handoff marker at the tail of the request
 * pipeline. Pins the contract: at most one span per request, direct child of
 * rango.request, opened only AFTER downstream execution returned a response,
 * attributes describe the response actually handed to the host (after redirect
 * interception/guarding), response identity/body untouched, absent both when
 * the request throws and when toggled off via spans:{response:false}.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Registers the shared createRSCHandler dependency mocks; must stay the first
// non-vitest import so the mocks land before ../handler.js loads.
import "./handler-test-mocks.js";

import { createRSCHandler } from "../handler.js";
import { handleResponseRoute } from "../response-route-handler.js";
import {
  resolveTracing,
  type SpanRunner,
  type TracePhaseToggles,
} from "../../router/tracing.js";
import type { RangoInternal } from "../../router/router-interfaces.js";

afterEach(() => {
  vi.restoreAllMocks();
});

interface RecordedSpan {
  name: string;
  parent: string | undefined;
  attributes: Record<string, string | number | boolean>;
}

/**
 * Recording runner with parent tracking via a synchronous stack (the same
 * contract enterSpan honors: parentage fixed at call time, popped on settle).
 */
function createRecordingRunner(): {
  runner: SpanRunner;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];
  const stack: RecordedSpan[] = [];
  const runner: SpanRunner = (name, fn) => {
    const record: RecordedSpan = {
      name,
      parent: stack[stack.length - 1]?.name,
      attributes: {},
    };
    spans.push(record);
    stack.push(record);
    const pop = () => {
      stack.splice(stack.indexOf(record), 1);
    };
    try {
      const out = fn({
        setAttribute(key, value) {
          record.attributes[key] = value;
        },
      });
      if (out instanceof Promise) {
        return out.finally(pop) as ReturnType<typeof fn>;
      }
      pop();
      return out;
    } catch (err) {
      pop();
      throw err;
    }
  };
  return { runner, spans };
}

function createMockRouter(
  overrides: Partial<RangoInternal<unknown, any>> = {},
  spanToggles?: TracePhaseToggles,
): { router: RangoInternal<unknown, any>; spans: RecordedSpan[] } {
  const { runner, spans } = createRecordingRunner();
  const router = {
    id: "test-router",
    middleware: [],
    timeouts: { renderStartMs: 30000, actionMs: 30000 },
    debugPerformance: false,
    tracing: resolveTracing({ runner, spans: spanToggles }),
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
  return { router, spans };
}

const responseSpans = (spans: RecordedSpan[]) =>
  spans.filter((s) => s.name === "rango.response");

describe("rango.response handler span", () => {
  it("emits exactly one span, last, as a direct child of rango.request, describing the returned response", async () => {
    const { router, spans } = createMockRouter();
    // Pin the exact Response instance so identity through the handler is
    // provable: the span must describe it without replacing or wrapping it.
    const routeResponse = new Response("payload", { status: 201 });
    vi.mocked(handleResponseRoute).mockResolvedValueOnce(routeResponse);

    const handler = createRSCHandler({ router });
    const out = await handler(new Request("https://example.com/api/data"), {
      env: {},
    });

    // Identity untouched: the exact downstream Response is handed back, body
    // unconsumed and undisturbed.
    expect(out).toBe(routeResponse);
    expect(out.bodyUsed).toBe(false);
    expect(await out.text()).toBe("payload");

    const found = responseSpans(spans);
    expect(found).toHaveLength(1);
    expect(found[0].parent).toBe("rango.request");
    // Handoff-bound: it must be the LAST span opened — after downstream
    // execution (and its rango.* spans) already produced the response.
    expect(spans[spans.length - 1].name).toBe("rango.response");
    expect(found[0].attributes).toEqual({
      "http.response.status_code": 201,
      "rango.response.mode": "response",
      "rango.response.body_kind": "stream",
    });
  });

  it("covers a middleware short-circuit and reports mode middleware-short-circuit", async () => {
    const { router, spans } = createMockRouter({
      middleware: [
        {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: async () => new Response(null, { status: 204 }),
        },
      ],
    } as never);

    const handler = createRSCHandler({ router });
    const out = await handler(new Request("https://example.com/gated"), {
      env: {},
    });

    expect(out.status).toBe(204);
    const found = responseSpans(spans);
    expect(found).toHaveLength(1);
    expect(found[0].attributes).toEqual({
      "http.response.status_code": 204,
      "rango.response.mode": "middleware-short-circuit",
      "rango.response.body_kind": "empty",
    });
  });

  it("describes the FINAL selected response when a partial redirect is intercepted", async () => {
    // Middleware short-circuits with a 302; _rsc_partial converts it into a
    // 204 soft-redirect (X-RSC-Redirect) INSIDE the response phase. The
    // attributes must describe that final response, not the middleware's 302.
    const { router, spans } = createMockRouter({
      middleware: [
        {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: async () =>
            new Response(null, {
              status: 302,
              headers: { Location: "/other" },
            }),
        },
      ],
    } as never);

    const handler = createRSCHandler({ router });
    const out = await handler(
      new Request("https://example.com/?_rsc_partial=1", {
        headers: { accept: "text/x-component" },
      }),
      { env: {} },
    );

    expect(out.status).toBe(204);
    expect(out.headers.get("X-RSC-Redirect")).toBeTruthy();
    const found = responseSpans(spans);
    expect(found).toHaveLength(1);
    expect(found[0].attributes["http.response.status_code"]).toBe(204);
    expect(found[0].attributes["rango.response.body_kind"]).toBe("empty");
  });

  it("describes the guarded response for a browser-followed redirect", async () => {
    // Cross-origin 302 without { external: true } is neutralized by
    // guardOutgoingRedirect into a NEW same-origin-landing Response. The span
    // attributes are set from that final guarded response.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { router, spans } = createMockRouter({
      middleware: [
        {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: async () =>
            new Response(null, {
              status: 302,
              headers: { Location: "https://evil.example.net/" },
            }),
        },
      ],
    } as never);

    const handler = createRSCHandler({ router });
    const out = await handler(new Request("https://example.com/leave"), {
      env: {},
    });

    expect(out.headers.get("Location")).toBe("/");
    const found = responseSpans(spans);
    expect(found).toHaveLength(1);
    expect(found[0].attributes).toEqual({
      "http.response.status_code": 302,
      "rango.response.mode": "middleware-short-circuit",
      "rango.response.body_kind": "empty",
    });
  });

  it("reports body_kind websocket without poking the upgrade response", async () => {
    // workerd attaches a non-standard webSocket property; the span must
    // classify it via the marker, not by touching body/headers.
    const upgrade = new Response(null, { status: 200 });
    (upgrade as unknown as { webSocket: object }).webSocket = {};
    vi.mocked(handleResponseRoute).mockResolvedValueOnce(upgrade);

    const { router, spans } = createMockRouter();
    const handler = createRSCHandler({ router });
    const out = await handler(new Request("https://example.com/api/ws"), {
      env: {},
    });

    expect(out).toBe(upgrade);
    const found = responseSpans(spans);
    expect(found).toHaveLength(1);
    expect(found[0].attributes["rango.response.body_kind"]).toBe("websocket");
  });

  it("is absent when the request throws before a response exists", async () => {
    const { router, spans } = createMockRouter({
      middleware: [
        {
          pattern: null,
          regex: null,
          paramNames: [],
          handler: async () => {
            throw new Error("middleware exploded");
          },
        },
      ],
    } as never);

    const handler = createRSCHandler({ router });
    await expect(
      handler(new Request("https://example.com/boom"), { env: {} }),
    ).rejects.toThrow("middleware exploded");

    expect(spans.map((s) => s.name)).toContain("rango.request");
    expect(responseSpans(spans)).toHaveLength(0);
  });

  it("spans:{response:false} suppresses only the response span", async () => {
    const { router, spans } = createMockRouter({}, { response: false });
    const handler = createRSCHandler({ router });
    const out = await handler(new Request("https://example.com/api/data"), {
      env: {},
    });

    expect(out.status).toBe(200);
    expect(spans.map((s) => s.name)).toContain("rango.request");
    expect(responseSpans(spans)).toHaveLength(0);
  });
});
