/**
 * #978: a document-cache entry serves every visitor, so its payload must not
 * carry the visitor's theme as `initialTheme` (ThemeProvider's first state).
 * Served through the public serveShellRequest, which runs the router's global
 * middleware (createDocumentCacheMiddleware) and settles the MISS's store
 * write (and a stale refresh) before it returns: a dark visitor warms or
 * refreshes the entry, and a visitor with no stored theme gets the no-cookie
 * default from it. A render whose response has not opted in keeps the
 * visitor's theme, and so does a 404 on a URL middleware opted in. A
 * Cache-Control written after the render (route middleware after
 * `await next()`) comes too late for the render to use the default, so the
 * cache refuses a response that carries a theme other than the default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import {
  createRouter,
  urls,
  type HandlerContext,
  type Middleware,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
} from "../../cache/index.js";

const CACHE_CONTROL = "s-maxage=60, stale-while-revalidate=300";

function StoredPage(ctx: HandlerContext): React.ReactNode {
  ctx.headers.set("Cache-Control", CACHE_CONTROL);
  return <p>stored</p>;
}

function PlainPage(): React.ReactNode {
  return <p>plain</p>;
}

let renders = 0;

function CountedPage(): React.ReactNode {
  return <p>{`render-${++renders}`}</p>;
}

const lateCacheControl: Middleware = async (ctx, next) => {
  await next();
  ctx.header("Cache-Control", CACHE_CONTROL);
};

/** Opts every /early URL in before next(); s-maxage=0 is stale at once. */
const earlyCacheControl: Middleware = async (ctx, next) => {
  ctx.header("Cache-Control", "s-maxage=0, stale-while-revalidate=300");
  await next();
};

function setup() {
  // theme: true defaults to "system".
  const router = createRouter({ theme: true })
    .use(createDocumentCacheMiddleware())
    .use("/early/*", earlyCacheControl)
    .routes(
      urls(({ path, middleware }) => [
        path("/stored", StoredPage, { name: "stored" }),
        path("/plain", PlainPage, { name: "plain" }),
        path("/early", CountedPage, { name: "early" }),
        middleware(lateCacheControl, () => [
          path("/late", PlainPage, { name: "late" }),
        ]),
      ]),
    );
  const cacheStore = new MemorySegmentCacheStore();
  /** One document request; `theme` null sends no theme cookie. */
  const serve = async (url: string, theme: string | null) => {
    const result = await serveShellRequest(router, url, {
      cacheStore,
      headers: theme === null ? {} : { cookie: `theme=${theme}` },
    });
    return {
      code: result.response.status,
      status: result.response.headers.get("x-document-cache-status"),
      body: result.body,
    };
  };
  return { serve };
}

const theme = (value: string) => `"initialTheme":"${value}"`;

/** Let Date.now() pass an s-maxage=0 entry's staleAt. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  renders = 0;
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the document cache and initialTheme (#978)", () => {
  it("an entry a dark visitor warmed serves the no-cookie default", async () => {
    const { serve } = setup();

    const dark = await serve("/stored", "dark");
    const anonymous = await serve("/stored", null);
    const light = await serve("/stored", "light");

    expect(dark.status).toBe("MISS");
    expect(dark.body).toContain(theme("system"));
    for (const hit of [anonymous, light]) {
      expect(hit.status).toBe("HIT");
      expect(hit.body).toContain(theme("system"));
      expect(hit.body).not.toContain(theme("dark"));
    }
  });

  it("a stale refresh a dark visitor triggers stores the no-cookie default", async () => {
    const { serve } = setup();

    await serve("/early", null);
    await tick();
    const stale = await serve("/early", "dark");
    await tick();
    const refreshed = await serve("/early", null);

    expect(stale.status).toBe("STALE");
    expect(stale.body).toContain("render-1");
    // The dark visitor's background refresh wrote render-2.
    expect(refreshed.status).toBe("STALE");
    expect(refreshed.body).toContain("render-2");
    expect(refreshed.body).toContain(theme("system"));
    expect(refreshed.body).not.toContain(theme("dark"));
  });

  it("a response that has not opted in keeps the visitor's theme", async () => {
    const { serve } = setup();

    const dark = await serve("/plain", "dark");
    const light = await serve("/plain", "light");

    expect(dark.status).toBeNull();
    expect(dark.body).toContain(theme("dark"));
    expect(light.status).toBeNull();
    expect(light.body).toContain(theme("light"));
  });

  it("a 404 on a URL middleware opted in keeps the visitor's theme", async () => {
    const { serve } = setup();

    const dark = await serve("/early/missing", "dark");
    const again = await serve("/early/missing", "dark");

    expect(dark.code).toBe(404);
    expect(dark.status).toBeNull();
    expect(dark.body).toContain(theme("dark"));
    expect(dark.body).not.toContain(theme("system"));
    expect(again.status).toBeNull();
  });

  it("a Cache-Control written after the render stores only a default-theme render", async () => {
    const { serve } = setup();

    const dark = await serve("/late", "dark");
    const darkAgain = await serve("/late", "dark");
    const anonymous = await serve("/late", null);
    const hit = await serve("/late", "dark");

    // The dark renders carry the visitor's theme: neither is stored.
    expect(dark.body).toContain(theme("dark"));
    expect(darkAgain.status).not.toBe("HIT");
    expect(darkAgain.body).toContain(theme("dark"));
    expect(anonymous.status).toBe("MISS");
    expect(anonymous.body).toContain(theme("system"));
    expect(hit.status).toBe("HIT");
    expect(hit.body).toContain(theme("system"));
    expect(hit.body).not.toContain(theme("dark"));
  });
});
