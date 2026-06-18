import { describe, it, expect, vi } from "vitest";
import { handleRscRendering } from "../rsc-rendering.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscPayload } from "../types.js";

// D2: the initial full-render payload (the SSR'd initialPayload) must carry
// metadata.warmupEnabled so the client respects warmup:false from first load.
// Before the fix only the 404 and PE payloads included it; buildFullPayload
// omitted it, so a consumer's createRouter({ warmup: false }) was ignored on the
// initial document load (the client defaulted warmupEnabled to true), and since
// partial payloads omit it by design, warmup could never be turned off.
//
// White-box: stub the handler context, capture the payload passed to
// renderToReadableStream, and assert metadata.warmupEnabled. An RSC Accept makes
// handleRscRendering return the RSC stream right after serialization, so no SSR
// module is needed.

function makeStubCtx(warmupEnabled: boolean): {
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
      warmupEnabled,
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

async function runFullRender(warmupEnabled: boolean): Promise<RscPayload> {
  const { ctx, captured } = makeStubCtx(warmupEnabled);
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

describe("handleRscRendering — initial full payload carries warmupEnabled (D2)", () => {
  it("includes warmupEnabled: false when the router disables warmup", async () => {
    const payload = await runFullRender(false);
    expect(payload.metadata).toBeDefined();
    expect("warmupEnabled" in payload.metadata!).toBe(true);
    expect(payload.metadata!.warmupEnabled).toBe(false);
  });

  it("includes warmupEnabled: true when the router enables warmup", async () => {
    const payload = await runFullRender(true);
    expect(payload.metadata!.warmupEnabled).toBe(true);
  });
});
