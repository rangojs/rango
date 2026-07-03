import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture no longer flows through the HTTP pipeline (that double-called next()
// and threw on the executor's single-use latch). The render layer now SCHEDULES a
// background capture via scheduleShellCapture when the middleware set the
// _shellCapture descriptor and the render is eligible. Mock that seam so these
// tests assert the scheduling decision without running the capture itself.
vi.mock("../shell-capture.js", () => ({
  scheduleShellCapture: vi.fn(),
}));

import { handleRscRendering } from "../rsc-rendering.js";
import { scheduleShellCapture } from "../shell-capture.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { HandlerContext } from "../handler-context.js";
import type { RscPayload, SSRModule } from "../types.js";

const scheduleMock = vi.mocked(scheduleShellCapture);

function makeCtx(ssrModule: SSRModule, streamMode: string) {
  const ctx = {
    version: "v-test",
    router: {
      id: "test-router",
      basename: undefined,
      rootLayout: undefined,
      resolvedStateCookieName: "rango-state",
      themeConfig: undefined,
      prefetchCacheTTL: 0,
      prefetchCacheSize: 0,
      prefetchConcurrency: 0,
      warmupEnabled: true,
      strictMode: false,
      onError: undefined,
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
      void payload;
      return new ReadableStream();
    },
    loadSSRModule: async () => ssrModule,
    resolveStreamMode: async () => streamMode,
  } as unknown as HandlerContext<unknown>;
  return { ctx };
}

interface RunOpts {
  ssrModule: SSRModule;
  streamMode?: string;
  nonce?: string;
  arm?: (reqCtx: RequestContext<unknown>) => void;
}

async function run(
  opts: RunOpts,
): Promise<{ response: Response; reqCtx: RequestContext<unknown> }> {
  const { ctx } = makeCtx(opts.ssrModule, opts.streamMode ?? "stream");
  const request = new Request("http://localhost/", {
    headers: { accept: "text/html" },
  });
  const url = new URL(request.url);
  const reqCtx = createRequestContext({
    env: {},
    request,
    url,
    variables: {},
  }) as RequestContext<unknown>;
  opts.arm?.(reqCtx);

  const response = await runWithRequestContext(reqCtx, () =>
    handleRscRendering(
      ctx,
      request,
      {},
      url,
      false,
      reqCtx._handleStore,
      opts.nonce,
    ),
  );
  return { response, reqCtx };
}

function resumeModule() {
  return {
    renderHTML: vi.fn(async () => new ReadableStream()),
    resumeShellHTML: vi.fn(async () => new ReadableStream()),
  } as unknown as SSRModule;
}

function captureCapableModule() {
  return {
    renderHTML: vi.fn(async () => new ReadableStream()),
    captureShellHTML: vi.fn(async () => ({
      prelude: new Uint8Array(),
      postponed: null,
    })),
  } as unknown as SSRModule;
}

beforeEach(() => {
  scheduleMock.mockClear();
});

describe("handleRscRendering — PPR shell RESUME dispatch", () => {
  it("resumes and marks the response with x-rango-shell-resumed on a HTML document HIT", async () => {
    const ssrModule = resumeModule();
    const { response } = await run({
      ssrModule,
      arm: (reqCtx) => {
        reqCtx._shellResume = { postponed: '{"x":1}' };
      },
    });

    expect(ssrModule.resumeShellHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.renderHTML).not.toHaveBeenCalled();
    expect(response.headers.get("x-rango-shell-resumed")).toBe("1");
    expect(response.headers.get("content-type")).toBe(
      "text/html;charset=utf-8",
    );
    const [, opts] = (ssrModule.resumeShellHTML as any).mock.calls[0];
    expect(opts.postponed).toBe('{"x":1}');
  });

  it("falls open to axis 1 (no marker) when a per-request nonce is present", async () => {
    const ssrModule = resumeModule();
    const { response } = await run({
      ssrModule,
      nonce: "abc123",
      arm: (reqCtx) => {
        reqCtx._shellResume = { postponed: null };
      },
    });

    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(response.headers.get("x-rango-shell-resumed")).toBeNull();
  });

  it("falls open to axis 1 (no marker) under allReady buffering", async () => {
    const ssrModule = resumeModule();
    const { response } = await run({
      ssrModule,
      streamMode: "allReady",
      arm: (reqCtx) => {
        reqCtx._shellResume = { postponed: "{}" };
      },
    });

    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(response.headers.get("x-rango-shell-resumed")).toBeNull();
  });

  it("falls open to axis 1 (no marker) when the SSR module lacks resumeShellHTML", async () => {
    const ssrModule = {
      renderHTML: vi.fn(async () => new ReadableStream()),
    } as unknown as SSRModule;
    const { response } = await run({
      ssrModule,
      arm: (reqCtx) => {
        reqCtx._shellResume = { postponed: "{}" };
      },
    });

    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(response.headers.get("x-rango-shell-resumed")).toBeNull();
  });
});

describe("handleRscRendering — PPR shell CAPTURE scheduling", () => {
  const descriptor = { key: "localhost/:shell", ttl: 300 };

  it("schedules a background capture on axis 1 when the descriptor is set and eligible", async () => {
    const ssrModule = captureCapableModule();
    const { response } = await run({
      ssrModule,
      arm: (reqCtx) => {
        (reqCtx as any)._shellCapture = { ...descriptor };
      },
    });

    // Served via renderHTML; capture scheduled as a background task, not a render.
    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    // (ctx, request, env, url, reqCtx, ssrModule, descriptor)
    const args = scheduleMock.mock.calls[0]!;
    expect((args[6] as any).key).toBe("localhost/:shell");
  });

  it("schedules a recapture on a resumed (stale) HIT", async () => {
    const ssrModule = {
      renderHTML: vi.fn(async () => new ReadableStream()),
      resumeShellHTML: vi.fn(async () => new ReadableStream()),
      captureShellHTML: vi.fn(async () => ({
        prelude: new Uint8Array(),
        postponed: null,
      })),
    } as unknown as SSRModule;
    await run({
      ssrModule,
      arm: (reqCtx) => {
        reqCtx._shellResume = { postponed: "{}" };
        (reqCtx as any)._shellCapture = { ...descriptor };
      },
    });

    expect(ssrModule.resumeShellHTML).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT schedule when no descriptor is set", async () => {
    await run({ ssrModule: captureCapableModule() });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("does NOT schedule when a per-request nonce is present", async () => {
    await run({
      ssrModule: captureCapableModule(),
      nonce: "n1",
      arm: (reqCtx) => {
        (reqCtx as any)._shellCapture = { ...descriptor };
      },
    });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("does NOT schedule under allReady buffering", async () => {
    await run({
      ssrModule: captureCapableModule(),
      streamMode: "allReady",
      arm: (reqCtx) => {
        (reqCtx as any)._shellCapture = { ...descriptor };
      },
    });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("does NOT schedule when the SSR module lacks captureShellHTML", async () => {
    const ssrModule = {
      renderHTML: vi.fn(async () => new ReadableStream()),
    } as unknown as SSRModule;
    await run({
      ssrModule,
      arm: (reqCtx) => {
        (reqCtx as any)._shellCapture = { ...descriptor };
      },
    });
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});

describe("handleRscRendering — no PPR flags is byte-identical axis 1", () => {
  it("renders via renderHTML with the normal content-type, no markers, no capture", async () => {
    const ssrModule = {
      renderHTML: vi.fn(async () => new ReadableStream()),
      captureShellHTML: vi.fn(),
      resumeShellHTML: vi.fn(),
    } as unknown as SSRModule;

    const { response } = await run({ ssrModule });

    expect(ssrModule.renderHTML).toHaveBeenCalledTimes(1);
    expect(ssrModule.captureShellHTML).not.toHaveBeenCalled();
    expect(ssrModule.resumeShellHTML).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe(
      "text/html;charset=utf-8",
    );
    expect(response.headers.get("x-rango-shell-resumed")).toBeNull();
    expect(response.status).toBe(200);
  });
});
