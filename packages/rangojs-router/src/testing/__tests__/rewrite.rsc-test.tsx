/**
 * `throw rewrite()` through the production request handler (serveShellRequest):
 * the request re-dispatches as the target with the same request context, at
 * the visitor's URL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { Suspense } from "react";

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
  createHandle,
  type HandlerContext,
  type Middleware,
  type OnErrorContext,
  type OTelActiveSpanTracer,
  type OTelSpan,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
} from "../../cache/index.js";
import { cachedRewrittenFrom } from "./fixtures/rewrite-data.js";

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
let selfRuns = 0;
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
    if (ctx.pathname === "/self") {
      selfRuns++;
      throw rewrite("/self");
    }
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
      path(
        "/ssr-false-loader-rewrite",
        () => <p>ssr false loader page</p>,
        {},
        () => [loader(RewritingLoader, { ssr: false })],
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
  selfRuns = 0;
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
    expect(result.response.headers.get("content-type")).toBe(
      "text/x-component;charset=utf-8",
    );
    expect(payloadMetadata(result.flight).isPartial).toBe(true);
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
    // Refused before a second pass: the middleware ran once.
    expect(selfRuns).toBe(1);
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
    expect(errors[0]?.error.message).toContain("rewrite() is for middleware");
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
    expect(action?.error.name).toBe("Rewrite");
    expect(action?.error.message).toContain(
      "In a server action use redirect()",
    );
  });

  it.each([
    ["/loader-rewrite", "loader page"],
    ["/ssr-false-loader-rewrite", "ssr false loader page"],
  ])(
    "a loader that throws rewrite() renders its error, the page stays (%s)",
    async (url, page) => {
      const result = await serveShellRequest(router, url, {
        cacheStore: new MemorySegmentCacheStore(),
      });
      expect(result.response.headers.get("x-rango-rewrite")).toBeNull();
      expect(result.body).toContain(page);
      const loaderError = errors.find((e) => e.phase === "loader");
      expect(loaderError?.error.message).toContain(
        "Loaders and route handlers can't rewrite: throw rewrite() from the route's middleware instead.",
      );
    },
  );
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
  it("the stream mode is resolved for the target, from global or route middleware", async () => {
    const seen: string[] = [];
    const ssrRouter = createRouter({
      ssr: {
        resolveStreaming: ({ url }) => {
          seen.push(url.pathname);
          return "stream";
        },
      },
    })
      .use("/g", () => {
        throw rewrite("/b");
      })
      .routes(
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
          path("/g", () => <p>g</p>),
          path("/b", () => <p>b page</p>),
        ]),
      );
    const viaRoute = await serveShellRequest(ssrRouter, "/a", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(viaRoute.body).toContain("b page");
    expect(seen.at(-1)).toBe("/b");
    seen.length = 0;
    const viaGlobal = await serveShellRequest(ssrRouter, "/g", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(viaGlobal.body).toContain("b page");
    expect(seen).toEqual(["/b"]);
  });

  const chainRouter = createRouter({})
    .use(async (ctx, next) => {
      const step = /^\/(c5|c6)\/(\d)$/.exec(ctx.pathname);
      if (step) {
        const at = Number(step[2]);
        if (at < (step[1] === "c5" ? 5 : 6)) {
          throw rewrite(`/${step[1]}/${at + 1}` as `/${string}`);
        }
      }
      return next();
    })
    .routes(
      urls(({ path }) => [
        path("/c5/:k", (ctx: HandlerContext<{ k: string }>) => {
          const own = ctx.rewrittenFrom!;
          const other = getRequestContext().rewrittenFrom!;
          own.pathname = "/mutated";
          return (
            <p>
              {`chain end ${ctx.params.k} from=${other.pathname} copies-distinct=${own !== other}`}
            </p>
          );
        }),
        path("/c6/:k", () => <p>never</p>),
      ]),
    );

  it(`takes 5 rewrites, reports the first URL, and answers the 6th with 508`, async () => {
    const five = await serveShellRequest(chainRouter, "/c5/0", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(five.response.status).toBe(200);
    expect(five.response.headers.get("x-rango-rewrite")).toBe("/c5/5");
    expect(five.body).toContain("chain end 5 from=/c5/0 copies-distinct=true");

    const six = await serveShellRequest(chainRouter, "/c6/0", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(six.response.status).toBe(508);
  });
});

describe("a rewrite after next() (B2)", () => {
  async function LateWriter(): Promise<React.ReactNode> {
    await new Promise((resolve) => setTimeout(resolve, 30));
    cookies().set("late-from-pass-one", "1");
    return <i>late</i>;
  }

  const afterRouter = createRouter({})
    .use(async (ctx, next) => {
      if (ctx.pathname === "/after-pre") {
        cookies().set("pre-next", "1");
      }
      const response = await next();
      if (ctx.pathname === "/after" || ctx.pathname === "/after-pre") {
        throw rewrite("/target");
      }
      return response;
    })
    .routes(
      urls(({ path }) => [
        path("/after", () => (
          <div>
            after page
            <Suspense fallback={<b>wait</b>}>
              <LateWriter />
            </Suspense>
          </div>
        )),
        path("/after-pre", () => <p>after pre</p>),
        path("/target", () => <p>target page</p>),
      ]),
    );

  it("is an error after next() rendered the route, and nothing re-dispatches", async () => {
    for (const url of ["/after", "/after-pre"]) {
      await expect(
        serveShellRequest(afterRouter, url, {
          cacheStore: new MemorySegmentCacheStore(),
        }),
      ).rejects.toThrow(
        "threw rewrite() after calling next(). Throw rewrite() before await next().",
      );
    }
  });

  it("is an error after a next() that failed after the route rendered", async () => {
    const Crumb = createHandle<string>();
    const errorPage = async function errorPage(
      ctx: Parameters<Middleware>[0],
      next: Parameters<Middleware>[1],
    ): Promise<Response> {
      try {
        return await next();
      } catch (error) {
        if (ctx.isRewrite(error)) throw error;
        throw rewrite("/oops");
      }
    };
    const boomRouter = createRouter({})
      .use(errorPage)
      .routes(
        urls(({ path, layout, middleware }) => [
          layout(
            (ctx: HandlerContext) => {
              ctx.use(Crumb)("layout");
              return <main>layout</main>;
            },
            () => [
              path(
                "/boom",
                () => <p>boom page</p>,
                {},
                () => [
                  middleware(async (_ctx, next) => {
                    await next();
                    throw new Error("boom after render");
                  }),
                ],
              ),
              path("/oops", () => <p>oops page</p>),
            ],
          ),
        ]),
      );
    await expect(
      serveShellRequest(boomRouter, "/boom", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
    ).rejects.toThrow(
      'Middleware "errorPage" threw rewrite() after calling next(). Throw rewrite() before await next().',
    );
  });
});

describe("ctx.rewrittenFrom and shared caches (B1)", () => {
  const sharedErrors: OnErrorContext[] = [];
  const sharedRouter = createRouter({
    onError: (context) => {
      sharedErrors.push(context);
    },
  })
    .use((ctx, next) => {
      if (ctx.pathname === "/promo-a") throw rewrite("/item");
      if (ctx.pathname === "/c-a") throw rewrite("/cached");
      if (ctx.pathname === "/uc-a") throw rewrite("/uc");
      return next();
    })
    .routes(
      urls(({ path, cache }) => [
        path(
          "/item",
          (ctx: HandlerContext) => (
            <p>{`item from=${ctx.rewrittenFrom?.pathname ?? "direct"}`}</p>
          ),
          { name: "item", ppr: true },
        ),
        cache({ ttl: 300 }, () => [
          path("/cached", (ctx: HandlerContext) => (
            <p>{`cached from=${ctx.rewrittenFrom?.pathname ?? "direct"}`}</p>
          )),
        ]),
        path("/uc", async (ctx: HandlerContext) => (
          <p>{await cachedRewrittenFrom(ctx)}</p>
        )),
        path("/promo-a", () => <p>promo</p>),
        path("/c-a", () => <p>c a</p>),
        path("/uc-a", () => <p>uc a</p>),
      ]),
    );

  beforeEach(() => {
    sharedErrors.length = 0;
  });

  it("a PPR shell a rewritten request captured shows what a direct visit shows", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const rewritten = await serveShellRequest(sharedRouter, "/promo-a", {
      cacheStore,
    });
    expect(rewritten.shellStatus).toBe("MISS");
    // The visitor's own render sees where it came from.
    expect(rewritten.body).toContain("item from=/promo-a");

    const direct = await serveShellRequest(sharedRouter, "/item", {
      cacheStore,
    });
    expect(direct.shellStatus).toBe("HIT");
    expect(direct.prelude).toContain("item from=direct");
    expect(direct.body).not.toContain("from=/promo-a");
  });

  it("a cache() boundary refuses the read: nothing visitor-specific is stored", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const rewritten = await serveShellRequest(sharedRouter, "/c-a", {
      cacheStore,
    });
    expect(rewritten.response.status).toBe(500);
    expect(sharedErrors.map((e) => e.error.message).join()).toContain(
      "ctx.rewrittenFrom cannot be read inside a cache() boundary",
    );

    const direct = await serveShellRequest(sharedRouter, "/cached", {
      cacheStore,
    });
    expect(direct.body).not.toContain("from=/c-a");
  });

  it('a "use cache" function refuses the read', async () => {
    const result = await serveShellRequest(sharedRouter, "/uc-a", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(result.response.status).toBe(500);
    expect(result.body).not.toContain("uc from=/uc-a");
    expect(sharedErrors.map((e) => e.error.message).join()).toContain(
      'ctx.rewrittenFrom cannot be read inside a "use cache" function',
    );
  });
});

describe("a loader fetch under a rewriting middleware (S1)", () => {
  it("answers with the loader error load() rejects with, the rule in the message", async () => {
    const result = await serveShellRequest(
      router,
      "/shop?lock=naive&_rsc_loader=abc",
      {
        cacheStore: new MemorySegmentCacheStore(),
      },
    );
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("content-type")).toBe(
      "text/x-component;charset=utf-8",
    );
    expect(result.body).toContain("loaderError");
    expect(result.body).toContain(
      'rewrite(\\"maintenance\\") is not supported here: middleware threw it during a loader fetch',
    );
    expect(errors.map((e) => e.phase)).toEqual(["routing"]);
  });
});

describe("intercept middleware cannot rewrite", () => {
  it("fails the navigation with the intercept error", async () => {
    const interceptErrors: OnErrorContext[] = [];
    const interceptRouter = createRouter({
      onError: (context) => {
        interceptErrors.push(context);
      },
    }).routes(
      urls(({ path, layout, intercept, middleware }) => [
        layout(
          () => <main>shell</main>,
          () => [
            path("/list", () => <ul>list</ul>, { name: "list" }),
            path("/item/:id", () => <article>item</article>, { name: "item" }),
            intercept(
              "@modal",
              ".item",
              () => <dialog>modal</dialog>,
              () => [
                middleware(() => {
                  throw rewrite("/list");
                }),
              ],
            ),
          ],
        ),
      ]),
    );
    const result = await serveShellRequest(interceptRouter, "/item/1", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/list" },
    });
    expect(result.response.status).toBe(500);
    expect(interceptErrors.map((e) => e.error.message).join()).toContain(
      'rewrite("/list") is not supported here: intercept middleware threw it',
    );
  });
});

describe("cache middleware around a route-middleware rewrite (N5)", () => {
  it("a stale document-cache refresh of a route that now rewrites reports nothing", async () => {
    let locked = false;
    const staleErrors: OnErrorContext[] = [];
    const docRouter = createRouter({
      onError: (context) => {
        staleErrors.push(context);
      },
    })
      .use(createDocumentCacheMiddleware())
      .routes(
        urls(({ path, middleware }) => [
          path(
            "/page",
            () => <p>page</p>,
            {},
            () => [
              middleware(async (ctx, next) => {
                if (locked) throw rewrite("/lock");
                ctx.header(
                  "Cache-Control",
                  "s-maxage=0, stale-while-revalidate=300",
                );
                await next();
              }),
            ],
          ),
          path("/lock", () => <p>lock page</p>),
        ]),
      );
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(docRouter, "/page", { cacheStore });
    await new Promise((resolve) => setTimeout(resolve, 5));
    locked = true;
    const stale = await serveShellRequest(docRouter, "/page", { cacheStore });
    expect(stale.response.headers.get("x-document-cache-status")).toBe("STALE");
    expect(staleErrors).toEqual([]);
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
