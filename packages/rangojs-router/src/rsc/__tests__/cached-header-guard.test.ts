/**
 * Unified cached-scope response-header write guard (issue #713).
 *
 * Doctrine: ppr is a document-scoped cache() — in any cached scenario ONLY
 * MIDDLEWARE writes headers. These tests pin:
 * - the guard seam itself (both kinds x both layers, first-latch-wins),
 * - the latch predicate (ppr entry detection, leaf-input parity with the
 *   serve path),
 * - the guarded surfaces (handler ctx.headers proxy; RequestContext
 *   header/setCookie/deleteCookie/setTheme and the raw ctx.res.headers
 *   escape, all via the guarded-stub-headers choke point; setStatus
 *   enumerated),
 * - PPR/cache() message-family EQUIVALENCE (same Error class, same family),
 * - the pinned cache()-loader write exemption (vite-rsc-demo shop cart),
 * - middleware merge order on the shell-HIT serve path
 *   (createResponseWithMergedHeaders: serve-owned headers win, middleware
 *   headers merge, Set-Cookie appends).
 */
import { describe, expect, it } from "vitest";
import {
  RangoContext,
  assertCachedHeaderWriteAllowed,
  latchCachedHeaderScope,
  latchPprHeaderScopeForEntries,
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
  type EntryData,
} from "../../server/context.js";
import { createHandlerContext } from "../../router/handler-context.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { createResponseWithMergedHeaders } from "../helpers.js";

/** The one message family both kinds share (the equivalence pin). */
const FAMILY_RE =
  /cannot be called from a (handler|loader) (on a ppr route|inside a cache\(\) boundary).*Set response headers in route middleware instead/s;

function makeStore(): Record<string, unknown> {
  return {
    manifest: new Map(),
    namespace: "#test",
    parent: null,
    counters: {},
  };
}

function routeEntry(ppr: unknown): EntryData {
  return {
    type: "route",
    id: "r",
    shortCode: "R0",
    parent: null,
    ppr,
  } as unknown as EntryData;
}

function captureError(fn: () => void): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected fn to throw");
}

describe("assertCachedHeaderWriteAllowed (the seam)", () => {
  it("no latch: allows writes (plain uncached route)", () => {
    RangoContext.run(makeStore() as never, () => {
      expect(() =>
        assertCachedHeaderWriteAllowed("ctx.headers.set()"),
      ).not.toThrow();
    });
  });

  it("ppr + handler: throws, naming surface, layer, route, and the fix", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "product");
      const err = captureError(() =>
        assertCachedHeaderWriteAllowed("ctx.headers.set()"),
      );
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("ctx.headers.set()");
      expect(err.message).toContain("from a handler");
      expect(err.message).toContain('route "product"');
      expect(err.message).toContain("ppr");
      expect(err.message).toContain("Set response headers in route middleware");
      expect(err.message).toMatch(FAMILY_RE);
    });
  });

  it("ppr + loader (DSL loader scope): throws with the loader wording", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "product");
      runInsideLoaderScope(() => {
        const err = captureError(() =>
          assertCachedHeaderWriteAllowed("ctx.setCookie()"),
        );
        expect(err.message).toContain("from a loader");
        expect(err.message).toContain("before loaders settle");
        expect(err.message).toMatch(FAMILY_RE);
      });
    });
  });

  it("ppr + loader (handler-invoked loader body): throws with the loader wording", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr");
      runInsideLoaderBodyScope(
        () => {
          const err = captureError(() =>
            assertCachedHeaderWriteAllowed("ctx.setCookie()"),
          );
          expect(err.message).toContain("from a loader");
        },
        "TestLoader",
        true,
      );
    });
  });

  it("cache() + handler: throws with the cache() boundary wording", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("cache", "cached.page");
      const err = captureError(() =>
        assertCachedHeaderWriteAllowed("ctx.header()"),
      );
      expect(err.message).toContain("cache() boundary");
      expect(err.message).toContain('route "cached.page"');
      expect(err.message).toMatch(FAMILY_RE);
    });
  });

  it("EQUIVALENCE: ppr and cache() errors are the same class and message family", () => {
    const pprErr = RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "r");
      return captureError(() =>
        assertCachedHeaderWriteAllowed("ctx.headers.set()"),
      );
    });
    const cacheErr = RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("cache", "r");
      return captureError(() =>
        assertCachedHeaderWriteAllowed("ctx.headers.set()"),
      );
    });
    expect(pprErr.constructor).toBe(cacheErr.constructor);
    expect(pprErr.message).toMatch(FAMILY_RE);
    expect(cacheErr.message).toMatch(FAMILY_RE);
  });

  it("cache() + loader: ALLOWED (pinned exemption — loaders re-run and merge per request)", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("cache", "shop");
      runInsideLoaderScope(() => {
        expect(() =>
          assertCachedHeaderWriteAllowed("ctx.setCookie()"),
        ).not.toThrow();
      });
      runInsideLoaderBodyScope(
        () => {
          expect(() =>
            assertCachedHeaderWriteAllowed("ctx.setCookie()"),
          ).not.toThrow();
        },
        "CartLoader",
        true,
      );
    });
  });

  it("first latch wins: a nested cache() does not downgrade a ppr scope", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "product");
      latchCachedHeaderScope("cache", "product");
      const err = captureError(() =>
        assertCachedHeaderWriteAllowed("ctx.headers.set()"),
      );
      expect(err.message).toContain("ppr");
    });
  });
});

describe("latchPprHeaderScopeForEntries (the latch predicate)", () => {
  function latchedKind(entries: EntryData[]): string | undefined {
    const store = makeStore();
    return RangoContext.run(store as never, () => {
      latchPprHeaderScopeForEntries(entries, "k");
      return (store as { cachedHeaderScope?: { kind: string } })
        .cachedHeaderScope?.kind;
    });
  }

  it("latches for ppr: true and ppr: { ttl }", () => {
    expect(latchedKind([routeEntry(true)])).toBe("ppr");
    expect(latchedKind([routeEntry({ ttl: 600 })])).toBe("ppr");
  });

  it("does not latch for ppr: false, undefined, or non-route entries", () => {
    expect(latchedKind([routeEntry(false)])).toBeUndefined();
    expect(latchedKind([routeEntry(undefined)])).toBeUndefined();
    expect(
      latchedKind([
        {
          type: "layout",
          id: "l",
          shortCode: "L0",
          parent: null,
        } as unknown as EntryData,
      ]),
    ).toBeUndefined();
  });

  it("checks the LEAF entry only — input parity with resolvePprConfig(manifestEntry)", () => {
    // ppr on an ANCESTOR route with a plain leaf: the serve path reads ppr off
    // the leaf manifestEntry and would NOT shell-serve, so the guard must not
    // latch either (same predicate, same input).
    expect(latchedKind([routeEntry(true), routeEntry(undefined)])).toBe(
      undefined,
    );
    // ppr on the leaf latches regardless of ancestors.
    expect(latchedKind([routeEntry(undefined), routeEntry(true)])).toBe("ppr");
    expect(latchedKind([])).toBeUndefined();
  });
});

describe("guarded surfaces", () => {
  const THEME_CONFIG = {
    defaultTheme: "light",
    themes: ["light", "dark"],
    attribute: "class",
    storageKey: "test-theme",
    enableSystem: false,
    enableColorScheme: false,
    value: {},
  } as const;

  function makeReqCtx(withTheme = false) {
    return createRequestContext({
      env: {},
      request: new Request("http://localhost/p"),
      url: new URL("http://localhost/p"),
      variables: {},
      ...(withTheme ? { themeConfig: THEME_CONFIG as never } : {}),
    });
  }

  it("handler ctx.headers.set/append/delete throw under a ppr latch; reads stay open", () => {
    const reqCtx = makeReqCtx();
    RangoContext.run(makeStore() as never, () => {
      runWithRequestContext(reqCtx, () => {
        const ctx = createHandlerContext(
          {},
          new Request("http://localhost/p"),
          new URLSearchParams(),
          "/p",
          new URL("http://localhost/p"),
        );
        latchCachedHeaderScope("ppr", "p");
        expect(() => ctx.headers.set("X-A", "1")).toThrowError(FAMILY_RE);
        expect(() => ctx.headers.append("X-A", "1")).toThrowError(FAMILY_RE);
        expect(() => ctx.headers.delete("X-A")).toThrowError(FAMILY_RE);
        // Reads never trip the write guard.
        expect(ctx.headers.get("X-A")).toBeNull();
      });
    });
  });

  it("RequestContext header/setCookie/deleteCookie/setStatus throw under a ppr latch", () => {
    const reqCtx = makeReqCtx();
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "p");
      expect(() => reqCtx.header("X-A", "1")).toThrowError(FAMILY_RE);
      expect(() => reqCtx.setCookie("s", "1")).toThrowError(FAMILY_RE);
      expect(() => reqCtx.deleteCookie("s")).toThrowError(FAMILY_RE);
      expect(() => reqCtx.setStatus(418)).toThrowError(FAMILY_RE);
    });
  });

  it("ctx.setTheme throws under a ppr latch (via the choke point, no dedicated wrapper)", () => {
    const reqCtx = makeReqCtx(true);
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "p");
      expect(() => reqCtx.setTheme!("dark")).toThrowError(FAMILY_RE);
      // The theme cookie never reached the stub.
      expect(reqCtx.res.headers.get("Set-Cookie")).toBeNull();
    });
  });

  it("ctx.setTheme outside cached scopes works (middleware lane)", () => {
    const reqCtx = makeReqCtx(true);
    RangoContext.run(makeStore() as never, () => {
      // No latch: the live lane.
      reqCtx.setTheme!("dark");
      expect(reqCtx.res.headers.get("Set-Cookie")).toContain("test-theme=dark");
      expect(reqCtx.theme).toBe("dark");
    });
  });

  it("the raw ctx.res.headers escape is closed: mutations throw under a latch, reads stay open", () => {
    const reqCtx = makeReqCtx();
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "p");
      expect(() => reqCtx.res.headers.set("X-A", "1")).toThrowError(FAMILY_RE);
      expect(() => reqCtx.res.headers.append("X-A", "1")).toThrowError(
        FAMILY_RE,
      );
      expect(() => reqCtx.res.headers.delete("X-A")).toThrowError(FAMILY_RE);
      expect(reqCtx.res.headers.get("X-A")).toBeNull();
    });
    // Outside the latched scope the same surface writes normally.
    reqCtx.res.headers.set("X-B", "2");
    expect(reqCtx.res.headers.get("X-B")).toBe("2");
  });

  it("the serve-path drain stays exempt: stub mutations after the latched scope exited", () => {
    const reqCtx = makeReqCtx();
    RangoContext.run(makeStore() as never, () => {
      reqCtx.setCookie("session", "abc"); // pre-latch (middleware lane)
      latchCachedHeaderScope("ppr", "p");
    });
    // The funnel scope is gone — the finalization drain (rsc/helpers.ts
    // createResponseWithMergedHeaders) deletes the consumed Set-Cookie
    // through the same guarded surface without tripping the guard.
    const response = runWithRequestContext(reqCtx, () =>
      createResponseWithMergedHeaders(null, { headers: {} }),
    );
    expect(response.headers.getSetCookie().join(";")).toContain("session=abc");
    expect(reqCtx.res.headers.get("Set-Cookie")).toBeNull();
  });

  it("middleware lane stays open: writes made before the latch (pre-next) land on the stub", () => {
    const reqCtx = makeReqCtx();
    RangoContext.run(makeStore() as never, () => {
      // Middleware pre-next phase: nothing latched yet.
      reqCtx.header("X-Mw", "live");
      reqCtx.setCookie("session", "abc");
      // Render latches afterwards; the earlier writes are already applied.
      latchCachedHeaderScope("ppr", "p");
      expect(reqCtx.res.headers.get("X-Mw")).toBe("live");
      expect(reqCtx.res.headers.get("Set-Cookie")).toContain("session=abc");
    });
  });
});

describe("middleware merge on the shell-HIT serve path", () => {
  it("createResponseWithMergedHeaders merges middleware stub headers and appends Set-Cookie; serve-owned headers win", () => {
    const reqCtx = createRequestContext({
      env: {},
      request: new Request("http://localhost/p"),
      url: new URL("http://localhost/p"),
      variables: {},
    });
    // Middleware writes (pre-next lane).
    reqCtx.header("X-Mw", "live");
    reqCtx.header("content-type", "text/plain"); // must NOT beat serve-owned
    reqCtx.setCookie("session", "abc");
    reqCtx.setCookie("basket", "b1");

    const response = runWithRequestContext(reqCtx, () =>
      createResponseWithMergedHeaders(null, {
        headers: {
          "content-type": "text/html;charset=utf-8",
          "x-rango-shell": "HIT",
        },
      }),
    );

    // Serve-owned headers are untouched by the stub merge.
    expect(response.headers.get("content-type")).toBe(
      "text/html;charset=utf-8",
    );
    expect(response.headers.get("x-rango-shell")).toBe("HIT");
    // Middleware header rides the HIT response.
    expect(response.headers.get("X-Mw")).toBe("live");
    // Both cookies survive as separate Set-Cookie entries (append, not set).
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("session=abc"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("basket=b1"))).toBe(true);
    // The stub's Set-Cookie is drained so downstream merges cannot duplicate.
    expect(reqCtx.res.headers.get("Set-Cookie")).toBeNull();
  });
});
