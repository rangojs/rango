/**
 * The response sink (server/response-sink.ts): the request's writers and the
 * discarding sink a render pass that must not write the response gets. The
 * discarding sink keeps the request sink's guards and errors; only where its
 * writes land differs.
 */
import { describe, expect, it } from "vitest";
import { createResponseSink } from "../response-sink.js";
import { createRequestContext } from "../request-context.js";
import { RangoContext, latchCachedHeaderScope } from "../context.js";
import { runWithCacheExecScope } from "../../cache/cache-exec-scope.js";
import { stampCacheExec, unstampCacheExec } from "../../cache/taint.js";
import { KEEP_CACHE_HEADER } from "../../browser/cookie-name.js";
import { resolveThemeConfig } from "../../theme/constants.js";

const CACHED_SCOPE_RE =
  /cannot be called from a handler on a ppr route.*Set response headers in route middleware instead/s;
const USE_CACHE_RE = /cannot be called inside a "use cache" function/;

function makeStore(): Record<string, unknown> {
  return {
    manifest: new Map(),
    namespace: "#test",
    parent: null,
    counters: {},
  };
}

function discardingSink() {
  return createResponseSink({
    discard: true,
    themeConfig: resolveThemeConfig(true),
  });
}

describe("discarding sink", () => {
  it("writes its own response; no state cookie", () => {
    const sink = discardingSink();
    const first = sink.response();

    sink.header("x-a", "1");
    sink.setCookie("a", "1");
    sink.deleteCookie("b");
    sink.setTheme!("dark");
    sink._rotateStateCookie();
    sink._setKeepCacheDirective();
    sink.setStatus(500);
    sink._setStatus(404);

    expect(sink.response()).not.toBe(first);
    expect(sink.response().status).toBe(404);
    expect(sink.response().headers.get("x-a")).toBe("1");
    expect(sink.response().headers.get(KEEP_CACHE_HEADER)).toBe("1");
    expect(sink.response().headers.getSetCookie()).toEqual([
      "a=1",
      "b=; Max-Age=0",
      expect.stringMatching(/^theme=dark;/),
    ]);
    expect(Object.fromEntries(sink.cookieWrites())).toEqual({
      a: "1",
      b: null,
      theme: "dark",
    });
  });

  it("has no setTheme without a theme config", () => {
    expect(
      createResponseSink({ discard: true, themeConfig: undefined }).setTheme,
    ).toBeUndefined();
  });

  it("keeps the cached-scope guard; the internal writers stay exempt", () => {
    const sink = discardingSink();
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "p");
      expect(() => sink.header("x-a", "1")).toThrowError(CACHED_SCOPE_RE);
      expect(() => sink.setCookie("a", "1")).toThrowError(CACHED_SCOPE_RE);
      expect(() => sink.deleteCookie("a")).toThrowError(CACHED_SCOPE_RE);
      expect(() => sink.setStatus(418)).toThrowError(CACHED_SCOPE_RE);
      expect(() => sink.setTheme!("dark")).toThrowError(CACHED_SCOPE_RE);
      expect(() => sink.response().headers.set("x-a", "1")).toThrowError(
        CACHED_SCOPE_RE,
      );
      sink._setStatus(500);
      sink._setKeepCacheDirective();
    });
    expect(sink.response().status).toBe(500);
    expect(sink.response().headers.get("x-a")).toBeNull();
    expect(sink.response().headers.getSetCookie()).toEqual([]);
  });

  it('keeps the "use cache" guard', () => {
    const sink = discardingSink();
    runWithCacheExecScope(() => {
      expect(() => sink.header("x-a", "1")).toThrowError(USE_CACHE_RE);
      expect(() => sink.setCookie("a", "1")).toThrowError(USE_CACHE_RE);
      expect(() => sink.deleteCookie("a")).toThrowError(USE_CACHE_RE);
      expect(() => sink.setStatus(418)).toThrowError(USE_CACHE_RE);
      expect(() => sink.setTheme!("dark")).toThrowError(USE_CACHE_RE);
    });
  });
});

describe("request sink", () => {
  it('guards its writers with the request context\'s "use cache" argument stamp', () => {
    const request = new Request("https://example.com/p");
    const ctx = createRequestContext({
      env: {},
      request,
      url: new URL(request.url),
      variables: {},
      themeConfig: resolveThemeConfig(true),
    });
    stampCacheExec(ctx);
    try {
      expect(() => ctx.header("x-a", "1")).toThrowError(USE_CACHE_RE);
      expect(() => ctx.setCookie("a", "1")).toThrowError(USE_CACHE_RE);
      expect(() => ctx.deleteCookie("a")).toThrowError(USE_CACHE_RE);
      expect(() => ctx.setStatus(418)).toThrowError(USE_CACHE_RE);
      expect(() => ctx.setTheme!("dark")).toThrowError(USE_CACHE_RE);
    } finally {
      unstampCacheExec(ctx);
    }
    ctx.header("x-a", "1");
    expect(ctx.res.headers.get("x-a")).toBe("1");
  });
});
