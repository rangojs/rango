import { describe, it, expect, vi } from "vitest";

// A prefetch carries no Cache-Control, whatever its status (#1170): the HTTP
// cache would answer the click, or a later document's prefetch, with a
// prefetch that failed. Same serializer mock as
// rsc-rendering-default-prefetch-primitive.test.ts.
function pluginRscMock() {
  return {
    createFromReadableStream: vi.fn(),
    renderToReadableStream: vi.fn(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("FLIGHT"));
            controller.close();
          },
        }),
    ),
    loadServerAction: vi.fn(),
    decodeReply: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createTemporaryReferenceSet: vi.fn(() => ({})),
    encodeReply: vi.fn(),
    createClientTemporaryReferenceSet: vi.fn(() => ({})),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { notFound } from "../../errors.js";

const router = createRouter<{}>().routes(
  urls(({ path }) => [
    path("/", () => null, { name: "home" }),
    path("/ok", () => null, { name: "ok" }),
    path(
      "/boom",
      () => {
        throw new Error("boom");
      },
      { name: "boom" },
    ),
    path(
      "/missing",
      () => {
        notFound("gone");
      },
      { name: "missing" },
    ),
  ]),
) as unknown as {
  fetch: (request: Request, input?: unknown) => Promise<Response>;
};

function prefetch(path: string): Promise<Response> {
  return router.fetch(
    new Request(`http://localhost${path}?_rsc_partial=true&_rsc_segments=`, {
      headers: {
        accept: "text/x-component",
        "X-Rango-Prefetch": "1",
        "X-RSC-Router-Client-Path": "http://localhost/",
      },
    }),
    {},
  );
}

describe("prefetch Cache-Control by status", () => {
  it("omits it on a successful prefetch", async () => {
    const res = await prefetch("/ok");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("omits it when the handler throws", async () => {
    const res = await prefetch("/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("omits it on a not-found", async () => {
    const res = await prefetch("/missing");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("stale partial Cache-Control", () => {
  const partial = (search: string) =>
    router.fetch(
      new Request(
        `http://localhost/ok?_rsc_partial=true&_rsc_segments=${search}`,
        {
          headers: {
            accept: "text/x-component",
            "X-RSC-Router-Client-Path": "http://localhost/",
          },
        },
      ),
      {},
    );

  it("is never reusable by a shared cache", async () => {
    const res = await partial("&_rsc_stale=true");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("leaves a plain partial as it was", async () => {
    const res = await partial("");
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
