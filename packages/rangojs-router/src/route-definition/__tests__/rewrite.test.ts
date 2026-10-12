/**
 * rewrite(): the Rewrite value, target resolution, the hop counter, and
 * applyRewrite, which moves the one request context to the target.
 */
import { describe, expect, it } from "vitest";
import * as rewriteModule from "../rewrite.js";
import {
  applyRewrite,
  isRewrite,
  MAX_REWRITE_HOPS,
  recordRewriteHop,
  rejectActionRewrite,
  resolveRewriteTarget,
  rewrite,
  rewriteNotSupported,
  RewriteLoopError,
} from "../rewrite.js";
import {
  createRequestContext,
  runWithRequestContext,
  setRequestContextParams,
  type RequestContext,
} from "../../server/request-context.js";
import { createMetricsStore } from "../../router/metrics.js";
import type { LocationStateEntry } from "../../browser/react/location-state-shared.js";
import { createVar } from "../../context-var.js";
import { createHandle } from "../../handle.js";

const ROUTES = {
  maintenance: "/maintenance",
  product: "/product/:slug",
};

function contextFor(
  href: string,
  init?: RequestInit,
): { ctx: RequestContext<any>; variables: Record<string, unknown> } {
  const url = new URL(href);
  const variables: Record<string, unknown> = {};
  const ctx = createRequestContext({
    env: {},
    request: new Request(url, init),
    url,
    variables,
  });
  return { ctx, variables };
}

describe("rewrite()", () => {
  it("returns an Error whose message states where a rewrite works", () => {
    const value = rewrite("/maintenance");
    expect(value).toBeInstanceOf(Error);
    expect(value.name).toBe("Rewrite");
    expect(value.message).toContain('rewrite("/maintenance")');
    expect(value.message).toContain("It works only in middleware");
    expect(value.message).toContain("Use redirect()");
    expect(value.target).toEqual({ path: "/maintenance" });
  });

  it("takes a route name with params and search", () => {
    expect(rewrite("product", { slug: "a" }, { tab: "x" }).target).toEqual({
      name: "product",
      params: { slug: "a" },
      search: { tab: "x" },
    });
  });

  it("rejects an empty target, a local name, and params with a path", () => {
    expect(() => rewrite("" as never)).toThrow(TypeError);
    expect(() => rewrite(".local" as never)).toThrow("global route names");
    expect(() =>
      (rewrite as (...args: unknown[]) => unknown)("/x", { a: "1" }),
    ).toThrow("params only with a route name");
  });

  it("isRewrite recognizes a rewrite and nothing else", () => {
    expect(isRewrite(rewrite("/a"))).toBe(true);
    expect(isRewrite(new Error("x"))).toBe(false);
    expect(isRewrite(new Response(null))).toBe(false);
    expect(isRewrite(null)).toBe(false);
    expect(isRewrite({ name: "Rewrite", target: { path: "/a" } })).toBe(false);
  });
});

describe("resolveRewriteTarget", () => {
  const base = new URL("https://shop.test/products?x=1");

  it("resolves a path with its search and drops a hash", () => {
    const url = resolveRewriteTarget(
      rewrite("/maintenance?from=a#top"),
      ROUTES,
      base,
    );
    expect(url.href).toBe("https://shop.test/maintenance?from=a");
  });

  it("prefixes a path with the basename once", () => {
    expect(
      resolveRewriteTarget(rewrite("/maintenance"), ROUTES, base, "/app")
        .pathname,
    ).toBe("/app/maintenance");
    expect(
      resolveRewriteTarget(rewrite("/app/maintenance"), ROUTES, base, "/app")
        .pathname,
    ).toBe("/app/maintenance");
    expect(
      resolveRewriteTarget(rewrite("/"), ROUTES, base, "/app").pathname,
    ).toBe("/app");
  });

  it("resolves a global route name with params and search", () => {
    expect(
      resolveRewriteTarget(rewrite("maintenance"), ROUTES, base).href,
    ).toBe("https://shop.test/maintenance");
    expect(
      resolveRewriteTarget(
        rewrite("product", { slug: "hat" }, { tab: "reviews" }),
        ROUTES,
        base,
      ).href,
    ).toBe("https://shop.test/product/hat?tab=reviews");
  });

  it("throws for an unknown name, a missing param, or another origin", () => {
    expect(() =>
      resolveRewriteTarget(rewrite("nope" as never), ROUTES, base),
    ).toThrow('Unknown route: "nope"');
    expect(() =>
      resolveRewriteTarget(rewrite("product" as never), ROUTES, base),
    ).toThrow('Missing param "slug"');
    expect(() =>
      resolveRewriteTarget(rewrite("//evil.test/x"), ROUTES, base),
    ).toThrow("not another origin");
  });
});

describe("the rewrite hop counter", () => {
  const at = (path: string) => new URL(`https://shop.test${path}`);

  it(`allows ${MAX_REWRITE_HOPS} hops and fails the next with the trail`, () => {
    const variables: Record<string, unknown> = {};
    for (let hop = 1; hop <= MAX_REWRITE_HOPS; hop++) {
      expect(
        recordRewriteHop(variables, at(`/h${hop - 1}`), at(`/h${hop}`)),
      ).toBe(hop);
    }
    let error: unknown;
    try {
      recordRewriteHop(variables, at("/h5"), at("/h6"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RewriteLoopError);
    expect((error as RewriteLoopError).trail).toEqual([
      "/h0",
      "/h1",
      "/h2",
      "/h3",
      "/h4",
      "/h5",
      "/h6",
    ]);
    expect((error as Error).message).toContain(
      "Infinite rewrite loop: /h0 -> /h1 -> /h2",
    );
  });

  it("fails a rewrite to the URL the request is on at once", () => {
    const variables: Record<string, unknown> = {};
    expect(() =>
      recordRewriteHop(variables, at("/a?x=1"), at("/a?x=1")),
    ).toThrow("Infinite rewrite loop: /a?x=1 -> /a?x=1");
    // Another search is another URL.
    expect(recordRewriteHop(variables, at("/a?x=1"), at("/a?x=2"))).toBe(1);
  });

  it("keeps the counter where user code cannot reach or reset it", () => {
    const exported = Object.keys(rewriteModule);
    expect(exported).not.toContain("REWRITE_TRAIL");
    const variables: Record<string, unknown> = {};
    recordRewriteHop(variables, at("/a"), at("/b"));
    // String keys and a user's own createVar() tokens are other slots.
    for (const key of Object.keys(variables)) delete variables[key];
    const userVar = createVar<unknown>();
    (variables as Record<symbol, unknown>)[userVar.key] = undefined;
    expect(recordRewriteHop(variables, at("/b"), at("/c"))).toBe(2);
  });
});

describe("rewriteNotSupported", () => {
  it.each([
    ["mutation", "Return a Response for mutations"],
    ["action", "a server action threw it. Use redirect()"],
    ["loader-fetch", "during a loader fetch"],
    ["intercept", "intercept middleware threw it"],
  ] as const)("names the %s site", (site, text) => {
    const original = rewrite("/m");
    const error = rewriteNotSupported(original, site);
    expect(error.message).toContain('rewrite("/m") is not supported here');
    expect(error.message).toContain(text);
    expect(error.cause).toBe(original);
    expect(isRewrite(error)).toBe(false);
  });

  it("rejectActionRewrite turns an action's rewrite into the action error", async () => {
    await expect(
      rejectActionRewrite(() => {
        throw rewrite("/m");
      }),
    ).rejects.toThrow("a server action threw it. Use redirect()");
    await expect(rejectActionRewrite(async () => 42)).resolves.toBe(42);
    await expect(
      rejectActionRewrite(() => {
        throw new Error("plain");
      }),
    ).rejects.toThrow("plain");
  });
});

describe("applyRewrite", () => {
  const flash = {
    __rsc_ls_key: "flash",
    __rsc_ls_value: { text: "hi" },
  } as LocationStateEntry;
  const Crumbs = createHandle<string>();
  const Marker = createVar<string>();

  it("moves the request, URLs and match fields to the target and keeps the rest", async () => {
    const visitorRaw =
      "https://shop.test/shop?q=1&_rsc_partial=true&_rsc_segments=a%2Cb&_rsc_v=v1";
    const { ctx, variables } = contextFor(visitorRaw, {
      headers: { cookie: "sid=1", "x-rango-prefetch": "1" },
    });
    const metrics = createMetricsStore(true);
    ctx._metricsStore = metrics;
    const onResponse = (r: Response) => r;
    const handleStoreBefore = ctx._handleStore;
    const useBefore = ctx.use;
    let reverseBefore: unknown;

    await runWithRequestContext(ctx, async () => {
      ctx.set(Marker, "pass-one");
      ctx.header("x-pass-one", "kept");
      ctx.setCookie("pass", "one");
      ctx.setStatus(503);
      ctx.setLocationState(flash);
      ctx.dynamic();
      ctx._requestTags.add("tag-a");
      ctx.onResponse(onResponse);
      setRequestContextParams({ id: "7" }, "shop");
      reverseBefore = ctx.reverse;
      ctx._requestMode = "partial-render";
      ctx._classifiedRoute = {} as never;
      ctx._documentCacheRender = true;
      (ctx as { _currentSegmentId?: string })._currentSegmentId = "M0";
      ctx._handleStore.push(Crumbs.$$id, "M0", "pass-one-crumb");

      const pass = applyRewrite(
        rewrite("maintenance"),
        ctx.request,
        ctx,
        ROUTES,
        undefined,
      );

      // Moved to the target, the visitor's _rsc* params carried.
      expect(pass.target.href).toBe("https://shop.test/maintenance");
      expect(pass.url.pathname).toBe("/maintenance");
      expect(pass.url.searchParams.get("_rsc_partial")).toBe("true");
      expect(pass.url.searchParams.get("_rsc_segments")).toBe("a,b");
      expect(pass.url.searchParams.get("_rsc_v")).toBe("v1");
      expect(pass.url.searchParams.has("q")).toBe(false);
      expect(pass.hops).toBe(1);
      expect(ctx.request).toBe(pass.request);
      expect(ctx.request.url).toBe(pass.url.href);
      expect(ctx.request.headers.get("cookie")).toBe("sid=1");
      expect(ctx.url.href).toBe("https://shop.test/maintenance");
      expect(ctx.originalUrl.href).toBe(pass.url.href);
      expect(ctx.pathname).toBe("/maintenance");
      expect(ctx.searchParams.toString()).toBe("");
      expect(ctx._requestKind).toBe("prefetch");

      // Cleared for the target's match.
      expect(ctx.params).toEqual({});
      expect(ctx.routeName).toBeUndefined();
      expect(ctx._routeName).toBeUndefined();
      expect(ctx._classifiedRoute).toBeUndefined();
      expect(ctx._requestMode).toBeUndefined();
      expect(ctx._documentCacheRender).toBeUndefined();
      expect(ctx.reverse).not.toBe(reverseBefore);

      // Kept: variables, stub status/headers/cookies, location state,
      // dynamic(), metrics, request tags, onResponse callbacks.
      expect(ctx.get(Marker)).toBe("pass-one");
      expect(ctx._variables).toBe(variables);
      expect(ctx.res.status).toBe(503);
      expect(ctx.res.headers.get("x-pass-one")).toBe("kept");
      expect(ctx.res.headers.getSetCookie().join()).toContain("pass=one");
      expect(ctx._locationState).toHaveLength(1);
      expect(ctx._dynamic).toBe(true);
      expect(ctx._metricsStore).toBe(metrics);
      expect([...ctx._requestTags]).toEqual(["tag-a"]);
      expect(ctx._onResponseCallbacks).toEqual([onResponse]);

      // A fresh handle store, loader memo and use(): pass-one pushes are gone.
      expect(ctx._handleStore).not.toBe(handleStoreBefore);
      expect(ctx.use).not.toBe(useBefore);
      expect(ctx._handleStore.getDataForSegment("M0")).toEqual({});
      ctx.use(Crumbs)("pass-two-crumb");
      expect(ctx._handleStore.getDataForSegment("M0")).toEqual({
        [Crumbs.$$id]: ["pass-two-crumb"],
      });
      expect(handleStoreBefore.getDataForSegment("M0")).toEqual({
        [Crumbs.$$id]: ["pass-one-crumb"],
      });
    });
  });

  it("keeps rewrittenFrom on the visitor's URL across hops, a copy per context", async () => {
    const { ctx } = contextFor("https://shop.test/a?x=1");
    expect(ctx.rewrittenFrom).toBeUndefined();
    await runWithRequestContext(ctx, async () => {
      applyRewrite(rewrite("/b"), ctx.request, ctx, ROUTES, undefined);
      expect(ctx.rewrittenFrom?.href).toBe("https://shop.test/a?x=1");
      const first = ctx.rewrittenFrom;
      applyRewrite(rewrite("/c?y=2"), ctx.request, ctx, ROUTES, undefined);
      expect(ctx.url.href).toBe("https://shop.test/c?y=2");
      expect(ctx.rewrittenFrom?.href).toBe("https://shop.test/a?x=1");
      expect(ctx.rewrittenFrom).not.toBe(first);
      expect(ctx.rewrittenFrom).not.toBe(ctx._rewrittenFrom);
    });
  });

  it("counts hops in the request's variables", async () => {
    const { ctx } = contextFor("https://shop.test/h0");
    await runWithRequestContext(ctx, async () => {
      for (let hop = 1; hop <= MAX_REWRITE_HOPS; hop++) {
        expect(
          applyRewrite(rewrite(`/h${hop}`), ctx.request, ctx, ROUTES, undefined)
            .hops,
        ).toBe(hop);
      }
      expect(() =>
        applyRewrite(rewrite("/h6"), ctx.request, ctx, ROUTES, undefined),
      ).toThrow(RewriteLoopError);
      // The failed hop left the context on the last target.
      expect(ctx.pathname).toBe("/h5");
    });
  });

  it("refuses a mutation and a loader fetch before moving anything", async () => {
    const post = contextFor("https://shop.test/cart", { method: "POST" });
    expect(() =>
      applyRewrite(
        rewrite("/m"),
        post.ctx.request,
        post.ctx,
        ROUTES,
        undefined,
      ),
    ).toThrow("while handling a non-GET request");
    expect(post.ctx.pathname).toBe("/cart");

    const head = contextFor("https://shop.test/cart", { method: "HEAD" });
    expect(
      applyRewrite(rewrite("/m"), head.ctx.request, head.ctx, ROUTES, undefined)
        .target.pathname,
    ).toBe("/m");

    const loader = contextFor("https://shop.test/cart?_rsc_loader=L");
    expect(() =>
      applyRewrite(
        rewrite("/m"),
        loader.ctx.request,
        loader.ctx,
        ROUTES,
        undefined,
      ),
    ).toThrow("during a loader fetch");
    expect(loader.ctx.pathname).toBe("/cart");
  });

  it("resolves names with no param auto-fill from the current route", async () => {
    const { ctx } = contextFor("https://shop.test/product/old");
    await runWithRequestContext(ctx, async () => {
      setRequestContextParams({ slug: "old" }, "product");
      expect(() =>
        applyRewrite(
          rewrite("product" as never),
          ctx.request,
          ctx,
          ROUTES,
          undefined,
        ),
      ).toThrow('Missing param "slug"');
      // A failed resolution leaves the context where it was.
      expect(ctx.pathname).toBe("/product/old");
      expect(ctx.params).toEqual({ slug: "old" });
    });
  });
});
