import { describe, it, expect } from "vitest";
import {
  resolveTracing,
  traceSpan,
  NOOP_TRACE_SPAN,
  type RouterTracingConfig,
  type SpanRunner,
  type TraceSpan,
} from "../tracing.js";

/**
 * Recording runner that mirrors the contract a real platform runner (Cloudflare
 * enterSpan) must honor: invoke fn once, pass a span, return fn's result, and
 * track parent/child nesting via a synchronous stack.
 */
interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  parent: string | undefined;
}

function createRecordingRunner(): {
  runner: SpanRunner;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];
  const stack: RecordedSpan[] = [];
  const runner: SpanRunner = (name, fn) => {
    const record: RecordedSpan = {
      name,
      attributes: {},
      parent: stack[stack.length - 1]?.name,
    };
    spans.push(record);
    const span: TraceSpan = {
      setAttribute(key, value) {
        record.attributes[key] = value;
      },
    };
    stack.push(record);
    try {
      const result = fn(span);
      if (result instanceof Promise) {
        return result.finally(() => {
          stack.pop();
        }) as ReturnType<typeof fn>;
      }
      stack.pop();
      return result;
    } catch (err) {
      stack.pop();
      throw err;
    }
  };
  return { runner, spans };
}

describe("resolveTracing", () => {
  const runner: SpanRunner = (_name, fn) => fn(NOOP_TRACE_SPAN);

  it("returns undefined when no config is provided", () => {
    expect(resolveTracing(undefined)).toBeUndefined();
  });

  it("returns undefined when explicitly disabled", () => {
    expect(resolveTracing({ runner, enabled: false })).toBeUndefined();
  });

  it("returns undefined when the runner is not a function", () => {
    const bad = { runner: undefined } as unknown as RouterTracingConfig;
    expect(resolveTracing(bad)).toBeUndefined();
  });

  it("enables all phases by default", () => {
    const resolved = resolveTracing({ runner });
    expect(resolved?.phases).toEqual({
      request: true,
      middleware: true,
      loader: true,
      render: true,
      ssr: true,
    });
  });

  it("respects per-phase toggles and defaults omitted phases to on", () => {
    const resolved = resolveTracing({
      runner,
      spans: { ssr: false, loader: false },
    });
    expect(resolved?.phases).toEqual({
      request: true,
      middleware: true,
      loader: false,
      render: true,
      ssr: false,
    });
  });

  it("treats enabled:true the same as omitted", () => {
    expect(resolveTracing({ runner, enabled: true })?.runner).toBe(runner);
  });
});

describe("traceSpan", () => {
  it("is a pass-through when tracing is undefined", () => {
    let received: TraceSpan | undefined;
    const out = traceSpan(undefined, "request", "rango.request", (span) => {
      received = span;
      return "value";
    });
    expect(out).toBe("value");
    expect(received).toBe(NOOP_TRACE_SPAN);
  });

  it("does not throw when setting attributes on the no-op span", () => {
    expect(() =>
      traceSpan(undefined, "loader", "rango.loader", (span) => {
        span.setAttribute("k", "v");
        span.setAttribute("n", 1);
        span.setAttribute("b", true);
      }),
    ).not.toThrow();
  });

  it("runs fn directly (no runner call) when the phase is disabled", () => {
    const { runner, spans } = createRecordingRunner();
    const tracing = resolveTracing({ runner, spans: { loader: false } });
    const out = traceSpan(tracing, "loader", "rango.loader", () => "x");
    expect(out).toBe("x");
    expect(spans).toHaveLength(0);
  });

  it("wraps fn in a span when the phase is enabled", () => {
    const { runner, spans } = createRecordingRunner();
    const tracing = resolveTracing({ runner });
    const out = traceSpan(tracing, "request", "rango.request", (span) => {
      span.setAttribute("http.method", "GET");
      return 7;
    });
    expect(out).toBe(7);
    expect(spans).toEqual([
      {
        name: "rango.request",
        attributes: { "http.method": "GET" },
        parent: undefined,
      },
    ]);
  });

  it("nests spans by call order", () => {
    const { runner, spans } = createRecordingRunner();
    const tracing = resolveTracing({ runner });
    traceSpan(tracing, "request", "rango.request", () =>
      traceSpan(tracing, "render", "rango.render", () =>
        traceSpan(tracing, "ssr", "rango.ssr", () => "done"),
      ),
    );
    expect(spans.map((s) => [s.name, s.parent])).toEqual([
      ["rango.request", undefined],
      ["rango.render", "rango.request"],
      ["rango.ssr", "rango.render"],
    ]);
  });

  it("propagates a thrown error and still records the span", () => {
    const { runner, spans } = createRecordingRunner();
    const tracing = resolveTracing({ runner });
    expect(() =>
      traceSpan(tracing, "middleware", "rango.middleware", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(spans).toHaveLength(1);
  });

  it("preserves an async return value and resolves the span on settle", async () => {
    const { runner, spans } = createRecordingRunner();
    const tracing = resolveTracing({ runner });
    const out = await traceSpan(tracing, "loader", "rango.loader", async () => {
      await Promise.resolve();
      return "async-value";
    });
    expect(out).toBe("async-value");
    expect(spans).toEqual([
      { name: "rango.loader", attributes: {}, parent: undefined },
    ]);
  });

  it("propagates an async rejection", async () => {
    const { runner } = createRecordingRunner();
    const tracing = resolveTracing({ runner });
    await expect(
      traceSpan(tracing, "loader", "rango.loader", async () => {
        throw new Error("async-boom");
      }),
    ).rejects.toThrow("async-boom");
  });
});
