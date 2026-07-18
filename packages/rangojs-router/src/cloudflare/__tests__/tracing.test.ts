import { describe, it, expect } from "vitest";
import { createCloudflareTracing } from "../tracing.js";
import { resolveTracing, traceSpan } from "../../router/tracing.js";
import { runWithRequestContext } from "../../server/request-context.js";

/**
 * Fake Cloudflare `tracing` object (the shape exposed as
 * `executionContext.tracing` and `import { tracing } from "cloudflare:workers"`).
 * Records every enterSpan call with parent nesting via a synchronous stack.
 */
function createFakeCfTracing() {
  const spans: Array<{
    name: string;
    parent: string | undefined;
    attributes: Record<string, unknown>;
    isTraced: boolean;
  }> = [];
  const stack: string[] = [];
  const tracing = {
    enterSpan<T>(
      name: string,
      callback: (span: {
        isTraced: boolean;
        setAttribute(key: string, value?: unknown): void;
      }) => T,
    ): T {
      const record = {
        name,
        parent: stack[stack.length - 1],
        attributes: {} as Record<string, unknown>,
        isTraced: true,
      };
      spans.push(record);
      stack.push(name);
      const span = {
        isTraced: true,
        setAttribute(key: string, value?: unknown) {
          record.attributes[key] = value;
        },
      };
      try {
        const out = callback(span);
        if (out instanceof Promise) {
          return out.finally(() => stack.pop()) as T;
        }
        stack.pop();
        return out;
      } catch (err) {
        stack.pop();
        throw err;
      }
    },
  };
  return { tracing, spans };
}

function withExecutionContext<T>(executionContext: unknown, fn: () => T): T {
  // Minimal request context carrying only the execution context the
  // Cloudflare runner reads. Cast is intentional: the runner only touches
  // executionContext, so the rest of the request context is irrelevant here.
  return runWithRequestContext({ executionContext } as never, fn);
}

describe("createCloudflareTracing", () => {
  it("builds an enabled config with the cloudflare runner", () => {
    const config = createCloudflareTracing();
    expect(config.enabled).toBe(true);
    expect(typeof config.runner).toBe("function");
  });

  it("forwards enabled and spans options", () => {
    const config = createCloudflareTracing({
      enabled: false,
      spans: { ssr: false },
    });
    expect(config.enabled).toBe(false);
    expect(config.spans).toEqual({ ssr: false });
  });

  it("emits a Cloudflare span from executionContext.tracing", () => {
    const { tracing, spans } = createFakeCfTracing();
    const resolved = resolveTracing(createCloudflareTracing());

    const out = withExecutionContext({ tracing }, () =>
      traceSpan(resolved, "request", "rango.request", (span) => {
        span.setAttribute("http.method", "GET");
        return 123;
      }),
    );

    expect(out).toBe(123);
    expect(spans).toEqual([
      {
        name: "rango.request",
        parent: undefined,
        attributes: { "http.method": "GET" },
        isTraced: true,
      },
    ]);
  });

  it("nests spans by async context across the fake runtime", () => {
    const { tracing, spans } = createFakeCfTracing();
    const resolved = resolveTracing(createCloudflareTracing());

    withExecutionContext({ tracing }, () =>
      traceSpan(resolved, "request", "rango.request", () =>
        traceSpan(resolved, "render", "rango.render", () =>
          traceSpan(resolved, "loader", "rango.loader", () => "ok"),
        ),
      ),
    );

    expect(spans.map((s) => [s.name, s.parent])).toEqual([
      ["rango.request", undefined],
      ["rango.render", "rango.request"],
      ["rango.loader", "rango.render"],
    ]);
  });

  it("omits a disabled phase span while siblings still emit", () => {
    const { tracing, spans } = createFakeCfTracing();
    const resolved = resolveTracing(
      createCloudflareTracing({ spans: { loader: false } }),
    );

    const out = withExecutionContext({ tracing }, () =>
      traceSpan(resolved, "request", "rango.request", () =>
        traceSpan(resolved, "render", "rango.render", () =>
          traceSpan(resolved, "loader", "rango.loader", () => "ok"),
        ),
      ),
    );

    expect(out).toBe("ok");
    const names = spans.map((s) => s.name);
    expect(names).toContain("rango.request");
    expect(names).toContain("rango.render");
    expect(names).not.toContain("rango.loader");
  });

  it("emits rango.response nested under the request; spans:{response:false} suppresses only it", () => {
    // Parity with the OTel/Vercel runners: the response phase is a first-class
    // toggleable phase on every platform.
    const on = createFakeCfTracing();
    const resolvedOn = resolveTracing(createCloudflareTracing());
    withExecutionContext({ tracing: on.tracing }, () =>
      traceSpan(resolvedOn, "request", "rango.request", () =>
        traceSpan(resolvedOn, "response", "rango.response", () => "ok"),
      ),
    );
    expect(on.spans.map((s) => [s.name, s.parent])).toEqual([
      ["rango.request", undefined],
      ["rango.response", "rango.request"],
    ]);

    const off = createFakeCfTracing();
    const resolvedOff = resolveTracing(
      createCloudflareTracing({ spans: { response: false } }),
    );
    const out = withExecutionContext({ tracing: off.tracing }, () =>
      traceSpan(resolvedOff, "request", "rango.request", () =>
        traceSpan(resolvedOff, "response", "rango.response", () => "ok"),
      ),
    );
    expect(out).toBe("ok");
    expect(off.spans.map((s) => s.name)).toEqual(["rango.request"]);
  });

  it("falls through to the work when there is no execution context", () => {
    const resolved = resolveTracing(createCloudflareTracing());
    // No request context at all (outside runWithRequestContext).
    const out = traceSpan(resolved, "request", "rango.request", () => "direct");
    expect(out).toBe("direct");
  });

  it("falls through when executionContext has no tracing", () => {
    const resolved = resolveTracing(createCloudflareTracing());
    const out = withExecutionContext({}, () =>
      traceSpan(resolved, "request", "rango.request", () => "direct"),
    );
    expect(out).toBe("direct");
  });

  it("falls through when tracing lacks a usable enterSpan", () => {
    const resolved = resolveTracing(createCloudflareTracing());
    const out = withExecutionContext({ tracing: { enterSpan: 42 } }, () =>
      traceSpan(resolved, "request", "rango.request", () => "direct"),
    );
    expect(out).toBe("direct");
  });
});
