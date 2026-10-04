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

// Handler consumption of a loader under PPR shell capture (issues #672/#674):
// server-side HANDLER consumption (`await ctx.use(Loader)`) EXECUTES the loader
// during capture, and its value is handler output, baked into the shared
// shell and replayed on every HIT (no HIT runs a handler). An identity read
// (cookies()/headers()) in that loader body therefore trips the capture guard
// and refuses the capture: the capturing request's cookie would otherwise be
// every visitor's. (It used to be exempt, the cache() precedent, while a HIT
// re-ran the slot handler per visitor.) A loader body without identity reads
// executes and bakes normally. Client-side consumption (useLoader in a
// "use client" component under loading() or an inline <Suspense>) is the live
// lane.
//
// These tests drive the REAL match path (createRouter -> routes() -> trie ->
// router.match) under a derived capture context shaped like attemptCapture's
// (shell-capture.ts), on the index path ("/") and a non-index path
// ("/about").

const RootLayout = () => createElement("div", null, "layout");
const HomePage = createElement("div", null, "home");
const AboutPage = createElement("div", null, "about");
const Fallback = createElement("span", null, "cart-fallback");

const loaderBody = vi.fn(async () => {
  // An identity read in a handler-invoked body: during capture it trips the
  // shell guard (the value would bake into every visitor's shell).
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

describe("PPR capture: handler ctx.use consumption bakes (#672/#674)", () => {
  it("executes the loader, and its cookies() read trips the capture guard on a NON-INDEX route (/about)", async () => {
    const derived = await captureMatch("/about");

    expect(slotHandlerRan).toHaveBeenCalledTimes(1);
    expect(loaderBody).toHaveBeenCalledTimes(1);
    // The guard flags the capture (settleCaptureRecord refuses on it) and
    // names the loader that read.
    expect(derived._shellCaptureGuardTripped?.surface).toBe("cookies()");
    expect(derived._shellCaptureGuardTrippedLoaderId).toBe(
      "test#NavCartLoader672",
    );
    await expect(loaderBody.mock.results[0]!.value).rejects.toThrow(
      "cannot be called while capturing a shared shell",
    );
    // The slot handler still settles — no mask, no release machinery.
    expect(await settlesWithin(derived, 500)).toBe(true);
  });

  it("executes the loader, and its cookies() read trips the capture guard on the index route (/)", async () => {
    const derived = await captureMatch("/");

    expect(slotHandlerRan).toHaveBeenCalledTimes(1);
    expect(loaderBody).toHaveBeenCalledTimes(1);
    expect(derived._shellCaptureGuardTripped?.surface).toBe("cookies()");
    expect(await settlesWithin(derived, 500)).toBe(true);
  });

  it("executes a handler-invoked loader with its own cache() config (no identity read: no trip)", async () => {
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
