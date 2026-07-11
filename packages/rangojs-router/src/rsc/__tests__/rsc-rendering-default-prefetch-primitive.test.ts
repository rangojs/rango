import { afterEach, describe, it, expect, vi } from "vitest";
import type { RscPayload } from "../types.js";
import type { PrefetchStrategy } from "../../router/prefetch-default.js";

// Userland/primitive coverage: assert the full-render payload carries
// metadata.defaultPrefetch through the PUBLIC router.fetch() path. A consumer
// writes createRouter({ defaultPrefetch: "none" }) and the initial document
// load must ship it; the client applies it once at init (default-strategy.ts)
// and every bare <Link> falls back to it. Same capture technique as
// rsc-rendering-warmup-primitive.test.ts: mock the Vite-virtual serializer and
// read the payload renderToReadableStream is asked to serialize.
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

function buildRouter(defaultPrefetch?: PrefetchStrategy) {
  return createRouter<{}>({ defaultPrefetch }).routes(
    urls(({ path }) => [path("/", Home, { name: "home" })]),
  ) as unknown as {
    fetch: (request: Request, input?: unknown) => Promise<Response>;
  };
}

async function fetchFullRenderPayload(
  defaultPrefetch?: PrefetchStrategy,
): Promise<RscPayload> {
  renderSpy.mockClear();
  const router = buildRouter(defaultPrefetch);
  // RSC Accept -> full (initial) document render path -> buildFullPayload.
  const request = new Request("http://localhost/", {
    headers: { accept: "text/x-component" },
  });
  await router.fetch(request, {});
  expect(renderSpy).toHaveBeenCalled();
  const calls = renderSpy.mock.calls as unknown as unknown[][];
  return calls[0]![0] as RscPayload;
}

describe("router.fetch full-render payload carries defaultPrefetch (primitive)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits none when the option is omitted outside production", async () => {
    const payload = await fetchFullRenderPayload();
    expect(payload.metadata).toBeDefined();
    expect(payload.metadata!.defaultPrefetch).toBe("none");
  });

  it("emits viewport when the option is omitted in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const payload = await fetchFullRenderPayload();
    expect(payload.metadata!.defaultPrefetch).toBe("viewport");
  });

  it("emits an explicit strategy for createRouter({ defaultPrefetch: 'hover' })", async () => {
    const payload = await fetchFullRenderPayload("hover");
    expect(payload.metadata!.defaultPrefetch).toBe("hover");
  });

  it("emits manual mode for createRouter({ defaultPrefetch: 'none' })", async () => {
    const payload = await fetchFullRenderPayload("none");
    expect(payload.metadata!.defaultPrefetch).toBe("none");
  });
});
