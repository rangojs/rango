/**
 * A navigation reports a page's handlers as its document does: the same
 * `handler:<id>` Server-Timing rows (debugPerformance), the same
 * rango.handler spans (tracing), and the same dev warning for a streamed
 * slot handler that returns a Response. Served through the production
 * request handler (serveShellRequest); the navigation holds nothing, so
 * every handler runs on both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import {
  createOTelTracing,
  createRouter,
  urls,
  type OTelActiveSpanTracer,
  type OTelSpan,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

let handlerSpans: string[] = [];

const tracer: OTelActiveSpanTracer = {
  startActiveSpan<T>(name: string, fn: (span: OTelSpan) => T): T {
    const handle: OTelSpan = {
      setAttribute(key, value) {
        if (name === "rango.handler" && key === "rango.handler_id") {
          handlerSpans.push(String(value));
        }
        return handle;
      },
      setStatus() {
        return handle;
      },
      recordException() {},
      end() {},
    };
    return fn(handle);
  },
};

const router = createRouter({
  debugPerformance: true,
  tracing: createOTelTracing(tracer),
}).routes(
  urls(({ path, layout, parallel, loading }) => [
    layout(
      () => <main>shell</main>,
      () => [
        path("/home", () => <p>home</p>, { name: "home" }),
        layout(
          () => <section>slots</section>,
          () => [
            parallel({ "@side": () => <aside>side</aside> }),
            path("/slots", () => <p>slots page</p>, { name: "slots" }),
          ],
        ),
        // A layout among a route's children: an orphan of the route.
        path(
          "/orphan",
          () => <p>orphan page</p>,
          { name: "orphan" },
          () => [
            layout(
              () => <nav>orphan layout</nav>,
              () => [parallel({ "@aside": () => <aside>aside</aside> })],
            ),
          ],
        ),
        layout(
          () => <section>response slot</section>,
          () => [
            parallel(
              {
                "@response": async () =>
                  new Response(null, {
                    status: 302,
                    headers: { location: "/home" },
                  }),
              },
              () => [loading(<i>spinner</i>)],
            ),
            path("/slot-response", () => <p>slot response</p>, {
              name: "slotResponse",
            }),
          ],
        ),
      ],
    ),
  ]),
);

/** The per-segment handler rows of a response's Server-Timing, by name. */
function handlerRows(response: Response): string[] {
  return (response.headers.get("Server-Timing") ?? "")
    .split(", ")
    .map((entry) => entry.split(";")[0]!)
    .filter((name) => name.startsWith("d2-handler-"))
    .sort();
}

interface Observed {
  rows: string[];
  spans: string[];
  responseWarnings: string[];
}

async function serve(
  url: string,
  kind: "document" | "navigation",
): Promise<Observed> {
  handlerSpans = [];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { response } = await serveShellRequest(router, url, {
      cacheStore: new MemorySegmentCacheStore(),
      ...(kind === "navigation" && { partial: { from: "/home" } }),
    });
    // The streamed slot's warning lands once its promise settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      rows: handlerRows(response),
      spans: [...handlerSpans].sort(),
      responseWarnings: warn.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((text) => text.includes("returned a Response"))
        .map((text) => /Handler for "([^"]+)"/.exec(text)?.[1] ?? text),
    };
  } finally {
    warn.mockRestore();
  }
}

beforeEach(() => resetShellTestState());
afterEach(() => {
  handlerSpans = [];
  vi.unstubAllEnvs();
});

describe("a navigation reports a page's handlers as its document does", () => {
  it("a parallel slot's handler has its Server-Timing row and rango.handler span on a navigation", async () => {
    const navigation = await serve("/slots", "navigation");
    expect({
      row: navigation.rows.some((name) => name.endsWith("side")),
      span: navigation.spans.some((id) => id.endsWith(".@side")),
    }).toEqual({ row: true, span: true });
    const document = await serve("/slots", "document");
    expect(navigation.rows).toEqual(document.rows);
    expect(navigation.spans).toEqual(document.spans);
  });

  it("an orphan layout and its slot have the same rows and spans on a navigation as on the document", async () => {
    const document = await serve("/orphan", "document");
    const navigation = await serve("/orphan", "navigation");
    // The orphan layout's own row, `d2-handler-…orphanlayout<n>`.
    const orphanRow = expect.stringMatching(/orphanlayout\d+$/);
    expect(document.rows).toContainEqual(orphanRow);
    expect(navigation.rows).toContainEqual(orphanRow);
    expect(document.spans.some((id) => id.endsWith(".@aside"))).toBe(true);
    expect(navigation.rows).toEqual(document.rows);
    expect(navigation.spans).toEqual(document.spans);
  });

  it("a streamed slot handler that returns a Response is warned about on the document, as on a navigation", async () => {
    // The warning is dev-only; this project runs NODE_ENV=production.
    vi.stubEnv("NODE_ENV", "development");
    const document = await serve("/slot-response", "document");
    const navigation = await serve("/slot-response", "navigation");
    expect(document.responseWarnings).toHaveLength(1);
    expect(document.responseWarnings[0]).toMatch(/\.@response$/);
    expect(navigation.responseWarnings).toEqual(document.responseWarnings);
  });
});
