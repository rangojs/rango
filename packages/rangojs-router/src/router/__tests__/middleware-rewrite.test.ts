/**
 * A thrown rewrite() in the middleware runners: control flow that unwinds
 * the chain (span settles as success), and a returned one is an error.
 * ctx.isRewrite and ctx.rewrittenFrom.
 */
import { describe, expect, it, vi } from "vitest";
import {
  executeMiddleware,
  type MiddlewareEntry,
  type MiddlewareFn,
} from "../middleware.js";
import { rewrite } from "../../route-definition/rewrite.js";
import { applyRewrite } from "../../rsc/rewrite-passes.js";
import { rewriteTrail } from "../../server/rewrite-trail.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { createHandlerContext } from "../handler-context.js";
import { resolveTracing } from "../tracing.js";
import {
  createOTelTracing,
  type OTelActiveSpanTracer,
  type OTelSpan,
} from "../telemetry-otel.js";

function entry(handler: MiddlewareFn<unknown>): {
  entry: MiddlewareEntry<unknown>;
  params: Record<string, string>;
} {
  return {
    entry: { pattern: null, regex: null, paramNames: [], handler },
    params: {},
  };
}

function contextFor(href: string): RequestContext<any> {
  const url = new URL(href);
  return createRequestContext({
    env: {},
    request: new Request(url),
    url,
    variables: {},
  });
}

function spanStatuses() {
  const spans: Array<{ name: string; status?: { code: number } }> = [];
  const tracer: OTelActiveSpanTracer = {
    startActiveSpan<T>(name: string, fn: (span: OTelSpan) => T): T {
      const record: { name: string; status?: { code: number } } = { name };
      spans.push(record);
      const handle: OTelSpan = {
        setAttribute() {
          return handle;
        },
        setStatus(status) {
          record.status = status;
          return handle;
        },
        recordException() {},
        end() {},
      };
      return fn(handle);
    },
  };
  return { spans, tracing: resolveTracing(createOTelTracing(tracer)) };
}

describe("executeMiddleware: throw rewrite()", () => {
  it("unwinds the chain: no downstream, no code after next() upstream", async () => {
    const ctx = contextFor("http://localhost/shop");
    const ran: string[] = [];
    const outer: MiddlewareFn<unknown> = async (mwCtx, next) => {
      ran.push("outer:pre");
      await next();
      ran.push("outer:post");
      mwCtx.header("x-outer-post", "1");
    };
    const thrower: MiddlewareFn<unknown> = async () => {
      ran.push("thrower");
      throw rewrite("/maintenance");
    };
    const after: MiddlewareFn<unknown> = async (_mwCtx, next) => {
      ran.push("after");
      return next();
    };
    let finalRan = false;

    const outcome = runWithRequestContext(ctx, () =>
      executeMiddleware(
        [entry(outer), entry(thrower), entry(after)],
        ctx.request,
        {},
        ctx._variables,
        async () => {
          finalRan = true;
          return new Response("page");
        },
      ),
    );
    await expect(outcome).rejects.toMatchObject({
      name: "Rewrite",
      target: { path: "/maintenance" },
    });
    expect(ran).toEqual(["outer:pre", "thrower"]);
    expect(finalRan).toBe(false);
    expect(ctx.res.headers.get("x-outer-post")).toBeNull();
  });

  it("settles every rango.middleware span it passes through as success", async () => {
    const { spans, tracing } = spanStatuses();
    const ctx = contextFor("http://localhost/shop");
    ctx._tracing = tracing;
    const passThrough: MiddlewareFn<unknown> = async (_mwCtx, next) => next();
    const thrower: MiddlewareFn<unknown> = () => {
      throw rewrite("/maintenance");
    };

    await expect(
      runWithRequestContext(ctx, () =>
        executeMiddleware(
          [entry(passThrough), entry(thrower)],
          ctx.request,
          {},
          ctx._variables,
          async () => new Response("page"),
        ),
      ),
    ).rejects.toMatchObject({ name: "Rewrite" });

    const middlewareSpans = spans.filter((s) => s.name === "rango.middleware");
    expect(middlewareSpans).toHaveLength(2);
    for (const span of middlewareSpans) expect(span.status).toBeUndefined();
  });

  it("rejects a returned rewrite: only a thrown one re-dispatches", async () => {
    const ctx = contextFor("http://localhost/shop");
    const returns = (async () =>
      rewrite("/maintenance")) as unknown as MiddlewareFn<unknown>;
    await expect(
      runWithRequestContext(ctx, () =>
        executeMiddleware(
          [entry(returns)],
          ctx.request,
          {},
          ctx._variables,
          async () => new Response("page"),
        ),
      ),
    ).rejects.toThrow(
      "Throw it instead: `throw rewrite(...)`, don't return it.",
    );
  });

  it("ctx.isRewrite lets a try/catch around next() rethrow it", async () => {
    const ctx = contextFor("http://localhost/shop");
    const seen: boolean[] = [];
    const errorPage: MiddlewareFn<unknown> = async (mwCtx, next) => {
      try {
        return await next();
      } catch (error) {
        seen.push(mwCtx.isRewrite(error));
        if (mwCtx.isRewrite(error)) throw error;
        return new Response("error page", { status: 500 });
      }
    };
    const thrower: MiddlewareFn<unknown> = () => {
      throw rewrite("/maintenance");
    };
    const failer: MiddlewareFn<unknown> = () => {
      throw new Error("boom");
    };

    await expect(
      runWithRequestContext(ctx, () =>
        executeMiddleware(
          [entry(errorPage), entry(thrower)],
          ctx.request,
          {},
          ctx._variables,
          async () => new Response("page"),
        ),
      ),
    ).rejects.toMatchObject({ name: "Rewrite" });

    const failed = await runWithRequestContext(ctx, () =>
      executeMiddleware(
        [entry(errorPage), entry(failer)],
        ctx.request,
        {},
        ctx._variables,
        async () => new Response("page"),
      ),
    );
    expect(failed.status).toBe(500);
    expect(seen).toEqual([true, false]);
  });
});

describe("executeMiddleware: a rewrite after next()", () => {
  const run = (
    ctx: RequestContext<any>,
    middleware: MiddlewareFn<unknown>[],
    final: () => Promise<Response> = async () => new Response("page"),
  ) =>
    runWithRequestContext(ctx, () =>
      executeMiddleware(
        middleware.map(entry),
        ctx.request,
        {},
        ctx._variables,
        final,
      ),
    );

  it("is an error once next() resolved", async () => {
    const ctx = contextFor("http://localhost/shop");
    const late: MiddlewareFn<unknown> = async function late(_mwCtx, next) {
      await next();
      throw rewrite("/custom-404");
    };
    await expect(run(ctx, [late])).rejects.toThrow(
      'Middleware "late" threw rewrite() after calling next(). Throw ' +
        "rewrite() before await next().",
    );
  });

  it("is an error while next() is still running", async () => {
    const ctx = contextFor("http://localhost/shop");
    let release!: () => void;
    const pending = new Promise<Response>((resolve) => {
      release = () => resolve(new Response("page"));
    });
    const racer: MiddlewareFn<unknown> = async (_mwCtx, next) => {
      void next();
      throw rewrite("/elsewhere");
    };
    await expect(run(ctx, [racer], () => pending)).rejects.toThrow(
      "threw rewrite() after calling next()",
    );
    release();
  });

  it("passes a rewrite the downstream threw, and one thrown after next() rejected with a rewrite", async () => {
    const ctx = contextFor("http://localhost/shop");
    const outer: MiddlewareFn<unknown> = async (_mwCtx, next) => next();
    const inner: MiddlewareFn<unknown> = () => {
      throw rewrite("/maintenance");
    };
    await expect(run(ctx, [outer, inner])).rejects.toMatchObject({
      name: "Rewrite",
    });

    // Nothing rendered: the downstream rewrote before its own next().
    const redirectRewrite: MiddlewareFn<unknown> = async (_mwCtx, next) => {
      try {
        return await next();
      } catch {
        throw rewrite("/elsewhere");
      }
    };
    await expect(run(ctx, [redirectRewrite, inner])).rejects.toMatchObject({
      name: "Rewrite",
      target: { path: "/elsewhere" },
    });
  });

  it("is an error after next() rejected with anything but a rewrite", async () => {
    const ctx = contextFor("http://localhost/shop");
    // The route may have rendered before it failed (a route middleware that
    // throws after its own next(), the render's own error).
    const errorPage: MiddlewareFn<unknown> = async function errorPage(
      mwCtx,
      next,
    ) {
      try {
        return await next();
      } catch (error) {
        if (mwCtx.isRewrite(error)) throw error;
        throw rewrite("/error-page");
      }
    };
    await expect(
      run(ctx, [errorPage], async () => {
        throw new Error("render failed");
      }),
    ).rejects.toThrow(
      'Middleware "errorPage" threw rewrite() after calling next().',
    );
  });
});

describe("ctx.rewrittenFrom", () => {
  it("a middleware reads the visitor's URL in a render the document cache stores; a handler does not", async () => {
    const ctx = contextFor("http://localhost/shop");
    await runWithRequestContext(ctx, async () => {
      applyRewrite(rewrite("/maintenance"), ctx.request, ctx, {}, undefined);
      // The document cache will store this render: it opted in before next().
      ctx._documentCacheRender = true;
      ctx.header("Cache-Control", "s-maxage=60");
    });
    let seenByMiddleware: string | undefined;
    const reader: MiddlewareFn<unknown> = async (mwCtx, next) => {
      seenByMiddleware = mwCtx.rewrittenFrom?.href;
      return next();
    };
    await runWithRequestContext(ctx, () =>
      executeMiddleware(
        [entry(reader)],
        ctx.request,
        {},
        ctx._variables,
        async () => new Response("page"),
      ),
    );
    expect(seenByMiddleware).toBe("http://localhost/shop");
    expect(ctx._payloadVisitorLocation).toBeUndefined();

    const handlerCtx = runWithRequestContext(ctx, () =>
      createHandlerContext(
        {},
        ctx.request,
        ctx.searchParams,
        ctx.pathname,
        ctx.url,
      ),
    );
    expect(handlerCtx.rewrittenFrom).toBeUndefined();
    expect(ctx._payloadVisitorLocation).toBeUndefined();
  });

  it("is undefined until a rewrite, then the visitor's URL, a copy per context", async () => {
    const ctx = contextFor("http://localhost/shop?q=1");
    const seen: Array<URL | undefined> = [];
    const record: MiddlewareFn<unknown> = async (mwCtx, next) => {
      seen.push(mwCtx.rewrittenFrom);
      return next();
    };
    const run = () =>
      runWithRequestContext(ctx, () =>
        executeMiddleware(
          [entry(record), entry(record)],
          ctx.request,
          {},
          ctx._variables,
          async () => new Response("page"),
        ),
      );

    await run();
    expect(seen).toEqual([undefined, undefined]);

    await runWithRequestContext(ctx, async () => {
      applyRewrite(rewrite("/maintenance"), ctx.request, ctx, {}, undefined);
    });
    seen.length = 0;
    await run();
    expect(seen.map((u) => u?.href)).toEqual([
      "http://localhost/shop?q=1",
      "http://localhost/shop?q=1",
    ]);
    expect(seen[0]).not.toBe(seen[1]);
    seen[0]!.pathname = "/mutated";
    expect(rewriteTrail(ctx)?.[0]).toBe("http://localhost/shop?q=1");
    expect(seen[0]).not.toBe(seen[1]);

    const handlerCtx = runWithRequestContext(ctx, () =>
      createHandlerContext(
        {},
        ctx.request,
        ctx.searchParams,
        ctx.pathname,
        ctx.url,
      ),
    );
    expect(handlerCtx.rewrittenFrom?.href).toBe("http://localhost/shop?q=1");
    expect(handlerCtx.rewrittenFrom).not.toBe(ctx.rewrittenFrom);
    expect(handlerCtx.pathname).toBe("/maintenance");
  });
});

describe("applyRewrite: a mutation", () => {
  function postContext(): { ctx: RequestContext<any>; request: Request } {
    const url = new URL("http://localhost/public-1?_rsc_action=a.ts%23save");
    const request = new Request(url, {
      method: "POST",
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        "rsc-action": "a.ts#save",
        "x-auth": "ok",
      },
      body: "[]",
    });
    const ctx = createRequestContext({ env: {}, request, url, variables: {} });
    return { ctx, request };
  }

  const FORM_OUTCOME = {
    kind: "form",
    outcome: {
      reactFormState: null,
      directActionId: null,
    },
  } as const;

  it("moves to the target before its action ran (a rewrite from global middleware), with its body", async () => {
    const { ctx, request } = postContext();
    const pass = await runWithRequestContext(ctx, async () =>
      applyRewrite(rewrite("/item/1"), request, ctx, {}, undefined),
    );
    expect(pass.target.href).toBe("http://localhost/item/1");
    // The target's pass classifies and runs the action.
    expect(pass.url.searchParams.get("_rsc_action")).toBe("a.ts#save");
    expect(pass.request.method).toBe("POST");
    expect(pass.request.headers.get("rsc-action")).toBe("a.ts#save");
    expect(pass.request.headers.get("content-type")).toBe(
      "text/plain;charset=UTF-8",
    );
    expect(pass.request.headers.get("x-auth")).toBe("ok");
    expect(await pass.request.text()).toBe("[]");
    expect(ctx.pathname).toBe("/item/1");
    expect(ctx.rewrittenFrom?.pathname).toBe("/public-1");
  });

  it("is refused before its action ran when middleware read its body: the action would get none", async () => {
    const { ctx, request } = postContext();
    await request.text();
    await runWithRequestContext(ctx, async () => {
      expect(() =>
        applyRewrite(rewrite("/item/1"), request, ctx, {}, undefined),
      ).toThrow(
        'rewrite("/item/1") is not supported here: middleware read the request body before it threw it',
      );
    });
    expect(ctx.pathname).toBe("/public-1");
    expect(rewriteTrail(ctx)).toBeUndefined();
  });

  it("with disallowMutations() is refused before its action ran", async () => {
    const { ctx, request } = postContext();
    await runWithRequestContext(ctx, async () => {
      expect(() =>
        applyRewrite(
          rewrite("/item/1").disallowMutations(),
          request,
          ctx,
          {},
          undefined,
        ),
      ).toThrow(
        'rewrite("/item/1") is not supported here: middleware threw it while handling a non-GET request',
      );
    });
    expect(ctx.pathname).toBe("/public-1");
    expect(request.bodyUsed).toBe(false);
  });

  it("with disallowMutations() moves once its action ran, and dev warns that it came too late", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ctx, request } = postContext();
      ctx._actionRan = FORM_OUTCOME;
      const pass = await runWithRequestContext(ctx, async () =>
        applyRewrite(
          rewrite("/item/1").disallowMutations(),
          request,
          ctx,
          {},
          undefined,
        ),
      );
      expect(pass.target.pathname).toBe("/item/1");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(
        'rewrite("/item/1").disallowMutations() came after the server action or form post ran, so it cannot refuse it',
      );

      // Without the opt-out, a rewrite after the action moves silently.
      const plain = postContext();
      plain.ctx._actionRan = FORM_OUTCOME;
      await runWithRequestContext(plain.ctx, async () =>
        applyRewrite(
          rewrite("/item/2"),
          plain.request,
          plain.ctx,
          {},
          undefined,
        ),
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("moves to the target once its action ran, as a bodyless request of the same method and headers", async () => {
    const { ctx, request } = postContext();
    // The action consumed the body before route middleware threw.
    await request.text();
    ctx._actionRan = FORM_OUTCOME;
    const pass = await runWithRequestContext(ctx, async () =>
      applyRewrite(rewrite("/item/1"), request, ctx, {}, undefined),
    );
    expect(pass.target.href).toBe("http://localhost/item/1");
    expect(pass.url.searchParams.get("_rsc_action")).toBe("a.ts#save");
    expect(pass.request.method).toBe("POST");
    expect(pass.request.body).toBeNull();
    expect(pass.request.headers.get("rsc-action")).toBe("a.ts#save");
    expect(pass.request.headers.get("x-auth")).toBe("ok");
    // A body check gated on the content-type passes over it.
    expect(pass.request.headers.get("content-type")).toBeNull();
    expect(ctx.pathname).toBe("/item/1");
    expect(ctx.rewrittenFrom?.pathname).toBe("/public-1");
  });

  it("keeps a body nothing consumed (a no-JS form post: the PE handler reads a clone)", async () => {
    const { ctx, request } = postContext();
    ctx._actionRan = FORM_OUTCOME;
    const pass = await runWithRequestContext(ctx, async () =>
      applyRewrite(rewrite("/item/1"), request, ctx, {}, undefined),
    );
    expect(pass.request.method).toBe("POST");
    expect(await pass.request.text()).toBe("[]");
  });
});
