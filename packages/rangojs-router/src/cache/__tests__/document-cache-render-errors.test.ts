/**
 * A document-cache MISS or stale refresh whose render reported an error through
 * Flight or Fizz onError is not stored (issue #915).
 *
 * The response is built by the real render pipeline (renderRscResponse's Flight
 * stage and createSsrHtmlStage) under a real request context; only the Flight
 * encoder and renderHTML are stand-ins, following their contracts: Flight
 * reports a component that throws through onError and completes normally with
 * an error row (pinned with real Flight in cache-route-flight-error.rsc-test.tsx),
 * and Fizz reports a component that throws inside a Suspense boundary through
 * onError and completes the document with the client-render fallback (pinned in
 * ssr/__tests__/shell-handlers.test.tsx). The status stays 200 throughout.
 *
 * Its own file: document-cache.test.ts binds document-cache.js to a doMock'd
 * request-context on its first dynamic import, which a static import of the
 * real middleware here would pre-empt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createDocumentCacheMiddleware } from "../document-cache.js";
import type { MiddlewareContext } from "../../router/middleware.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { renderRscResponse } from "../../rsc/render-pipeline.js";
import { createSsrHtmlStage } from "../../rsc/ssr-setup.js";
import type { RscPayload, SSRModule } from "../../rsc/types.js";

const PAGE = "http://localhost/product";
const CACHE_CONTROL = "s-maxage=60, stale-while-revalidate=300";
const encoder = new TextEncoder();

let failFlight = false;
let failFizz = false;
let renders = 0;

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function renderToReadableStream(
  _payload: unknown,
  options: { onError?: (error: unknown) => void },
): ReadableStream<Uint8Array> {
  renders++;
  if (failFlight) {
    options.onError?.(new Error("reviews upstream down"));
    return streamOf('0:{"root":"$L1"}\n1:E{"digest":""}\n');
  }
  return streamOf(
    '0:{"root":"$L1"}\n1:["$","p",null,{"children":"reviews"}]\n',
  );
}

const ssrModule = {
  renderHTML: async (
    rscStream: ReadableStream<Uint8Array>,
    options?: { onError?: (error: unknown) => void },
  ) => {
    const flight = await new Response(rscStream).text();
    let html = `<html><body><main>${flight}</main>`;
    if (failFizz) {
      options?.onError?.(new Error("client widget threw"));
      html += "<!--$!--><template></template><p>loading</p><!--/$-->";
    }
    return streamOf(`${html}</body></html>`);
  },
} as unknown as SSRModule;

function renderPage(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ctx = {
    renderToReadableStream,
    callOnError: () => {},
    loadSSRModule: async () => ssrModule,
    resolveStreamMode: async () => "stream" as const,
  } as any;
  const isRsc = request.headers.get("accept") === "text/x-component";
  return renderRscResponse(
    {
      ctx,
      request,
      url,
      env: {},
      payload: {} as RscPayload,
      init: { headers: { "Cache-Control": CACHE_CONTROL } },
    },
    isRsc
      ? {}
      : {
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

interface StoredEntry {
  response: Response;
  staleAt: number;
}

function createStore() {
  const cache = new Map<string, StoredEntry>();
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
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  store = createStore();
  failFlight = false;
  failFizz = false;
  renders = 0;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

async function serve(
  options: {
    accept?: string;
    /** Render under a context derived from the request's (a shell HIT tail). */
    derived?: boolean;
  } = {},
): Promise<{ status: string | null; body: string; reqCtx: RequestContext }> {
  const request = new Request(PAGE, {
    headers: { accept: options.accept ?? "text/html" },
  });
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
  const next = () =>
    options.derived
      ? runWithRequestContext(Object.create(reqCtx), () => renderPage(request))
      : renderPage(request);
  const response = (await runWithRequestContext(reqCtx, () =>
    createDocumentCacheMiddleware()(mwCtx, next),
  )) as Response;
  const body = await response.text();
  const tasks = reqCtx._pendingBackgroundTasks!;
  for (let i = 0; i < tasks.length; i++) await tasks[i];
  return {
    status: response.headers.get("x-document-cache-status"),
    body,
    reqCtx,
  };
}

describe("document cache: a 200 whose render reported an error is not stored (#915)", () => {
  it.each([
    ["HTML", "text/html", "localhost/product:html"],
    ["RSC", "text/x-component", "localhost/product:rsc"],
  ])(
    "%s: a component that threw in Flight is not stored; the next request renders and stores",
    async (_label, accept, key) => {
      failFlight = true;
      const errored = await serve({ accept });
      // The current request still gets the errored render, unchanged.
      expect(errored.status).toBe("MISS");
      expect(errored.body).toContain('1:E{"digest":""}');
      expect(store.cache.has(key)).toBe(false);
      expect(errored.reqCtx._reportBackgroundError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "reviews upstream down" }),
        "cache-write",
      );

      failFlight = false;
      const clean = await serve({ accept });
      expect(clean.status).toBe("MISS");
      expect(renders).toBe(2);
      expect(store.cache.has(key)).toBe(true);

      const hit = await serve({ accept });
      expect(hit.status).toBe("HIT");
      expect(hit.body).not.toContain(":E{");
      expect(renders).toBe(2);
    },
  );

  it("HTML: a client component that threw in Fizz (errored Suspense boundary) is not stored", async () => {
    failFizz = true;
    const errored = await serve();
    expect(errored.status).toBe("MISS");
    expect(errored.body).toContain("<!--$!-->");
    expect(store.cache.has("localhost/product:html")).toBe(false);
    expect(errored.reqCtx._reportBackgroundError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "client widget threw" }),
      "cache-write",
    );

    failFizz = false;
    await serve();
    const hit = await serve();
    expect(hit.status).toBe("HIT");
    expect(hit.body).not.toContain("<!--$!-->");
  });

  it("a render under a derived request context (shell HIT tail) still refuses the write", async () => {
    failFlight = true;
    const errored = await serve({ derived: true });
    expect(errored.status).toBe("MISS");
    expect(store.cache.has("localhost/product:html")).toBe(false);
  });

  it("stale refresh: an errored re-render keeps the stale entry serving", async () => {
    store.cache.set("localhost/product:html", {
      response: new Response("stale good", {
        headers: { "Cache-Control": CACHE_CONTROL },
      }),
      staleAt: Date.now() - 1000,
    });
    failFlight = true;
    const stale = await serve();
    expect(stale.status).toBe("STALE");
    expect(stale.body).toBe("stale good");
    // The background re-render ran and errored; the entry was not replaced.
    expect(renders).toBe(1);
    expect(
      await store.cache.get("localhost/product:html")!.response.clone().text(),
    ).toBe("stale good");
    expect(stale.reqCtx._reportBackgroundError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "reviews upstream down" }),
      "cache-write",
    );
  });
});
