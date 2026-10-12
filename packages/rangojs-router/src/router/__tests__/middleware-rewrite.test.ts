/**
 * A thrown rewrite() in the middleware runners: control flow that unwinds
 * the chain (span settles as success), a returned one is an error, and
 * intercept middleware cannot rewrite. ctx.isRewrite and ctx.rewrittenFrom.
 */
import { describe, expect, it } from "vitest";
import {
  executeInterceptMiddleware,
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

  it("is an error once next() resolved: the route already rendered", async () => {
    const ctx = contextFor("http://localhost/shop");
    const late: MiddlewareFn<unknown> = async function late(_mwCtx, next) {
      await next();
      throw rewrite("/custom-404");
    };
    await expect(run(ctx, [late])).rejects.toThrow(
      'Middleware "late" threw rewrite() after calling next(): the route ' +
        "already rendered. throw rewrite() before await next().",
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

  it("passes a rewrite the downstream threw, and one thrown after next() rejected", async () => {
    const ctx = contextFor("http://localhost/shop");
    const outer: MiddlewareFn<unknown> = async (_mwCtx, next) => next();
    const inner: MiddlewareFn<unknown> = () => {
      throw rewrite("/maintenance");
    };
    await expect(run(ctx, [outer, inner])).rejects.toMatchObject({
      name: "Rewrite",
    });

    const errorPage: MiddlewareFn<unknown> = async (_mwCtx, next) => {
      try {
        return await next();
      } catch {
        throw rewrite("/error-page");
      }
    };
    await expect(
      run(ctx, [errorPage], async () => {
        throw new Error("render failed");
      }),
    ).rejects.toMatchObject({
      name: "Rewrite",
      target: { path: "/error-page" },
    });
  });
});

describe("executeInterceptMiddleware: rewrite is not supported", () => {
  it("turns a thrown rewrite into the intercept error", async () => {
    const ctx = contextFor("http://localhost/photos/1");
    const thrower: MiddlewareFn<unknown> = () => {
      throw rewrite("/maintenance");
    };
    await expect(
      runWithRequestContext(ctx, () =>
        executeInterceptMiddleware(
          [thrower],
          ctx.request,
          {},
          {},
          ctx._variables,
          ctx.res,
        ),
      ),
    ).rejects.toThrow(
      'rewrite("/maintenance") is not supported here: intercept middleware threw it.',
    );
  });

  it("rejects a returned rewrite", async () => {
    const ctx = contextFor("http://localhost/photos/1");
    const returns = (() =>
      rewrite("/maintenance")) as unknown as MiddlewareFn<unknown>;
    await expect(
      runWithRequestContext(ctx, () =>
        executeInterceptMiddleware(
          [returns],
          ctx.request,
          {},
          {},
          ctx._variables,
          ctx.res,
        ),
      ),
    ).rejects.toThrow("don't return it");
  });
});

describe("ctx.rewrittenFrom", () => {
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
