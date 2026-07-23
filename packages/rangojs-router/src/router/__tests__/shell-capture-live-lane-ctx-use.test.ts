import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createElement } from "react";
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { cookies } from "../../server/cookie-store.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

// The CONSUMPTION-LANE RULE under PPR shell capture (issue #672 / #674):
// server-side HANDLER consumption of a loader (`await ctx.use(Loader)`)
// EXECUTES the loader during capture and its value BAKES into the shared
// shell — including identity reads (cookies()/headers()), which are EXEMPT
// from the shell-capture guard for handler-invoked loader bodies. This
// mirrors cache()/"use cache", where handler-consumed loader values are
// captured into the shared artifact and identity reads are likewise
// permitted (see /caching "Cache purity & tainted objects"). Client-side
// consumption (useLoader in a "use client" component) is the LIVE lane; DSL
// segment loaders keep their lane machinery (renderable loading() = masked
// live lane, otherwise bake lane WITH the guard active).
//
// History: the first #672 fix masked handler consumption (prime + release
// machinery); it regressed cache()-composed fixtures (cloudflare-basic
// /ppr-blog) and contradicted the cache() precedent, so it was replaced with
// this rule. These tests drive the REAL match path (createRouter -> routes()
// -> trie -> router.match) under a derived capture context shaped like
// attemptCapture's (shell-capture.ts). Both the index path ("/") and a
// non-index path ("/about") are pinned: pre-rule, the cookies() read tripped
// the identity guard and refused the capture forever on EVERY route (the
// issue's "/ works" was a stale-shell artifact).

const RootLayout = () => createElement("div", null, "layout");
const HomePage = createElement("div", null, "home");
const AboutPage = createElement("div", null, "about");
const Fallback = createElement("span", null, "cart-fallback");

const loaderBody = vi.fn(async () => {
  // The identity read the rule permits for handler-invoked bodies: during
  // capture this must NOT trip the shell guard; the value bakes as a
  // capture-time copy (the documented footgun — client-side useLoader is the
  // live lane).
  const cartId = cookies().get("cart_id")?.value ?? null;
  return { cartId };
});

const NavCartLoader = (createLoader as Function)(
  loaderBody,
  undefined,
  "test#NavCartLoader672",
);

const slotHandlerRan = vi.fn();

// Server-side consumption in the slot handler — the issue's repro shape.
const CartIcon = async (ctx: any) => {
  slotHandlerRan();
  const cart = await ctx.use(NavCartLoader);
  return createElement("div", null, JSON.stringify(cart));
};

// Loader with its own cache() config, consumed the same way: identical
// handler-invoked semantics (executes at capture, value bakes) — this was the
// /ppr-blog regression shape under the withdrawn masking fix.
const cachedLoaderBody = vi.fn(async () => ({ cart: "shared" }));

const CachedCartLoader = (createLoader as Function)(
  cachedLoaderBody,
  undefined,
  "test#CachedCartLoader672",
);

const CachedCartIcon = async (ctx: any) => {
  const cart = await ctx.use(CachedCartLoader);
  return createElement("div", null, JSON.stringify(cart));
};

let router: any;

beforeAll(async () => {
  router = createRouter({} as any);
  router.routes(({ layout, loader, loading, parallel, path, cache }: any) => [
    layout(RootLayout, () => [
      parallel({ "@navCart": CartIcon }, () => [
        loader(NavCartLoader),
        loading(Fallback),
      ]),
      path("/", HomePage, { name: "home672", ppr: true }),
      path("/about", AboutPage, { name: "about672", ppr: true }),
    ]),
    layout(RootLayout, () => [
      parallel({ "@cachedCart": CachedCartIcon }, () => [
        loader(CachedCartLoader, () => [cache()]),
        loading(Fallback),
      ]),
      path("/cached", HomePage, { name: "cached672", ppr: true }),
    ]),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(() => {
  loaderBody.mockClear();
  cachedLoaderBody.mockClear();
  slotHandlerRan.mockClear();
});

function makeRequest(pathname: string): Request {
  return new Request(`https://example.com${pathname}`, {
    headers: { accept: "text/html", cookie: "cart_id=abc" },
  });
}

function makeRequestContext(pathname: string): RequestContext<any> {
  const request = makeRequest(pathname);
  return createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any);
}

/** Derive a capture context the way attemptCapture (shell-capture.ts) does. */
function deriveCaptureContext(
  reqCtx: RequestContext<any>,
): RequestContext<any> {
  const derived: any = Object.create(reqCtx);
  derived._shellCaptureRun = true;
  derived._shellCaptureLoaderRecords = new Map();
  derived._metricsStore = undefined;
  derived._tracing = undefined;
  return derived;
}

/** True iff the handle store settles (after seal) within `ms`. */
async function settlesWithin(
  reqCtx: RequestContext<any>,
  ms: number,
): Promise<boolean> {
  reqCtx._handleStore.seal();
  return Promise.race([
    reqCtx._handleStore.settled.then(() => true),
    new Promise<boolean>((r) => {
      const t = setTimeout(() => r(false), ms);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

async function captureMatch(pathname: string): Promise<RequestContext<any>> {
  const reqCtx = makeRequestContext(pathname);
  const derived = deriveCaptureContext(reqCtx);
  await runWithRequestContext(derived, () =>
    router.match(makeRequest(pathname), { env: {} }),
  );
  // Let the streamed slot handler's microtasks run.
  await new Promise((r) => setTimeout(r, 20));
  return derived;
}

describe("PPR capture: handler ctx.use consumption bakes (consumption-lane rule, #672/#674)", () => {
  it("executes the loader and exempts its cookies() read on a NON-INDEX route (/about)", async () => {
    const derived = await captureMatch("/about");

    expect(slotHandlerRan).toHaveBeenCalledTimes(1);
    expect(loaderBody).toHaveBeenCalledTimes(1);
    // The identity guard must NOT trip: handler-invoked loader bodies are
    // exempt (baked shared copy — the cache() precedent).
    expect(derived._shellCaptureGuardTripped).toBeUndefined();
    // The identity read succeeded inside the exempt body.
    await expect(loaderBody.mock.results[0]!.value).resolves.toEqual({
      cartId: "abc",
    });
    // The slot handler settles normally — no mask, no release machinery —
    // so the capture's quiesce (settled + byte-quiet) is unobstructed.
    expect(await settlesWithin(derived, 500)).toBe(true);
  });

  it("executes the loader and exempts its cookies() read on the index route (/)", async () => {
    const derived = await captureMatch("/");

    expect(slotHandlerRan).toHaveBeenCalledTimes(1);
    expect(loaderBody).toHaveBeenCalledTimes(1);
    expect(derived._shellCaptureGuardTripped).toBeUndefined();
    expect(await settlesWithin(derived, 500)).toBe(true);
  });

  it("treats a loader with its own cache() config identically (handler-invoked = executes)", async () => {
    const derived = await captureMatch("/cached");

    expect(cachedLoaderBody).toHaveBeenCalledTimes(1);
    expect(derived._shellCaptureGuardTripped).toBeUndefined();
    expect(await settlesWithin(derived, 500)).toBe(true);
  });

  it("executes the loader normally outside capture (sanity: capture changes nothing here)", async () => {
    const reqCtx = makeRequestContext("/about");
    await runWithRequestContext(reqCtx, () =>
      router.match(makeRequest("/about"), { env: {} }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(slotHandlerRan).toHaveBeenCalledTimes(1);
    expect(loaderBody).toHaveBeenCalledTimes(1);
    expect((reqCtx as any)._shellCaptureGuardTripped).toBeUndefined();
  });
});
