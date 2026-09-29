/**
 * #971: the visitor's theme (a handler's or middleware's ctx.theme,
 * getRequestContext().theme) is the theme cookie, so a route that shares its
 * render across visitors must not read it. Served through the public
 * serveShellRequest: a `ppr` route's capture refuses and the route stays on
 * MISS, a `cache()` route's miss fails like a cookies() read, and a read in a
 * `"use cache"` function throws. A route that shares nothing, and a live
 * loader on a `ppr` route, keep reading the visitor's theme; a shell's
 * initialTheme is the no-cookie default, whoever captured it. The `cache()`
 * route is served through serveShellRequest too: renderRoute renders the
 * client tree only, and dispatch refuses component routes, so neither runs a
 * handler's ctx.theme.
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

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
} from "../flight.entry.js";
import {
  cookies,
  createLoader,
  createRouter,
  getRequestContext,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import {
  cachedCtxTheme,
  cachedRequestTheme,
} from "./fixtures/theme-read-data.js";

function ThemePage(ctx: HandlerContext): React.ReactNode {
  return <p>{`theme-is-${ctx.theme}`}</p>;
}

function RequestThemePage(): React.ReactNode {
  return <p>{`rc-theme-is-${getRequestContext().theme}`}</p>;
}

async function UseCacheThemePage(): Promise<React.ReactNode> {
  return <p>{await cachedRequestTheme()}</p>;
}

function CookiesPage(): React.ReactNode {
  return <p>{`cookie-is-${cookies().get("theme")?.value}`}</p>;
}

function DynamicThemePage(ctx: HandlerContext): React.ReactNode {
  ctx.dynamic();
  return <p>{`theme-is-${ctx.theme}`}</p>;
}

function SetThemePage(ctx: HandlerContext): React.ReactNode {
  ctx.setTheme?.("light");
  return <p>set</p>;
}

function SetCookiePage(): React.ReactNode {
  cookies().set("theme", "light");
  return <p>set</p>;
}

const LiveThemeLoader = createLoader(async () => ({
  theme: `loader-theme-is-${cookies().get("theme")?.value}`,
}));

function makeRouter(onError?: (error: unknown) => void) {
  return createRouter({
    theme: true,
    onError: onError ? (context) => onError(context.error) : undefined,
  })
    .use(async (ctx, next) => {
      // Middleware ctx.theme: a direct read, and a read inside a "use cache"
      // function on /mw-use-cache.
      ctx.header("x-mw-theme", `mw-theme-is-${ctx.theme}`);
      if (ctx.url.pathname === "/mw-use-cache") {
        ctx.header("x-mw-cached-theme", await cachedCtxTheme(ctx));
      }
      await next();
    })
    .routes(
      urls(({ path, cache, loader, loading }) => [
        path("/ppr-theme", ThemePage, { name: "pprTheme", ppr: true }),
        path("/ppr-rc-theme", RequestThemePage, {
          name: "pprRcTheme",
          ppr: true,
        }),
        path("/ppr-cookies", CookiesPage, { name: "pprCookies", ppr: true }),
        path("/ppr-dynamic", DynamicThemePage, {
          name: "pprDynamic",
          ppr: true,
        }),
        path("/ppr-set-theme", SetThemePage, {
          name: "pprSetTheme",
          ppr: true,
        }),
        path("/ppr-set-cookie", SetCookiePage, {
          name: "pprSetCookie",
          ppr: true,
        }),
        path(
          "/ppr-loader",
          () => <p>shell</p>,
          { name: "pprLoader", ppr: true },
          () => [loader(LiveThemeLoader), loading(<p>loading theme</p>)],
        ),
        cache({ ttl: 300 }, () => [
          path("/cached-theme", ThemePage, { name: "cachedTheme" }),
          path("/cached-rc-theme", RequestThemePage, {
            name: "cachedRcTheme",
          }),
          path("/cached-cookies", CookiesPage, { name: "cachedCookies" }),
          path("/cached-set-theme", SetThemePage, { name: "cachedSetTheme" }),
          path("/cached-set-cookie", SetCookiePage, {
            name: "cachedSetCookie",
          }),
        ]),
        path("/use-cache-rc-theme", UseCacheThemePage, {
          name: "useCacheRcTheme",
        }),
        path("/mw-use-cache", () => <p>mw</p>, { name: "mwUseCache" }),
        path("/plain-theme", ThemePage, { name: "plainTheme" }),
        path("/plain-rc-theme", RequestThemePage, { name: "plainRcTheme" }),
      ]),
    );
}

function setup(onError?: (error: unknown) => void) {
  const router = makeRouter(onError);
  const cacheStore = new MemorySegmentCacheStore();
  /** One request; `theme` null sends no theme cookie. */
  const serve = (
    url: string,
    theme: string | null,
    extra: Omit<ServeShellRequestOptions, "cacheStore" | "headers"> = {},
  ) =>
    serveShellRequest(router, url, {
      cacheStore,
      headers: theme === null ? {} : { cookie: `theme=${theme}` },
      ...extra,
    });
  return { serve };
}

function refusalWarnings(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls
    .map((call: unknown[]) => call[0])
    .filter(
      (m: unknown): m is string =>
        typeof m === "string" && m.includes("was refused"),
    );
}

/** Collect onError errors' messages; console.error muted. */
function collectErrors() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const errors: unknown[] = [];
  const messages = () => errors.map((e) => (e as Error).message);
  return { onError: (error: unknown) => errors.push(error), messages };
}

beforeEach(async () => {
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The two public theme reads a handler can make: [surface, route, prefix]. */
const HANDLER_READS: Array<[string, string, string]> = [
  ["ctx.theme", "theme", "theme-is-"],
  ["getRequestContext().theme", "rc-theme", "rc-theme-is-"],
];

describe("the visitor's theme on a ppr route (#971)", () => {
  it.each(HANDLER_READS)(
    "%s refuses the capture, so no visitor gets a HIT with another visitor's theme",
    async (surface, route, prefix) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { serve } = setup();

      const dark = await serve(`/ppr-${route}`, "dark");
      const light = await serve(`/ppr-${route}`, "light");

      expect(light.prelude ?? "").not.toContain(`${prefix}dark`);
      expect(light.shellStatus).toBe("MISS");
      expect(light.flight).toContain(`${prefix}light`);
      expect(dark.shellStatus).toBe("MISS");
      expect(dark.flight).toContain(`${prefix}dark`);
      expect(await dark.readEntry()).toBeNull();
      const refused = refusalWarnings(warn);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain(`read ${surface} during capture`);
      expect(refused[0]).toContain("useTheme()");
    },
  );

  it("refuses the same way a cookies() read does", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = setup();

    await serve("/ppr-cookies", "dark");
    const light = await serve("/ppr-cookies", "light");

    expect(light.shellStatus).toBe("MISS");
    expect(light.flight).toContain("cookie-is-light");
    const refused = refusalWarnings(warn);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("read cookies() during capture");
    expect(refused[0]).toContain("a loader without ssr: false");
  });

  it("a live loader reads the visitor's theme on every request, HIT included", async () => {
    const { serve } = setup();

    await serve("/ppr-loader", "dark");
    const hit = await serve("/ppr-loader", "light");

    expect(hit.shellStatus).toBe("HIT");
    expect(hit.prelude).not.toContain("loader-theme-is-");
    expect(hit.flight).toContain("loader-theme-is-light");
  });

  it("a shell captured by a dark visitor carries the no-cookie default as initialTheme", async () => {
    const { serve } = setup();

    await serve("/ppr-loader", "dark");
    const anonymous = await serve("/ppr-loader", null);
    const light = await serve("/ppr-loader", "light");

    // theme: true defaults to "system"; ThemeProvider re-syncs a visitor's
    // stored theme after mount (the e2e pins the useTheme() output).
    expect((await anonymous.readEntry())?.initialTheme).toBe("system");
    for (const hit of [anonymous, light]) {
      expect(hit.shellStatus).toBe("HIT");
      expect(hit.prelude).toContain('"initialTheme":"system"');
      expect(hit.flight).toContain('"initialTheme":"system"');
      expect(`${hit.prelude}${hit.flight}`).not.toContain(
        '"initialTheme":"dark"',
      );
    }
  });

  it("after ctx.dynamic() the handler reads each visitor's theme and nothing is captured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = setup();

    const dark = await serve("/ppr-dynamic", "dark");
    const light = await serve("/ppr-dynamic", "light");

    expect(dark.flight).toContain("theme-is-dark");
    expect(light.flight).toContain("theme-is-light");
    expect(light.shellStatus).not.toBe("HIT");
    expect(await light.readEntry()).toBeNull();
    expect(refusalWarnings(warn)).toEqual([]);
  });
});

describe("ctx.setTheme on ppr and cache() routes (#971)", () => {
  it.each([
    ["a ppr route", "/ppr-set-theme", "/ppr-set-cookie"],
    ["a cache() route", "/cached-set-theme", "/cached-set-cookie"],
  ])(
    "on %s it fails like cookies().set and sets no cookie",
    async (_label, setTheme, setCookie) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { serve } = setup();

      const theme = await serve(setTheme, "dark");
      const cookie = await serve(setCookie, "dark");

      expect(cookie.response.status).toBe(500);
      expect(theme.response.status).toBe(500);
      expect(theme.response.headers.get("set-cookie") ?? "").not.toContain(
        "theme=light",
      );
    },
  );
});

describe('the visitor\'s theme in cache() and "use cache" (#971)', () => {
  it.each(HANDLER_READS)(
    "%s in a cache() miss fails like a cookies() read, and nothing is stored for the next visitor",
    async (surface, route, prefix) => {
      const { onError, messages } = collectErrors();
      const { serve } = setup(onError);

      const dark = await serve(`/cached-${route}`, "dark");
      const light = await serve(`/cached-${route}`, "light");
      const control = await serve("/cached-cookies", "dark");

      expect(
        [dark, light, control].map((served) => served.response.status),
      ).toEqual([500, 500, 500]);
      expect(light.body).not.toContain(`${prefix}dark`);
      expect(messages()).toContainEqual(
        expect.stringContaining(
          `${surface} cannot be read inside a cache() boundary`,
        ),
      );
      expect(messages()).toContainEqual(expect.stringContaining("useTheme()"));
    },
  );

  it('getRequestContext().theme in a "use cache" function throws instead of caching the first visitor\'s theme', async () => {
    const { onError, messages } = collectErrors();
    const { serve } = setup(onError);

    const dark = await serve("/use-cache-rc-theme", "dark");
    const light = await serve("/use-cache-rc-theme", "light");

    expect([dark, light].map((served) => served.response.status)).toEqual([
      500, 500,
    ]);
    expect(light.body).not.toContain("uc-rc-theme-is-dark");
    expect(messages()).toContainEqual(
      expect.stringContaining(
        'getRequestContext().theme cannot be read inside a "use cache" function',
      ),
    );
  });

  it('middleware ctx.theme in a "use cache" function throws; a direct read is the visitor\'s', async () => {
    const { serve } = setup();

    // The middleware error propagates out of the request, as a throwing
    // cookies() read there does.
    for (const theme of ["dark", "light"]) {
      await expect(serve("/mw-use-cache", theme)).rejects.toThrow(
        'ctx.theme cannot be read inside a "use cache" function',
      );
    }
    const direct = await serve("/plain-theme", "light");
    expect(direct.response.headers.get("x-mw-theme")).toBe("mw-theme-is-light");
  });

  it.each(HANDLER_READS)(
    "%s outside cache() and ppr reads each visitor's theme",
    async (_surface, route, prefix) => {
      const { serve } = setup();

      const dark = await serve(`/plain-${route}`, "dark");
      const light = await serve(`/plain-${route}`, "light");

      expect(dark.flight).toContain(`${prefix}dark`);
      expect(light.flight).toContain(`${prefix}light`);
    },
  );
});
