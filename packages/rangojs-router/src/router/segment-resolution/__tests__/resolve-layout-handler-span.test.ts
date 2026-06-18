import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { resolveLayoutComponent } from "../helpers.js";
import { runWithRequestContext } from "../../../server/request-context.js";
import { resolveTracing, type SpanRunner } from "../../tracing.js";

/**
 * Span runner that records each span's settle outcome (ok | error), faithful to
 * how the Cloudflare/OTel runners end a span when their callback settles. Lets us
 * assert the rango.handler span is NOT marked errored when a layout handler
 * returns a Response (redirect control flow), and is NOT opened at all for a
 * static / non-function handler.
 */
function lifecycleRunner() {
  const ends: Record<string, "ok" | "error"> = {};
  const runner: SpanRunner = <T>(name: string, fn: (span: never) => T): T => {
    const out = fn({ setAttribute() {} } as never);
    if (out instanceof Promise) {
      return out.then(
        (value) => {
          ends[name] = "ok";
          return value;
        },
        (error) => {
          ends[name] = "error";
          throw error;
        },
      ) as T;
    }
    ends[name] = "ok";
    return out;
  };
  return { ends, runner };
}

describe("resolveLayoutComponent — rango.handler span boundaries", () => {
  it("emits no rango.handler span when the entry handler is a non-function ReactNode", async () => {
    const { ends, runner } = lifecycleRunner();
    const tracing = resolveTracing({ runner })!;
    const node = createElement("div");
    const entry = { id: "L0", shortCode: "L0", handler: node } as never;

    const result = await runWithRequestContext(
      { _tracing: tracing } as never,
      () => resolveLayoutComponent(entry, {} as never),
    );

    expect(result).toBe(node);
    // Static/non-function handler runs no handler → no span opened.
    expect(ends["rango.handler"]).toBeUndefined();
  });

  it("settles rango.handler OK when a handler returns a Response (the throw is outside the span)", async () => {
    const { ends, runner } = lifecycleRunner();
    const tracing = resolveTracing({ runner })!;
    const entry = {
      id: "L0",
      shortCode: "L0",
      handler: () => new Response(null, { status: 302 }),
    } as never;

    // handleHandlerResult (OUTSIDE the span) rethrows the Response as control flow.
    await expect(
      runWithRequestContext({ _tracing: tracing } as never, () =>
        resolveLayoutComponent(entry, {} as never),
      ),
    ).rejects.toBeInstanceOf(Response);

    // The span itself settled on the returned Response value — NOT an error.
    expect(ends["rango.handler"]).toBe("ok");
  });

  it("opens rango.handler for a normal function handler", async () => {
    const { ends, runner } = lifecycleRunner();
    const tracing = resolveTracing({ runner })!;
    const node = createElement("span");
    const entry = { id: "L0", shortCode: "L0", handler: () => node } as never;

    const result = await runWithRequestContext(
      { _tracing: tracing } as never,
      () => resolveLayoutComponent(entry, {} as never),
    );

    expect(result).toBe(node);
    expect(ends["rango.handler"]).toBe("ok");
  });
});
