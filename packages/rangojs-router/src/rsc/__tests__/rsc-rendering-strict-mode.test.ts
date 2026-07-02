import { describe, it, expect, vi } from "vitest";
import { handleRscRendering } from "../rsc-rendering.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscPayload } from "../types.js";

// The initial full-render payload (the SSR'd initialPayload) must carry
// metadata.strictMode so the browser entry knows whether to wrap hydration in
// React.StrictMode. Partial (navigation) payloads omit it by design; StrictMode
// is decided once at hydration. Mirrors the warmupEnabled flow test.
//
// White-box: stub the handler context, capture the payload passed to
// renderToReadableStream, and assert metadata.strictMode. An RSC Accept makes
// handleRscRendering return the RSC stream right after serialization, so no SSR
// module is needed.

function makeStubCtx(strictMode: boolean): {
  ctx: HandlerContext<unknown>;
  captured: { payload?: RscPayload };
} {
  const captured: { payload?: RscPayload } = {};
  const ctx = {
    version: "v-test",
    router: {
      id: "test-router",
      basename: undefined,
      rootLayout: undefined,
      resolvedStateCookieName: "rango-state",
      themeConfig: undefined,
      prefetchCacheTTL: 0,
      prefetchCacheSize: 33,
      prefetchConcurrency: 4,
      warmupEnabled: true,
      strictMode,
      async match() {
        return {
          redirect: undefined,
          segments: [],
          matched: [],
          diff: [],
          resolvedIds: [],
          params: {},
          routeName: "home",
        };
      },
    },
    callOnError: vi.fn(),
    renderToReadableStream: (payload: RscPayload) => {
      captured.payload = payload;
      return new ReadableStream();
    },
  } as unknown as HandlerContext<unknown>;
  return { ctx, captured };
}

async function runFullRender(strictMode: boolean): Promise<RscPayload> {
  const { ctx, captured } = makeStubCtx(strictMode);
  // RSC Accept -> isRscRequest true -> returns the RSC stream after serialize.
  const request = new Request("http://localhost/", {
    headers: { accept: "text/x-component" },
  });
  const url = new URL(request.url);
  const reqCtx = createRequestContext({
    env: {},
    request,
    url,
    variables: {},
  });

  await runWithRequestContext(reqCtx, () =>
    handleRscRendering(
      ctx,
      request,
      {},
      url,
      false, // isPartial: false -> full (initial) render
      reqCtx._handleStore,
      undefined,
    ),
  );

  expect(captured.payload).toBeDefined();
  return captured.payload!;
}

describe("handleRscRendering — initial full payload carries strictMode", () => {
  it("includes strictMode: false when the router opts out", async () => {
    const payload = await runFullRender(false);
    expect(payload.metadata).toBeDefined();
    expect("strictMode" in payload.metadata!).toBe(true);
    expect(payload.metadata!.strictMode).toBe(false);
  });

  it("includes strictMode: true when the router keeps StrictMode (default)", async () => {
    const payload = await runFullRender(true);
    expect(payload.metadata!.strictMode).toBe(true);
  });

  it("carries the client prefetch limits (cache size + concurrency)", async () => {
    const payload = await runFullRender(true);
    expect(payload.metadata!.prefetchCacheSize).toBe(33);
    expect(payload.metadata!.prefetchConcurrency).toBe(4);
  });
});
