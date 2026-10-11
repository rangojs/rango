/**
 * The request context, the middleware ctx, the handle store and a parsed
 * cookie jar keep V8 fast properties (#1109). A get/set member in an object literal, a data property
 * redefined as an accessor, or an accessor defined with a per-call closure
 * puts the object in dictionary mode, where every property read is a hash
 * lookup for the object's whole lifetime. Each accessor is a shared
 * descriptor instead, and these tests pin that the property surface did not
 * change with it: same descriptors, same enumerability, same values.
 *
 * %HasFastProperties is read through V8's natives syntax, enabled at runtime;
 * on a runtime without it the fast-properties checks are skipped.
 */
import { setFlagsFromString } from "node:v8";
import { describe, expect, it } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
  wireRenderBarrier,
  type RequestContext,
} from "../request-context.js";
import { createHandleStore } from "../handle-store.js";
import { parseCookiesFromHeader } from "../cookie-parse.js";
import { createMiddlewareContext } from "../../router/middleware.js";
import { NOCACHE_SYMBOL } from "../../cache/taint.js";

function loadHasFastProperties(): ((o: object) => boolean) | undefined {
  try {
    setFlagsFromString("--allow-natives-syntax");
    return new Function("o", "return %HasFastProperties(o)") as (
      o: object,
    ) => boolean;
  } catch {
    return undefined;
  }
}
const hasFastProperties = loadHasFastProperties();
const itFast = hasFastProperties ? it : it.skip;

const THEME_CONFIG = {
  storageKey: "theme",
  themes: ["light", "dark"],
  defaultTheme: "light",
  enableSystem: true,
  attribute: "class",
  value: {},
} as any;

function makeRequestContext(path = "/p?q=1"): RequestContext<any> {
  const url = new URL(path, "https://example.com");
  return createRequestContext({
    env: {},
    request: new Request(url, { headers: { cookie: "a=1" } }),
    url,
    variables: {},
    themeConfig: THEME_CONFIG,
  });
}

function makeMiddlewareContext(holder = { response: new Response(null) }) {
  return createMiddlewareContext(
    new Request("https://example.com/p"),
    {},
    {},
    {},
    holder,
  );
}

const accessor = (enumerable: boolean, withSetter: boolean) => ({
  get: expect.any(Function),
  set: withSetter ? expect.any(Function) : undefined,
  enumerable,
  configurable: true,
});
const hidden = (value: unknown) => ({
  value,
  writable: true,
  enumerable: false,
  configurable: true,
});

describe("request context", () => {
  itFast("keeps fast properties through a request's own writes", () => {
    for (let i = 0; i < 3; i++) {
      const ctx = makeRequestContext(`/p${i}`);
      expect(hasFastProperties!(ctx)).toBe(true);
      void ctx._renderBarrier;
      ctx._resolveRenderBarrier([]);
      ctx.setStatus(404);
      ctx.set("k", i);
      ctx._routeName = "r";
      void ctx.theme;
      expect(hasFastProperties!(ctx)).toBe(true);
    }
  });

  it("res is an own enumerable accessor over the current stub response", () => {
    const ctx = makeRequestContext();
    expect(Object.getOwnPropertyDescriptor(ctx, "res")).toEqual(
      accessor(true, true),
    );
    const first = ctx.res;
    expect(first.status).toBe(200);
    ctx.setStatus(418);
    expect(ctx.res).not.toBe(first);
    expect(ctx.res.status).toBe(418);
    // A derived context reads the request's stub, as the closure did.
    expect((Object.create(ctx) as RequestContext<any>).res).toBe(ctx.res);
    expect(() => {
      (ctx as { res: Response }).res = new Response(null);
    }).toThrow("ctx.res is read-only");
  });

  it("_renderBarrier is an own enumerable accessor that pins its promise", async () => {
    const ctx = makeRequestContext();
    expect(Object.getOwnPropertyDescriptor(ctx, "_renderBarrier")).toEqual(
      accessor(true, false),
    );
    const barrier = ctx._renderBarrier;
    expect(barrier).toBeInstanceOf(Promise);
    expect(ctx._renderBarrier).toBe(barrier);
    expect(Object.getOwnPropertyDescriptor(ctx, "_renderBarrier")).toEqual({
      value: barrier,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    ctx._resolveRenderBarrier([{ type: "route", id: "M0" }]);
    await expect(barrier).resolves.toBeUndefined();
    expect(ctx._renderBarrierSegmentOrder).toEqual(["M0"]);
  });

  it("a derived context's own barrier is non-enumerable and pins on the derived context", async () => {
    const ctx = makeRequestContext();
    void ctx._renderBarrier;
    const derived = Object.create(ctx) as RequestContext<any>;
    wireRenderBarrier(derived, createHandleStore());
    expect(Object.getOwnPropertyDescriptor(derived, "_renderBarrier")).toEqual(
      accessor(false, false),
    );
    const viaChild = (Object.create(derived) as RequestContext<any>)
      ._renderBarrier;
    expect(derived._renderBarrier).toBe(viaChild);
    expect(viaChild).not.toBe(ctx._renderBarrier);
    derived._resolveRenderBarrier([]);
    await expect(viaChild).resolves.toBeUndefined();
  });

  it("theme and the unguarded reads stay non-enumerable", () => {
    const ctx = makeRequestContext();
    expect(Object.getOwnPropertyDescriptor(ctx, "theme")).toEqual(
      accessor(false, false),
    );
    expect(ctx.theme).toBe("light");
    for (const key of ["_readTheme", "_readCookie", "_readCookies"]) {
      expect(Object.getOwnPropertyDescriptor(ctx, key)).toEqual(
        hidden(expect.any(Function)),
      );
    }
    expect(Object.getOwnPropertyDescriptor(ctx, "_requestRoot")).toEqual(
      hidden(ctx),
    );
    expect(ctx._readCookie("a")).toBe("1");
    expect(ctx._readTheme()).toBe("light");
  });

  it("a spread copy carries res and the barrier as data and nothing hidden", () => {
    const ctx = makeRequestContext();
    const copy = { ...ctx } as Record<PropertyKey, unknown>;
    expect(copy.res).toBe(ctx.res);
    expect(copy._renderBarrier).toBe(ctx._renderBarrier);
    for (const key of [
      "theme",
      "_readTheme",
      "_readCookie",
      "_readCookies",
      "_requestRoot",
    ]) {
      expect(Object.hasOwn(copy, key)).toBe(false);
    }
    expect(Object.getOwnPropertySymbols(copy)).toEqual([NOCACHE_SYMBOL]);
    const keys = Object.keys(ctx);
    expect(keys).toContain("res");
    expect(keys).toContain("_renderBarrier");
    expect(keys).not.toContain("theme");
  });
});

describe("middleware ctx", () => {
  itFast("keeps fast properties", () => {
    const reqCtx = makeRequestContext();
    for (let i = 0; i < 3; i++) {
      const ctx = runWithRequestContext(reqCtx, () => makeMiddlewareContext());
      expect(hasFastProperties!(ctx)).toBe(true);
      void ctx.headers;
      void ctx.routeName;
      expect(hasFastProperties!(ctx)).toBe(true);
    }
  });

  it("its getters are own enumerable accessors that read live state", () => {
    const reqCtx = makeRequestContext();
    const holder = { response: new Response(null) };
    runWithRequestContext(reqCtx, () => {
      const ctx = makeMiddlewareContext(holder) as typeof reqCtx & {
        _routeName?: string;
      };
      for (const key of ["routeName", "_routeName", "headers", "setTheme"]) {
        expect(Object.getOwnPropertyDescriptor(ctx, key)).toEqual(
          accessor(true, false),
        );
      }
      expect(Object.getOwnPropertyDescriptor(ctx, "theme")).toEqual(
        accessor(false, false),
      );
      expect(ctx.routeName).toBeUndefined();
      reqCtx._routeName = "blog.post";
      expect(ctx.routeName).toBe("blog.post");
      expect(ctx._routeName).toBe("blog.post");
      expect(ctx.setTheme).toBe(reqCtx.setTheme);
      // Before next(): the request's stub. After: the downstream response.
      ctx.headers.set("x-pre", "1");
      expect(reqCtx.res.headers.get("x-pre")).toBe("1");
      holder.response = new Response(null, { headers: { "x-post": "1" } });
      expect(ctx.headers.get("x-post")).toBe("1");
    });
  });
});

describe("handle store", () => {
  itFast("keeps fast properties", () => {
    for (let i = 0; i < 3; i++) {
      const store = createHandleStore();
      store.onError = () => {};
      void store.settled;
      void store.fullySettled;
      expect(hasFastProperties!(store)).toBe(true);
    }
  });

  it("settled and fullySettled are own enumerable accessors over the lanes", async () => {
    const store = createHandleStore();
    for (const key of ["settled", "fullySettled"]) {
      expect(Object.getOwnPropertyDescriptor(store, key)).toEqual(
        accessor(true, false),
      );
    }
    let release!: () => void;
    store.trackAuxiliary(new Promise<void>((r) => (release = r)));
    let settled = false;
    let fullySettled = false;
    void store.settled.then(() => (settled = true));
    void store.fullySettled.then(() => (fullySettled = true));
    store.seal();
    await Promise.resolve();
    expect([settled, fullySettled]).toEqual([true, false]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(fullySettled).toBe(true);
  });
});

describe("parsed cookie jar", () => {
  itFast("keeps fast properties with a null prototype", () => {
    const jar = parseCookiesFromHeader(
      "a=1; constructor=c; __proto__=p; toString=t",
    );
    expect(Object.getPrototypeOf(jar)).toBeNull();
    expect(hasFastProperties!(jar)).toBe(true);
    expect(Object.entries(jar)).toEqual([
      ["a", "1"],
      ["constructor", "c"],
      ["__proto__", "p"],
      ["toString", "t"],
    ]);
  });
});
