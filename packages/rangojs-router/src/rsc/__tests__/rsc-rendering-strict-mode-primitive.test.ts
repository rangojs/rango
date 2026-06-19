import { describe, it, expect, vi } from "vitest";
import type { RscPayload } from "../types.js";

// Userland/primitive coverage: assert the full-render payload carries
// metadata.strictMode through the PUBLIC router.fetch() path, and that
// createRouter resolves the strictMode flag (default true). A consumer writes
// createRouter({ strictMode: false }) and the initial document load must ship
// the opt-out so the browser entry hydrates without React.StrictMode; the
// client reads metadata.strictMode off the SSR'd payload.
//
// The router's RSC handler imports @vitejs/plugin-rsc/rsc (a virtual module the
// non-Vite unit runner cannot resolve), so mock its serializer with a spy that
// captures the payload renderToReadableStream is asked to serialize. The capture
// is the full-render RscPayload built by buildFullPayload — exactly the artifact
// whose metadata the client consumes.
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

// The resolved strictMode flag lives on the internal router shape (like
// warmupEnabled), not the public Rango type, so cast to read it.
function buildRouter(strictMode?: boolean): {
  strictMode: boolean;
  fetch: (request: Request, input?: unknown) => Promise<Response>;
} {
  return createRouter<{}>(
    strictMode === undefined ? {} : { strictMode },
  ).routes(
    urls(({ path }) => [path("/", Home, { name: "home" })]),
  ) as unknown as {
    strictMode: boolean;
    fetch: (request: Request, input?: unknown) => Promise<Response>;
  };
}

async function fetchFullRenderPayload(
  strictMode: boolean,
): Promise<RscPayload> {
  renderSpy.mockClear();
  const router = buildRouter(strictMode);
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

describe("createRouter strictMode resolution", () => {
  it("defaults strictMode to true", () => {
    expect(buildRouter().strictMode).toBe(true);
  });

  it("resolves strictMode: false when opted out", () => {
    expect(buildRouter(false).strictMode).toBe(false);
  });

  it("resolves strictMode: true when explicitly enabled", () => {
    expect(buildRouter(true).strictMode).toBe(true);
  });
});

describe("router.fetch full-render payload carries strictMode (primitive)", () => {
  it("emits strictMode: false for createRouter({ strictMode: false })", async () => {
    const payload = await fetchFullRenderPayload(false);
    expect(payload.metadata).toBeDefined();
    expect("strictMode" in payload.metadata!).toBe(true);
    expect(payload.metadata!.strictMode).toBe(false);
  });

  it("emits strictMode: true for createRouter({ strictMode: true })", async () => {
    const payload = await fetchFullRenderPayload(true);
    expect(payload.metadata!.strictMode).toBe(true);
  });
});
