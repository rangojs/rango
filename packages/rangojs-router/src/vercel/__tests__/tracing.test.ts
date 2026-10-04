import { describe, it, expect, afterEach } from "vitest";
import { trace } from "@opentelemetry/api";
import { createVercelTracing } from "../tracing.js";
import { resolveTracing, traceSpan } from "../../router/tracing.js";
import type { OTelSpan } from "../../router/telemetry-otel.js";

/**
 * Minimal OTel-shaped tracer recording every startActiveSpan call with parent
 * nesting via a synchronous active stack (mirrors telemetry-otel.test.ts).
 */
function createMockOtelTracer() {
  const spans: Array<{
    name: string;
    parent: string | undefined;
    attributes: Record<string, unknown>;
    ended: boolean;
  }> = [];
  const activeStack: string[] = [];
  const tracer = {
    startActiveSpan<T>(name: string, fn: (span: OTelSpan) => T): T {
      const record = {
        name,
        parent: activeStack[activeStack.length - 1],
        attributes: {} as Record<string, unknown>,
        ended: false,
      };
      spans.push(record);
      activeStack.push(name);
      const span: OTelSpan = {
        setAttribute(key: string, value: string | number | boolean) {
          record.attributes[key] = value;
          return span;
        },
        setStatus() {
          return span;
        },
        recordException() {},
        end() {
          record.ended = true;
        },
      };
      const settle = () => {
        activeStack.pop();
      };
      try {
        const out = fn(span);
        if (out instanceof Promise) return out.finally(settle) as T;
        settle();
        return out;
      } catch (err) {
        settle();
        throw err;
      }
    },
  };
  return { tracer, spans };
}

describe("createVercelTracing", () => {
  afterEach(() => {
    // Reset the global OTel provider registered by the default-tracer tests.
    trace.disable();
  });

  it("builds an enabled config with an OTel-backed runner", () => {
    const { tracer } = createMockOtelTracer();
    const config = createVercelTracing({ tracer });
    expect(config.enabled).toBe(true);
    expect(typeof config.runner).toBe("function");
  });

  it("forwards enabled and spans options", () => {
    const { tracer } = createMockOtelTracer();
    const config = createVercelTracing({
      tracer,
      enabled: false,
      spans: { ssr: false },
    });
    expect(config.enabled).toBe(false);
    expect(config.spans).toEqual({ ssr: false });
  });

  it("emits an OTel span from the provided tracer", () => {
    const { tracer, spans } = createMockOtelTracer();
    const resolved = resolveTracing(createVercelTracing({ tracer }));

    const out = traceSpan(resolved, "request", "rango.request", (span) => {
      span.setAttribute("http.method", "GET");
      return 123;
    });

    expect(out).toBe(123);
    expect(spans).toEqual([
      {
        name: "rango.request",
        parent: undefined,
        attributes: { "http.method": "GET" },
        ended: true,
      },
    ]);
  });

  it("nests spans by async context", () => {
    const { tracer, spans } = createMockOtelTracer();
    const resolved = resolveTracing(createVercelTracing({ tracer }));

    traceSpan(resolved, "request", "rango.request", () =>
      traceSpan(resolved, "render", "rango.render", () =>
        traceSpan(resolved, "loader", "rango.loader", () => "ok"),
      ),
    );

    expect(spans.map((s) => [s.name, s.parent])).toEqual([
      ["rango.request", undefined],
      ["rango.render", "rango.request"],
      ["rango.loader", "rango.render"],
    ]);
  });

  it("omits a disabled phase span while siblings still emit", () => {
    const { tracer, spans } = createMockOtelTracer();
    const resolved = resolveTracing(
      createVercelTracing({ tracer, spans: { loader: false } }),
    );

    const out = traceSpan(resolved, "request", "rango.request", () =>
      traceSpan(resolved, "render", "rango.render", () =>
        traceSpan(resolved, "loader", "rango.loader", () => "ok"),
      ),
    );

    expect(out).toBe("ok");
    const names = spans.map((s) => s.name);
    expect(names).toContain("rango.request");
    expect(names).toContain("rango.render");
    expect(names).not.toContain("rango.loader");
  });

  it("emits rango.response nested under the request; spans:{response:false} suppresses only it", () => {
    // Parity with the Cloudflare runner: the response phase is a first-class
    // toggleable phase on every platform.
    const on = createMockOtelTracer();
    const resolvedOn = resolveTracing(
      createVercelTracing({ tracer: on.tracer }),
    );
    traceSpan(resolvedOn, "request", "rango.request", () =>
      traceSpan(resolvedOn, "response", "rango.response", () => "ok"),
    );
    expect(on.spans.map((s) => [s.name, s.parent])).toEqual([
      ["rango.request", undefined],
      ["rango.response", "rango.request"],
    ]);

    const off = createMockOtelTracer();
    const resolvedOff = resolveTracing(
      createVercelTracing({ tracer: off.tracer, spans: { response: false } }),
    );
    const out = traceSpan(resolvedOff, "request", "rango.request", () =>
      traceSpan(resolvedOff, "response", "rango.response", () => "ok"),
    );
    expect(out).toBe("ok");
    expect(off.spans.map((s) => s.name)).toEqual(["rango.request"]);
  });

  it("defaults to the global OTel tracer when none is provided", () => {
    const { tracer, spans } = createMockOtelTracer();
    const getTracerCalls: Array<string | undefined> = [];
    trace.setGlobalTracerProvider({
      getTracer(name?: string) {
        getTracerCalls.push(name);
        return tracer as never;
      },
    } as never);

    const resolved = resolveTracing(createVercelTracing());
    traceSpan(resolved, "request", "rango.request", () => "ok");

    expect(getTracerCalls).toEqual(["rango"]); // default tracerName
    expect(spans.map((s) => s.name)).toEqual(["rango.request"]);
  });

  it("passes a custom tracerName to the global provider", () => {
    const { tracer } = createMockOtelTracer();
    const getTracerCalls: Array<string | undefined> = [];
    trace.setGlobalTracerProvider({
      getTracer(name?: string) {
        getTracerCalls.push(name);
        return tracer as never;
      },
    } as never);

    createVercelTracing({ tracerName: "my-app" });
    expect(getTracerCalls).toEqual(["my-app"]);
  });
});
