/**
 * `throw rewrite()` through the production request handler (serveShellRequest):
 * the request re-dispatches as the target with the same request context, at
 * the visitor's URL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  createActionForm,
  resetShellTestState,
  serveShellRequest,
} from "../flight.entry.js";
import { shellCacheKey } from "../index.js";
import {
  cookies,
  createLoader,
  createOTelTracing,
  createRouter,
  createVar,
  getRequestContext,
  rewrite,
  urls,
  type HandlerContext,
  type OnErrorContext,
  type OTelActiveSpanTracer,
  type OTelSpan,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
} from "../../cache/index.js";

const Lock = createVar<{ reason: string }>();

const LockLoader = createLoader(async (ctx) => ({
  reason: ctx.get(Lock)?.reason ?? "none",
  from: ctx.rewrittenFrom?.pathname ?? "none",
}));

function MaintenancePage(ctx: HandlerContext): React.ReactNode {
  return (
    <main>
      {`maintenance reason=${ctx.get(Lock)?.reason} at=${ctx.pathname} from=${ctx.rewrittenFrom?.pathname}${ctx.rewrittenFrom?.search ?? ""}`}
    </main>
  );
}

const RewritingLoader = createLoader(async () => {
  throw rewrite("/maintenance");
});

async function saveCart(): Promise<string> {
  return "saved";
}

async function rewritingAction(): Promise<string> {
  throw rewrite("/maintenance");
}

const errors: OnErrorContext[] = [];
const spans: Array<{ name: string; attributes: Record<string, unknown> }> = [];

const tracer: OTelActiveSpanTracer = {
  startActiveSpan<T>(name: string, fn: (span: OTelSpan) => T): T {
    const record = { name, attributes: {} as Record<string, unknown> };
    spans.push(record);
    const handle: OTelSpan = {
      setAttribute(key, value) {
        record.attributes[key] = value;
        return handle;
      },
      setStatus() {
        return handle;
      },
      recordException() {},
      end() {},
    };
    return fn(handle);
  },
};

const router = createRouter({
  onError: (context) => {
    errors.push(context);
  },
  tracing: createOTelTracing(tracer),
})
  .use(async (ctx, next) => {
    if (ctx.pathname === "/loop-a") throw rewrite("/loop-b");
    if (ctx.pathname === "/loop-b") throw rewrite("/loop-a");
    if (ctx.pathname === "/self") throw rewrite("/self");
    const lock = ctx.rewrittenFrom ? null : ctx.searchParams.get("lock");
    if (lock === "on") {
      // The maintenance recipe: a mutation gets a Response, a page a rewrite.
      if (ctx.request.method !== "GET") {
        return new Response("Maintenance", {
          status: 503,
          headers: { "Retry-After": "600" },
        });
      }
      ctx.set(Lock, { reason: "deploy" });
      cookies().set("pass-one", "kept");
      throw rewrite("maintenance");
    }
    if (lock === "naive") throw rewrite("maintenance");
    if (lock === "shell") throw rewrite("shell-target");
    if (ctx.pathname === "/gone") throw rewrite("/nowhere");
    return next();
  })
  .use("/guarded/*", async (ctx, next) => {
    if (ctx.request.headers.get("x-auth") !== "ok") {
      return new Response("Unauthorized", { status: 401 });
    }
    return next();
  })
  .routes(
    urls(({ path, middleware, loader }) => [
      path("/shop", () => <p>shop page</p>, { name: "shop" }),
      path("/maintenance", MaintenancePage, { name: "maintenance" }, () => [
        middleware(async (ctx, next) => {
          getRequestContext().setStatus(503);
          ctx.header("Retry-After", "600");
          await next();
        }),
        loader(LockLoader),
      ]),
      path("/guarded/page", () => <p>guarded page</p>, { name: "guarded" }),
      path(
        "/to-guarded",
        () => <p>never rendered</p>,
        {},
        () => [
          middleware(() => {
            throw rewrite("guarded");
          }),
        ],
      ),
      path("/handler-rewrite", () => {
        throw rewrite("/shop");
      }),
      path(
        "/loader-rewrite",
        () => <p>loader page</p>,
        {},
        () => [loader(RewritingLoader)],
      ),
      path("/shell-target", () => <p>shell target</p>, {
        name: "shell-target",
        ppr: true,
      }),
    ]),
  );

function payloadMetadata(flight: string | undefined): Record<string, unknown> {
  const row = flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  return (JSON.parse(row!.slice(2)) as { metadata: Record<string, unknown> })
    .metadata;
}

beforeEach(() => {
  resetShellTestState();
  errors.length = 0;
  spans.length = 0;
});

describe("throw rewrite() through the request handler", () => {
  it("renders the target at the visitor's URL with the same request context", async () => {
    const result = await serveShellRequest(router, "/shop?lock=on", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("retry-after")).toBe("600");
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/maintenance");
    expect(result.response.headers.getSetCookie().join()).toContain(
      "pass-one=kept",
    );
    expect(result.body).toContain(
      "maintenance reason=deploy at=/maintenance from=/shop?lock=on",
    );
    expect(result.body).not.toContain("shop page");
    expect(result.body).toContain('"reason":"deploy"');
    expect(result.body).toContain('"from":"/shop"');
    const metadata = payloadMetadata(result.flight);
    expect(metadata.pathname).toBe("/shop");
    expect(metadata.routeName).toBe("maintenance");
  });

  it("a navigation (partial request) renders the target's segments", async () => {
    const result = await serveShellRequest(router, "/shop?lock=on", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/guarded/page" },
    });
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/maintenance");
    expect(result.flight).toContain("maintenance reason=deploy");
    expect(result.flight).not.toContain("shop page");
    expect(payloadMetadata(result.flight).pathname).toBe("/shop");
  });

  it("a rewrite to a pattern-guarded route runs the guard", async () => {
    const denied = await serveShellRequest(router, "/to-guarded", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(denied.response.status).toBe(401);
    expect(denied.body).toBe("Unauthorized");

    const allowed = await serveShellRequest(router, "/to-guarded", {
      cacheStore: new MemorySegmentCacheStore(),
      headers: { "x-auth": "ok" },
    });
    expect(allowed.response.status).toBe(200);
    expect(allowed.body).toContain("guarded page");
    expect(allowed.body).not.toContain("never rendered");
  });

  it("a loop answers 508 and reports the trail through onError", async () => {
    const result = await serveShellRequest(router, "/loop-a", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(result.response.status).toBe(508);
    expect(result.response.headers.get("x-rango-rewrite")).toBeNull();
    const loop = errors.find((e) => e.error.name === "RewriteLoopError");
    expect(loop?.phase).toBe("routing");
    expect(loop?.error.message).toContain(
      "/loop-a -> /loop-b -> /loop-a -> /loop-b -> /loop-a -> /loop-b -> /loop-a",
    );
  });

  it("a rewrite to the URL the request is on answers 508 at once", async () => {
    const result = await serveShellRequest(router, "/self", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(result.response.status).toBe(508);
    expect(errors[0]?.error.message).toContain("/self -> /self");
  });

  it("a rewrite to a path no route matches renders the 404 page", async () => {
    const result = await serveShellRequest(router, "/gone", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(result.response.status).toBe(404);
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/nowhere");
    expect(payloadMetadata(result.flight).pathname).toBe("/gone");
  });

  it("a handler cannot rewrite: its throw renders the error boundary", async () => {
    const result = await serveShellRequest(router, "/handler-rewrite", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("x-rango-rewrite")).toBeNull();
    expect(errors[0]?.error.message).toContain("It works only in middleware");
  });
});

describe("where a rewrite is not supported", () => {
  it("a lock returns its Response for a JS action and a no-JS form post", async () => {
    const js = await serveShellRequest(router, "/shop?lock=on", {
      cacheStore: new MemorySegmentCacheStore(),
      action: { ref: saveCart, id: "cart.ts#saveCart" },
    });
    expect(js.response.status).toBe(503);
    expect(js.body).toBe("Maintenance");

    const form = await serveShellRequest(router, "/shop?lock=on", {
      cacheStore: new MemorySegmentCacheStore(),
      form: createActionForm(saveCart, { id: "cart.ts#saveCartForm" }),
    });
    expect(form.response.status).toBe(503);
    expect(form.body).toBe("Maintenance");
  });

  it("middleware that rewrites a JS action or a form post fails with the rule", async () => {
    await expect(
      serveShellRequest(router, "/shop?lock=naive", {
        cacheStore: new MemorySegmentCacheStore(),
        action: { ref: saveCart, id: "cart.ts#saveCartNaive" },
      }),
    ).rejects.toThrow(
      'rewrite("maintenance") is not supported here: middleware threw it while handling a non-GET request',
    );
    await expect(
      serveShellRequest(router, "/shop?lock=naive", {
        cacheStore: new MemorySegmentCacheStore(),
        form: createActionForm(saveCart, { id: "cart.ts#saveCartNaiveForm" }),
      }),
    ).rejects.toThrow("Return a Response for mutations instead");
    expect(errors.map((e) => e.phase)).toEqual(["routing", "routing"]);
  });

  it("a server action that throws rewrite() fails with the action error", async () => {
    await serveShellRequest(router, "/shop", {
      cacheStore: new MemorySegmentCacheStore(),
      action: { ref: rewritingAction, id: "cart.ts#rewritingAction" },
    });
    const action = errors.find((e) => e.phase === "action");
    expect(action?.error.message).toContain(
      "a server action threw it. Use redirect()",
    );
  });

  it("a loader that throws rewrite() renders its error, the page stays", async () => {
    const result = await serveShellRequest(router, "/loader-rewrite", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(result.response.headers.get("x-rango-rewrite")).toBeNull();
    expect(result.body).toContain("loader page");
    const loaderError = errors.find((e) => e.phase === "loader");
    expect(loaderError?.error.message).toContain("It works only in middleware");
  });
});

describe("a rewritten request and the caches", () => {
  it("serves the target's PPR shell under the target's key", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const miss = await serveShellRequest(router, "/shop?lock=shell", {
      cacheStore,
    });
    expect(miss.shellStatus).toBe("MISS");
    expect(miss.key).toBe(shellCacheKey(router, "/shell-target"));
    expect(payloadMetadata(miss.flight).pathname).toBe("/shop");

    const hit = await serveShellRequest(router, "/shop?lock=shell", {
      cacheStore,
    });
    expect(hit.shellStatus).toBe("HIT");
    expect(hit.key).toBe(miss.key);
    // The shell is the target's, as a direct visit captured it.
    expect(payloadMetadata(hit.flight).pathname).toBe("/shell-target");
    const direct = await serveShellRequest(router, "/shell-target", {
      cacheStore,
    });
    expect(direct.shellStatus).toBe("HIT");
  });

  it("records the target and hops on the rango.request span", async () => {
    await serveShellRequest(router, "/shop?lock=on", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    const request = spans.find((s) => s.name === "rango.request");
    expect(request?.attributes).toMatchObject({
      "url.path": "/shop",
      "rango.rewrite.target": "/maintenance",
      "rango.rewrite.hops": 1,
    });
  });

  it("the document cache keys the target and stores no visitor URL", async () => {
    const docErrors: OnErrorContext[] = [];
    const docRouter = createRouter({
      onError: (context) => {
        docErrors.push(context);
      },
    })
      .use(createDocumentCacheMiddleware())
      .routes(
        urls(({ path, middleware }) => [
          path(
            "/doc-shop",
            () => <p>doc shop</p>,
            {},
            () => [
              middleware(() => {
                throw rewrite("/doc-maintenance");
              }),
            ],
          ),
          path(
            "/doc-maintenance",
            (ctx: HandlerContext) => (
              <p>{`doc maintenance from=${ctx.rewrittenFrom?.pathname}`}</p>
            ),
            {},
            () => [
              middleware(async (ctx, next) => {
                ctx.header("Cache-Control", "s-maxage=60");
                await next();
              }),
            ],
          ),
          path(
            "/doc-late",
            () => <p>doc late</p>,
            {},
            () => [
              middleware(() => {
                throw rewrite("/doc-late-target");
              }),
            ],
          ),
          path(
            "/doc-late-target",
            () => <p>doc late target</p>,
            {},
            () => [
              middleware(async (ctx, next) => {
                await next();
                ctx.header("Cache-Control", "s-maxage=60");
              }),
            ],
          ),
        ]),
      );
    const cacheStore = new MemorySegmentCacheStore();
    const serve = (url: string) =>
      serveShellRequest(docRouter, url, { cacheStore });

    // Opted in before next(): stored under the target, showing the target.
    const miss = await serve("/doc-shop");
    expect(miss.response.headers.get("x-document-cache-status")).toBe("MISS");
    expect(payloadMetadata(miss.flight).pathname).toBe("/doc-maintenance");
    const direct = await serve("/doc-maintenance");
    expect(direct.response.headers.get("x-document-cache-status")).toBe("HIT");
    // The rewrite unwound through the cache middleware without a report.
    expect(docErrors).toEqual([]);

    // Opted in after next(): the render showed the visitor's URL, not stored.
    const late = await serve("/doc-late");
    expect(payloadMetadata(late.flight).pathname).toBe("/doc-late");
    const lateDirect = await serve("/doc-late-target");
    expect(lateDirect.response.headers.get("x-document-cache-status")).toBe(
      "MISS",
    );
  });
});

describe("one request, several passes", () => {
  it("a route-middleware rewrite reuses the SSR setup the first pass started", async () => {
    let streamModeCalls = 0;
    const ssrRouter = createRouter({
      ssr: {
        resolveStreaming: () => {
          streamModeCalls++;
          return "stream";
        },
      },
    }).routes(
      urls(({ path, middleware }) => [
        path(
          "/a",
          () => <p>a</p>,
          {},
          () => [
            middleware(() => {
              throw rewrite("/b");
            }),
          ],
        ),
        path("/b", () => <p>b page</p>),
      ]),
    );
    const result = await serveShellRequest(ssrRouter, "/a", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(result.body).toContain("b page");
    expect(streamModeCalls).toBe(1);
  });
});

describe("an intercept on the rewrite target", () => {
  it("applies as on a direct navigation, its selector seeing the target", async () => {
    const seen: string[] = [];
    const interceptRouter = createRouter({})
      .use("/promo/*", () => {
        throw rewrite("item", { id: "1" });
      })
      .routes(
        urls(({ path, layout, intercept }) => [
          layout(
            () => <main>shell</main>,
            () => [
              path("/list", () => <ul>list</ul>, { name: "list" }),
              path("/item/:id", () => <article>item page</article>, {
                name: "item",
              }),
              path("/promo/:slug", () => <p>never</p>),
              intercept("@modal", ".item", () => <dialog>item modal</dialog>, {
                when: (ctx) => {
                  seen.push(
                    `${ctx.from.url.pathname} -> ${ctx.to.url.pathname}`,
                  );
                  return true;
                },
              }),
            ],
          ),
        ]),
      );
    const result = await serveShellRequest(interceptRouter, "/promo/summer", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/list" },
    });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-rango-rewrite")).toBe("/item/1");
    expect(result.flight).toContain("item modal");
    expect(seen).toEqual(["/list -> /item/1"]);
    expect(payloadMetadata(result.flight).pathname).toBe("/promo/summer");
  });
});
