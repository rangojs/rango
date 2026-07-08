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
 * - the pinned cache()-loader write exemption — DSL (registered) loaders ONLY
 *   (vite-rsc-demo shop cart); a handler-invoked loader body throws under
 *   cache() because it is skipped with its handler on a hit (#725),
 * - a handler-invoked loader nested under a DSL loader stays exempt (the DSL
 *   parent re-runs it every hit),
 * - middleware merge order on the shell-HIT serve path
 *   (createResponseWithMergedHeaders: serve-owned headers win, middleware
 *   headers merge, Set-Cookie appends).
 */
import { describe, expect, it } from "vitest";
import {
  RangoContext,
  assertCachedHeaderWriteAllowed,
  clearPprHeaderScope,
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

  it("cache() + DSL loader: ALLOWED (pinned exemption — DSL loaders re-run and merge per request)", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("cache", "shop");
      runInsideLoaderScope(() => {
        expect(() =>
          assertCachedHeaderWriteAllowed("ctx.setCookie()"),
        ).not.toThrow();
      });
    });
  });

  // #725 gap: a handler-invoked loader body (ctx.use from a handler, never
  // registered with loader()) runs only on the MISS — on a HIT the handler and
  // this loader are skipped, so its write would silently vanish. It must throw,
  // NOT ride the DSL exemption. Regression pin (red before the guard narrowed to
  // isInsideLoaderScope()).
  it("cache() + handler-invoked loader body: THROWS (handler skipped on hit, write would vanish)", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("cache", "shop");
      runInsideLoaderBodyScope(
        () => {
          const err = captureError(() =>
            assertCachedHeaderWriteAllowed("ctx.setCookie()"),
          );
          expect(err.message).toContain("from a loader");
          expect(err.message).toContain("cache() boundary");
          expect(err.message).toContain("the handler is skipped");
          expect(err.message).toMatch(FAMILY_RE);
        },
        "CartLoader",
        true,
      );
    });
  });

  // The DSL scope ALS survives into nested ctx.use bodies, so a handler-invoked
  // loader nested under a DSL loader stays exempt: the DSL parent re-runs on
  // every hit and re-invokes it, so no MISS/HIT divergence exists.
  it("cache() + handler-invoked loader body nested in a DSL loader: ALLOWED (DSL parent re-runs it every hit)", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("cache", "shop");
      runInsideLoaderScope(() => {
        runInsideLoaderBodyScope(
          () => {
            expect(() =>
              assertCachedHeaderWriteAllowed("ctx.setCookie()"),
            ).not.toThrow();
          },
          "NestedLoader",
          true,
        );
      });
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

// #735: ctx.dynamic() clears the ppr latch — a dynamic() render is always live
// (never a shell HIT), so its handler header writes are deterministic and the
// guard's reason to forbid them evaporates. Only the "ppr" kind is cleared; a
// cache() boundary is a separate axis whose writes stay non-deterministic.
describe("clearPprHeaderScope (issue #735 — dynamic() re-permit)", () => {
  it("clears a ppr latch so a subsequent handler write is allowed; write-before still throws", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "product");
      // BEFORE dynamic(): the latch is live, the write throws (#725 pin).
      expect(() =>
        assertCachedHeaderWriteAllowed("ctx.headers.set()"),
      ).toThrowError(FAMILY_RE);
      clearPprHeaderScope();
      // AFTER: latch cleared, the write is re-permitted.
      expect(() =>
        assertCachedHeaderWriteAllowed("ctx.headers.set()"),
      ).not.toThrow();
    });
  });

  it("does NOT clear a cache() latch (separate axis, writes stay non-deterministic)", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("cache", "cached.page");
      clearPprHeaderScope();
      expect(() =>
        assertCachedHeaderWriteAllowed("ctx.headers.set()"),
      ).toThrowError(FAMILY_RE);
    });
  });

  it("composition: a cache() entry AFTER dynamic() re-latches 'cache' and re-guards the write", () => {
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "product");
      clearPprHeaderScope();
      // A nested cache() boundary re-latches "cache" (the field is undefined
      // again after the clear, so latchCachedHeaderScope's !latched guard sets).
      latchCachedHeaderScope("cache", "product.cached");
      const err = captureError(() =>
        assertCachedHeaderWriteAllowed("ctx.headers.set()"),
      );
      expect(err.message).toContain("cache() boundary");
      expect(err.message).toMatch(FAMILY_RE);
    });
  });

  it("ppr route nested under a cache() boundary: dynamic() UNMASKS to 'cache', write still throws (cache axis not opted off)", () => {
    // fresh.ts latches "ppr" at the funnel top (first-wins), masking the
    // positional cache() latch, but the handler still runs inside the cache
    // scope. A cache() HIT skips the handler, so the write stays
    // non-deterministic — dynamic() opts off the SHELL axis, not the cache axis.
    RangoContext.run(makeStore() as never, () => {
      const store = RangoContext.getStore() as { insideCacheScope?: boolean };
      store.insideCacheScope = true; // fresh.ts sets this when entering cache()
      latchCachedHeaderScope("ppr", "product");
      clearPprHeaderScope();
      const err = captureError(() =>
        assertCachedHeaderWriteAllowed("ctx.headers.set()"),
      );
      // Now guarded with the accurate cache() wording, not the ppr wording.
      expect(err.message).toContain("cache() boundary");
      expect(err.message).not.toContain("ppr route");
      expect(err.message).toMatch(FAMILY_RE);
    });
  });

  it("no-op when there is nothing to clear (non-ppr route, or middleware outside the funnel store)", () => {
    // No ppr latch inside a funnel store (dynamic() on a non-ppr route)...
    RangoContext.run(makeStore() as never, () => {
      expect(() => clearPprHeaderScope()).not.toThrow();
    });
    // ...and no funnel store at all (dynamic() from middleware, before the
    // render funnel's Store.run — getStore() is undefined). Neither throws.
    expect(() => clearPprHeaderScope()).not.toThrow();
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

  it("ctx.dynamic() re-permits handler header/cookie writes on a ppr route (#735)", () => {
    const reqCtx = makeReqCtx();
    RangoContext.run(makeStore() as never, () => {
      latchCachedHeaderScope("ppr", "p");
      // Before dynamic(): the ppr latch forbids the write.
      expect(() => reqCtx.header("X-A", "1")).toThrowError(FAMILY_RE);
      // dynamic() clears the latch through the real ctx seam.
      reqCtx.dynamic();
      expect(reqCtx._dynamic).toBe(true);
      // After: the same writes land on the stub.
      reqCtx.header("X-A", "1");
      reqCtx.setCookie("s", "v");
      expect(reqCtx.res.headers.get("X-A")).toBe("1");
      expect(reqCtx.res.headers.get("Set-Cookie")).toContain("s=v");
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
