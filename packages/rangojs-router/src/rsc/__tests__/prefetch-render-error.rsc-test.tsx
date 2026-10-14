/**
 * The row a failed prefetch ends with (#1170) is skipped by React's Flight
 * decoder, and the payload before it decodes unchanged. The development
 * decoder takes the same branch (an `H` row with an unknown code dispatches
 * nothing); the dev e2e of prefetch-render-errors covers it in a browser.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import * as server from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import * as client from "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge";
import { markPrefetchOnRenderError } from "../prefetch-render-error.js";
import { PREFETCH_FAILED_ROW } from "../../prefetch-markers.js";
import "../../testing/internal/flight-client-globals.js";

const manifest = new Proxy({}, { get: () => undefined });

async function render(errors: unknown[]): Promise<Response> {
  const stream = server.renderToReadableStream(
    { metadata: { ok: 1 }, tree: <p>healthy</p> },
    manifest,
  );
  return markPrefetchOnRenderError(new Response(stream), errors);
}

describe("markPrefetchOnRenderError", () => {
  it("ends a failed render with the row, which the decoder skips", async () => {
    const response = await render([new Error("handler down")]);
    const [text, decode] = response.body!.tee();
    const body = await new Response(text).text();
    expect(body.endsWith(PREFETCH_FAILED_ROW)).toBe(true);

    const payload = (await client.createFromReadableStream(decode, {
      serverConsumerManifest: { moduleMap: {}, moduleLoading: null },
    })) as { metadata: { ok: number }; tree: React.ReactElement };
    expect(payload.metadata).toEqual({ ok: 1 });
    expect(payload.tree.type).toBe("p");
  });

  it("leaves a healthy render's bytes unchanged", async () => {
    const body = await (await render([])).text();
    expect(body.endsWith(PREFETCH_FAILED_ROW)).toBe(false);
  });

  it("keeps the status and headers that left before the body", async () => {
    const response = markPrefetchOnRenderError(
      new Response("x", {
        status: 200,
        headers: { "cache-control": "private, max-age=300" },
      }),
      [new Error("down")],
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(await response.text()).toBe(`x${PREFETCH_FAILED_ROW}`);
  });
});
