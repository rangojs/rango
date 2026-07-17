/**
 * Userland dogfood for timeouts.streamIdleMs through the public dispatch()
 * primitive: dispatch carries the same watchdog wiring as the production
 * response tail (rsc/handler.ts), so a consumer can pin the stream-idle
 * contract with the primitives we hand them.
 */
import { describe, it, expect, vi } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc, whose
// top-level body imports Vite virtual modules that do not resolve in plain
// node/vitest. dispatch() itself never renders RSC, so a stub is sufficient.
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  createFromReadableStream: vi.fn(),
  renderToReadableStream: vi.fn(),
  loadServerAction: vi.fn(),
  decodeReply: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
  createTemporaryReferenceSet: vi.fn(),
}));

import { dispatch } from "../dispatch.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { RouterTimeoutError } from "../../router/timeout.js";

/** A body that emits one chunk and then wedges (never closes). */
function hangingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
    },
  });
}

function buildRouter(opts: { streamIdleMs?: number; onError?: any } = {}) {
  return createRouter<{}>({
    ...(opts.streamIdleMs !== undefined && {
      timeouts: { streamIdleMs: opts.streamIdleMs },
    }),
    ...(opts.onError && { onError: opts.onError }),
  }).routes(
    urls(({ path }) => [
      path.json("/api/hang", () => new Response(hangingBody()), {
        name: "api.hang",
      }),
      path.text("/api/ping", () => "pong", { name: "api.ping" }),
    ]),
  ) as any;
}

describe("dispatch stream-idle (userland)", () => {
  it("terminates a wedged streamed body after streamIdleMs and reports onError", async () => {
    const onError = vi.fn();
    const router = buildRouter({ streamIdleMs: 30, onError });

    const res = await dispatch(router, { request: "/api/hang" });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");

    let error: unknown;
    try {
      await reader.read();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RouterTimeoutError);
    expect((error as RouterTimeoutError).phase).toBe("stream-idle");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].error).toBe(error);
    expect(onError.mock.calls[0][0].metadata).toMatchObject({
      timeout: true,
      phase: "stream-idle",
    });
  });

  it("leaves streams untouched when streamIdleMs is not configured", async () => {
    const router = buildRouter();
    const res = await dispatch(router, { request: "/api/ping" });
    expect(await res.text()).toBe("pong");
  });

  it("does not trip a healthy stream that completes inside the budget", async () => {
    const router = buildRouter({ streamIdleMs: 200 });
    const res = await dispatch(router, { request: "/api/ping" });
    expect(await res.text()).toBe("pong");
  });
});
