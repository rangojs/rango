import { describe, it, expect, vi } from "vitest";
import type { RscPayload } from "../types.js";

// D2 userland/primitive coverage: assert the full-render payload carries
// metadata.warmupEnabled through the PUBLIC router.fetch() path — not only the
// white-box handleRscRendering stub (rsc-rendering-warmup.test.ts). A consumer
// writes createRouter({ warmup: false }) and the initial document load must
// respect it; the client reads metadata.warmupEnabled off the SSR'd payload.
//
// The router's RSC handler imports @vitejs/plugin-rsc/rsc (a virtual module that
// the non-Vite unit runner cannot resolve), so mock its serializer with a spy
// that captures the payload renderToReadableStream is asked to serialize. The
// capture is the full-render RscPayload built by buildFullPayload — exactly the
// artifact whose metadata the client consumes.
const { renderSpy } = vi.hoisted(() => ({
  renderSpy: vi.fn(
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("FLIGHT"));
          controller.close();
        },
      }),
  ),
}));

vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  createFromReadableStream: vi.fn(),
  renderToReadableStream: renderSpy,
  loadServerAction: vi.fn(),
  decodeReply: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
  createTemporaryReferenceSet: vi.fn(() => ({})),
}));

import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";

function Home() {
  return null;
}

function buildRouter(warmup: boolean) {
  return createRouter<{}>({ warmup }).routes(
    urls(({ path }) => [path("/", Home, { name: "home" })]),
  ) as unknown as {
    fetch: (request: Request, input?: unknown) => Promise<Response>;
  };
}

async function fetchFullRenderPayload(warmup: boolean): Promise<RscPayload> {
  renderSpy.mockClear();
  const router = buildRouter(warmup);
  // RSC Accept -> full (initial) document render path -> buildFullPayload.
  const request = new Request("http://localhost/", {
    headers: { accept: "text/x-component" },
  });
  await router.fetch(request, {});
  // The first renderToReadableStream call serializes the full-render payload.
  expect(renderSpy).toHaveBeenCalled();
  const calls = renderSpy.mock.calls as unknown as unknown[][];
  return calls[0]![0] as RscPayload;
}

describe("router.fetch full-render payload carries warmupEnabled (D2, primitive)", () => {
  it("emits warmupEnabled: false for createRouter({ warmup: false })", async () => {
    const payload = await fetchFullRenderPayload(false);
    expect(payload.metadata).toBeDefined();
    expect("warmupEnabled" in payload.metadata!).toBe(true);
    expect(payload.metadata!.warmupEnabled).toBe(false);
  });

  it("emits warmupEnabled: true for createRouter({ warmup: true })", async () => {
    const payload = await fetchFullRenderPayload(true);
    expect(payload.metadata!.warmupEnabled).toBe(true);
  });
});
