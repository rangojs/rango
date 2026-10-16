/**
 * dc-t93: a document whose server render failed its shell is answered with a
 * recovery document (500/404) or a real redirect, and none of them is stored by
 * the document cache: not on a MISS, not on a stale refresh. The render runs
 * the real pipeline (renderRscResponse, createSsrHtmlStage) over the real
 * createSSRHandler with real Fizz, in production mode; the Flight encoder and
 * the segment tree are stand-ins. The same wiring pins the router onError
 * contract for a shell error: reported once, phase "rendering".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToReadableStream as fizz } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-html-stream/server";

vi.mock("../../segment-system.js", () => ({
  renderSegments: vi.fn(),
}));

import { renderSegments } from "../../segment-system.js";
import { createDocumentCacheMiddleware } from "../document-cache.js";
import type { MiddlewareContext } from "../../router/middleware.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { renderRscResponse } from "../../rsc/render-pipeline.js";
import { createSsrHtmlStage } from "../../rsc/ssr-setup.js";
import { wasServerErrorPrinted } from "../../server/print-server-error.js";
import type { RscPayload, SSRModule } from "../../rsc/types.js";
import { createSSRHandler } from "../../ssr/index.js";
import { LOADER_REDIRECT } from "../../decode-loader-results.js";

const PAGE = "http://localhost/product";
const KEY = "localhost/product:html";
const CACHE_CONTROL = "s-maxage=60, stale-while-revalidate=300";

let shellError: unknown;
let renders = 0;
let flightReports: unknown[] = [];
const callOnError = vi.fn();

vi.mocked(renderSegments).mockImplementation(async () => {
  function Page(): React.ReactNode {
    if (shellError !== undefined) throw shellError;
    return <p>product</p>;
  }
  return (
    <html>
      <body>
        <Page />
      </body>
    </html>
  );
});

const renderHTML = createSSRHandler({
  createFromReadableStream: (async (stream: ReadableStream<Uint8Array>) => {
    await new Response(stream).text();
    return { metadata: { pathname: "/product", segments: [] } };
  }) as never,
  renderToReadableStream: fizz as never,
  injectRSCPayload,
  loadBootstrapScriptContent: async () => "",
});

function renderPage(request: Request): Promise<Response> {
  renders++;
  const url = new URL(request.url);
  const ctx = {
    renderToReadableStream: (
      _payload: unknown,
      options?: { onError?: (error: unknown) => void },
    ) => {
      for (const error of flightReports) options?.onError?.(error);
      return new Response('0:{"root":"$L1"}\n')
        .body as ReadableStream<Uint8Array>;
    },
    callOnError,
    loadSSRModule: async () => ({ renderHTML }) as unknown as SSRModule,
    resolveStreamMode: async () => "stream" as const,
  } as any;
  return renderRscResponse(
    {
      ctx,
      request,
      url,
      env: {},
      payload: {} as RscPayload,
      init: {
        headers: {
          "Cache-Control": CACHE_CONTROL,
          "content-type": "text/html;charset=utf-8",
        },
      },
    },
    {
      html: createSsrHtmlStage({
        ctx,
        request,
        env: {},
        url,
        metricsStore: undefined,
        render: {},
      }),
    },
  );
}

function createStore() {
  const cache = new Map<string, { response: Response; staleAt: number }>();
  return {
    cache,
    async getResponse(key: string) {
      const entry = cache.get(key);
      if (!entry) return null;
      return {
        response: entry.response.clone(),
        shouldRevalidate: Date.now() > entry.staleAt,
      };
    },
    async putResponse(key: string, response: Response, ttl: number) {
      cache.set(key, {
        response: response.clone(),
        staleAt: Date.now() + ttl * 1000,
      });
    },
  };
}

let store: ReturnType<typeof createStore>;
/** The request context of the last serve() call. */
let lastReqCtx: RequestContext | undefined;

async function serve(): Promise<{
  response: Response;
  cacheStatus: string | null;
  body: string;
}> {
  const request = new Request(PAGE, { headers: { accept: "text/html" } });
  const mwCtx = {
    request,
    url: new URL(PAGE),
    env: {},
    var: {},
    get: vi.fn(),
    set: vi.fn(),
  } as unknown as MiddlewareContext<any>;
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(PAGE),
    variables: {},
  } as any) as RequestContext;
  reqCtx._cacheStore = store as any;
  reqCtx._reportBackgroundError = vi.fn();
  lastReqCtx = reqCtx;
  const response = (await runWithRequestContext(reqCtx, () =>
    createDocumentCacheMiddleware()(mwCtx, () => renderPage(request)),
  )) as Response;
  const body = await response.text();
  const tasks = reqCtx._pendingBackgroundTasks!;
  for (let i = 0; i < tasks.length; i++) await tasks[i];
  return {
    response,
    cacheStatus: response.headers.get("x-document-cache-status"),
    body,
  };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "error").mockImplementation(() => {});
  store = createStore();
  shellError = undefined;
  renders = 0;
  flightReports = [];
  callOnError.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("document cache: a shell error's answer is never stored", () => {
  it("a recovery document answers 500, reports onError once (rendering), and is not stored", async () => {
    shellError = new Error("loader read outside Suspense");

    const first = await serve();

    expect(first.response.status).toBe(500);
    expect(first.body).toContain('<html data-rango-ssr-error="">');
    expect(store.cache.has(KEY)).toBe(false);
    expect(callOnError).toHaveBeenCalledTimes(1);
    expect(callOnError).toHaveBeenCalledWith(
      shellError,
      "rendering",
      expect.objectContaining({ handledByBoundary: false }),
    );

    // The next request renders again; once fixed, the page is stored.
    shellError = undefined;
    const fixed = await serve();
    expect(fixed.response.status).toBe(200);
    expect(renders).toBe(2);
    expect(store.cache.has(KEY)).toBe(true);
  });

  it("a notFound() shell answers 404 and is not stored", async () => {
    const notFound = new Error("missing");
    notFound.name = "DataNotFoundError";
    shellError = notFound;

    const result = await serve();

    expect(result.response.status).toBe(404);
    expect(result.body).toContain("<h1>Not Found</h1>");
    expect(store.cache.has(KEY)).toBe(false);
    // Control flow, not an error.
    expect(callOnError).not.toHaveBeenCalled();
  });

  it("a stateless loader redirect() answers a real redirect and is not stored", async () => {
    const redirect = new Error("Loader redirected");
    redirect.name = "LoaderRedirect";
    Object.assign(redirect, {
      [LOADER_REDIRECT]: { to: "/elsewhere", status: 302 },
    });
    shellError = redirect;

    const result = await serve();

    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("location")).toBe("/elsewhere");
    expect(result.body).toBe("");
    expect(store.cache.has(KEY)).toBe(false);
    expect(callOnError).not.toHaveBeenCalled();
  });

  it("a loader redirect() with state answers 200 and is not stored", async () => {
    const redirect = new Error("Loader redirected");
    redirect.name = "LoaderRedirect";
    Object.assign(redirect, {
      [LOADER_REDIRECT]: { to: "/elsewhere", status: 302, state: { a: 1 } },
    });
    shellError = redirect;

    const result = await serve();

    expect(result.response.status).toBe(200);
    expect(result.body).toContain('<html data-rango-ssr-error="">');
    // A 200 passes shouldCacheResponse; the render's error list refuses it.
    expect(store.cache.has(KEY)).toBe(false);
    expect(callOnError).not.toHaveBeenCalled();
  });

  it("an error React decoded from Flight is reported once: the Flight render reported it", async () => {
    // What the Flight client builds for an error row: it sets `digest`.
    shellError = Object.assign(new Error("flight error row"), {
      digest: undefined,
    });
    flightReports = [new Error("flight error row")];

    await serve();

    expect(callOnError).toHaveBeenCalledTimes(1);
    expect(callOnError).toHaveBeenCalledWith(
      flightReports[0],
      "rendering",
      expect.anything(),
    );
  });

  it("a stale refresh whose render fails the shell keeps the stale entry", async () => {
    store.cache.set(KEY, {
      response: new Response("stale good", {
        headers: { "Cache-Control": CACHE_CONTROL },
      }),
      staleAt: Date.now() - 1000,
    });
    shellError = new Error("loader read outside Suspense");

    const stale = await serve();

    expect(stale.cacheStatus).toBe("STALE");
    expect(stale.body).toBe("stale good");
    expect(renders).toBe(1);
    expect(await store.cache.get(KEY)!.response.clone().text()).toBe(
      "stale good",
    );
  });
});

describe("dev: a shell error reaches the host", () => {
  it("rejects with the original error instance, reported once (rendering), marked for the handler", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const error = new Error("loader read outside Suspense");
    shellError = error;

    const rejection = await serve().catch((e: unknown) => e);

    expect(rejection).toBe(error);
    expect(store.cache.has(KEY)).toBe(false);
    expect(callOnError).toHaveBeenCalledTimes(1);
    expect(callOnError).toHaveBeenCalledWith(
      error,
      "rendering",
      expect.objectContaining({ handledByBoundary: false }),
    );
    // The handler's render catch neither reports nor prints it again.
    expect(wasServerErrorPrinted(error, lastReqCtx)).toBe(true);
    // Printed once by the router (Fizz); the handler's `[RSC] Error:` print
    // skips a marked error.
    expect(
      vi.mocked(console.error).mock.calls.filter((c) => c[0] === error),
    ).toHaveLength(1);
  });
});
