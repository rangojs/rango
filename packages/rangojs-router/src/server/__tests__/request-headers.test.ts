/**
 * #976: `ctx.request.headers` is an own getter on the request the router
 * hands out (request-headers.ts shadowRequestHeaders, guarded by
 * cookie-store.ts guardRequestHeaders). The object stays a real Request:
 * `fetch(request)`, `new Request(request)` and `request.clone()` read the
 * platform's internal slots, never the getter, so they work and trip no guard
 * inside the scopes that refuse a header read. The router's own reads
 * (requestHeaders) bypass the getter.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../request-context.js";
import { invalidateClientCache } from "../cookie-store.js";
import { requestHeaders, shadowRequestHeaders } from "../request-headers.js";
import { runWithCacheExecScope } from "../../cache/cache-exec-scope.js";
import { RangoContext, latchCachedHeaderScope } from "../context.js";
import { createHandlerContext } from "../../router/handler-context.js";
import { createMiddlewareContext } from "../../router/middleware.js";
import { invokeOnError } from "../../router/error-handling.js";

/** Echoes the method, x-probe header and body of every request it gets. */
let server: http.Server;
let origin: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () =>
      res.end(`${req.method} ${req.headers["x-probe"]} ${body}`),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function requestContext(init?: RequestInit): RequestContext {
  return createRequestContext({
    env: {},
    request: new Request(`${origin}/page`, {
      ...init,
      headers: { "x-probe": "probe", cookie: "session=abc" },
    }),
    url: new URL(`${origin}/page`),
    variables: {},
    stateCookieName: "rango-state_router_0",
  });
}

const inCacheScope = <T>(fn: () => T): T =>
  RangoContext.run({ insideCacheScope: true } as any, () => {
    latchCachedHeaderScope("cache", "r");
    return fn();
  });

/** The scopes a header read refuses: [label, capture render, enter]. */
const REFUSING: Array<[string, boolean, <T>(fn: () => T) => T]> = [
  ['a "use cache" body', false, (fn) => runWithCacheExecScope(fn)],
  ["a cache() boundary", false, inCacheScope],
  ["a ppr capture render", true, (fn) => fn()],
];

describe("ctx.request stays a real Request (#976)", () => {
  describe.each(REFUSING)("in %s", (_label, capture, enter) => {
    function run<T>(fn: (request: Request) => T, init?: RequestInit): T {
      const reqCtx = requestContext(init);
      if (capture) reqCtx._shellCaptureRun = true;
      const result = runWithRequestContext(reqCtx, () =>
        enter(() => fn(reqCtx.request)),
      );
      expect(reqCtx._shellCaptureGuardTripped).toBeUndefined();
      return result;
    }

    it("a header read throws", () => {
      const reqCtx = requestContext();
      if (capture) reqCtx._shellCaptureRun = true;
      runWithRequestContext(reqCtx, () =>
        enter(() => {
          expect(() => reqCtx.request.headers).toThrow(/ctx\.request\.headers/);
        }),
      );
    });

    it("fetch(ctx.request) sends its headers without reading them through the getter", async () => {
      const response = await run((request) => fetch(request));
      expect(await response.text()).toBe("GET probe ");
    });

    it("fetch(ctx.request) forwards a POST body", async () => {
      const response = await run((request) => fetch(request), {
        method: "POST",
        body: "payload",
      });
      expect(await response.text()).toBe("POST probe payload");
    });

    it("new Request(ctx.request) copies the headers", () => {
      const copy = run((request) => new Request(request));
      expect(copy.headers.get("x-probe")).toBe("probe");
      expect(Object.hasOwn(copy, "headers")).toBe(false);
    });

    it("ctx.request.clone() copies the headers and the body", async () => {
      const clone = run((request) => request.clone(), {
        method: "POST",
        body: "payload",
      });
      expect(clone.headers.get("x-probe")).toBe("probe");
      expect(await clone.text()).toBe("payload");
    });

    it("a clone's headers are guarded like ctx.request.headers", () => {
      const reqCtx = requestContext();
      if (capture) reqCtx._shellCaptureRun = true;
      runWithRequestContext(reqCtx, () =>
        enter(() => {
          const clone = reqCtx.request.clone();
          expect(() => clone.headers).toThrow(/ctx\.request\.headers/);
          expect(() => clone.clone().headers).toThrow(/ctx\.request\.headers/);
          expect(requestHeaders(clone).get("x-probe")).toBe("probe");
        }),
      );
    });

    it("the router's own read (requestHeaders) is unguarded", () => {
      expect(run((request) => requestHeaders(request).get("x-probe"))).toBe(
        "probe",
      );
    });

    it("onError reads a request header: an observer, not rendered", () => {
      const seen: Array<string | null> = [];
      run((request) =>
        invokeOnError(
          (context) => {
            seen.push(context.request!.headers.get("x-probe"));
          },
          new Error("boom"),
          "rendering",
          { request, url: new URL(request.url) },
        ),
      );
      expect(seen).toEqual(["probe"]);
    });

    it("console.log of ctx.request, or of a ctx holding it, reads no header through the guard", () => {
      // Node's util.inspect of a Request reads this.headers (undici).
      const logged = run((request) => [
        inspect(request),
        inspect(
          createMiddlewareContext(request, {}, {}, {}, {
            response: undefined,
          } as any),
        ),
      ]);
      for (const text of logged) expect(text).toContain("'x-probe': 'probe'");
    });

    it("the state cookie rotation reads the request without the guard", () => {
      // invalidateClientCache() is callable during a capture; a cache() or
      // "use cache" scope refuses it before it reads anything.
      if (!capture) return;
      run(() => invalidateClientCache());
    });
  });

  it("the getter is an own, non-enumerable property over the request's own Headers", () => {
    const reqCtx = requestContext();
    const { request } = reqCtx;
    const own = Object.getOwnPropertyDescriptor(request, "headers");
    expect(typeof own?.get).toBe("function");
    expect(own?.enumerable).toBe(false);
    expect(request).toBeInstanceOf(Request);
    expect(Object.keys(request)).toEqual([]);
    expect(JSON.stringify(request)).toBe("{}");
    runWithRequestContext(reqCtx, () => {
      expect(request.headers).toBe(requestHeaders(request));
      // A header middleware sets is visible to the router's read.
      request.headers.set("x-set", "1");
      expect(requestHeaders(request).get("x-set")).toBe("1");
    });
  });

  it('spreading a ctx in a "use cache" body reads no header', () => {
    const reqCtx = requestContext();
    runWithRequestContext(reqCtx, () => {
      const ctx = createHandlerContext(
        {},
        reqCtx.request,
        new URLSearchParams(),
        "/page",
        new URL(`${origin}/page`),
      );
      runWithCacheExecScope(() => {
        expect(() => ({ ...ctx, ...ctx.request })).not.toThrow();
        expect(() => JSON.stringify(ctx.request)).not.toThrow();
      });
    });
  });

  it("the guard is back on after an inspect", () => {
    const reqCtx = requestContext();
    runWithRequestContext(reqCtx, () =>
      inCacheScope(() => {
        inspect(reqCtx.request);
        expect(() => reqCtx.request.headers).toThrow(
          "ctx.request.headers cannot be read inside a cache() boundary",
        );
      }),
    );
  });

  it("a request the router builds and matches is guarded by the handler ctx", () => {
    // The progressive-enhancement re-render and a navigation-only ppr capture
    // match a request of their own (progressive-enhancement.ts renderPage,
    // shell-capture.ts createNavigationCaptureRequest).
    const reqCtx = requestContext();
    runWithRequestContext(reqCtx, () => {
      const rendered = new Request(`${origin}/page`, {
        headers: { "x-probe": "render" },
      });
      const handler = createHandlerContext(
        {},
        rendered,
        new URLSearchParams(),
        "/page",
        new URL(`${origin}/page`),
      );
      inCacheScope(() => {
        expect(() => handler.request.headers).toThrow(
          "ctx.request.headers cannot be read inside a cache() boundary",
        );
        // The same object, so getRequestContext().request is guarded too.
        expect(() => rendered.headers).toThrow(/cache\(\) boundary/);
      });
      expect(handler.request.headers.get("x-probe")).toBe("render");
    });
  });

  it("a lazy srvx NodeRequest (the Node dev and preview servers) clones and reads its body at capture without tripping", async () => {
    const { toNodeHandler } = await import("srvx/node");
    const seen: string[] = [];
    const node = http.createServer(
      toNodeHandler(async (facade: Request) => {
        const reqCtx = createRequestContext({
          env: {},
          request: facade,
          url: new URL(facade.url),
          variables: {},
        });
        reqCtx._shellCaptureRun = true;
        try {
          await runWithRequestContext(reqCtx, async () => {
            const clone = reqCtx.request.clone();
            seen.push(`clone:${requestHeaders(clone).get("x-probe")}`);
            seen.push(`clone-body:${await clone.text()}`);
            seen.push(`body:${await reqCtx.request.text()}`);
            seen.push(
              `router:${requestHeaders(reqCtx.request).get("x-probe")}`,
            );
            seen.push(`inspect:${inspect(reqCtx.request).includes("probe")}`);
            expect(() => reqCtx.request.headers).toThrow(
              "ctx.request.headers cannot be read while capturing",
            );
          });
        } catch (error) {
          return new Response(String(error), { status: 500 });
        }
        seen.push(`tripped:${reqCtx._shellCaptureGuardTripped?.surface}`);
        return new Response("done");
      }),
    );
    await new Promise<void>((resolve) => node.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = node.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/page`, {
        method: "POST",
        headers: { "x-probe": "probe" },
        body: "payload",
      });
      expect(await res.text()).toBe("done");
    } finally {
      await new Promise((resolve) => node.close(resolve));
    }
    // Only the deliberate read above tripped the capture.
    expect(seen).toEqual([
      "clone:probe",
      "clone-body:payload",
      "body:payload",
      "router:probe",
      "inspect:true",
      "tripped:ctx.request.headers",
    ]);
  });

  it("a srvx NodeRequest stays lazy: json() reads an upstream rawBody", async () => {
    const { toNodeHandler } = await import("srvx/node");
    const read: unknown[] = [];
    const handler = toNodeHandler(async (facade: Request) => {
      const reqCtx = createRequestContext({
        env: {},
        request: facade,
        url: new URL(facade.url),
        variables: {},
      });
      try {
        read.push(await reqCtx.request.json());
      } catch (error) {
        read.push(String(error));
      }
      return new Response("done");
    });
    // A host that buffered the body already (rawBody) and drained the stream.
    const node = http.createServer((req, res) => {
      (req as { rawBody?: Buffer }).rawBody = Buffer.from('{"from":"raw"}');
      req.resume();
      req.on("end", () => void handler(req, res));
    });
    await new Promise<void>((resolve) => node.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = node.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/page`, {
        method: "POST",
        body: '{"from":"stream"}',
      });
      expect(await res.text()).toBe("done");
    } finally {
      await new Promise((resolve) => node.close(resolve));
    }
    expect(read).toEqual([{ from: "raw" }]);
  });

  it("shadowRequestHeaders is idempotent and calls its hook only on a user read", () => {
    const request = new Request(`${origin}/page`, {
      headers: { "x-probe": "probe" },
    });
    let reads = 0;
    const hook = () => {
      reads += 1;
    };
    expect(shadowRequestHeaders(request, hook)).toBe(request);
    shadowRequestHeaders(request, () => {
      throw new Error("second hook");
    });
    requestHeaders(request).get("x-probe");
    expect(reads).toBe(0);
    expect(request.headers.get("x-probe")).toBe("probe");
    expect(reads).toBe(1);
    // An unshadowed request reads through its own getter.
    expect(requestHeaders(new Request(origin)).get("x-probe")).toBeNull();
  });
});
