/**
 * Dogfood coverage for ctx.theme / ctx.setTheme through the public testing
 * primitives. These are documented HandlerContext and MiddlewareContext
 * members (not LoaderContext — the loader ctx has no theme), but were
 * previously unexercised by any primitive test.
 *
 * This file covers the MiddlewareContext path via runMiddleware. The
 * HandlerContext path (renderHandler) needs the react-server condition, so it
 * lives in render-handler.rsc-test.tsx.
 *
 * The default theme storageKey is "theme" (see THEME_DEFAULTS), so a
 * setTheme("dark") must produce cookies.theme === "dark".
 */
import { describe, it, expect } from "vitest";
import { runMiddleware } from "../run-middleware.js";
import type { MiddlewareFn } from "../../router/middleware.js";

describe("ctx.theme / ctx.setTheme via runMiddleware", () => {
  it("ctx.setTheme writes the theme cookie into the run snapshot", async () => {
    const mw: MiddlewareFn = async (ctx, next) => {
      // Read the current theme, then set a new one.
      expect(ctx.theme).toBe("system");
      ctx.setTheme?.("dark");
      return next();
    };
    const { cookies, response } = await runMiddleware(mw, {
      request: "/dashboard",
      theme: true,
    });
    expect(cookies.theme).toBe("dark");
    expect(
      response.headers.getSetCookie().some((c) => c.startsWith("theme=dark")),
    ).toBe(true);
  });

  it("ctx.theme reflects an incoming theme cookie", async () => {
    const mw: MiddlewareFn = async (ctx, next) => {
      expect(ctx.theme).toBe("dark");
      return next();
    };
    await runMiddleware(mw, {
      request: new Request("http://localhost/dashboard", {
        headers: { Cookie: "theme=dark" },
      }),
      theme: true,
    });
  });

  it("ctx.setTheme is inert without the theme option", async () => {
    let hadSetter = true;
    const mw: MiddlewareFn = async (ctx, next) => {
      hadSetter = typeof ctx.setTheme === "function";
      ctx.setTheme?.("dark");
      return next();
    };
    const { cookies } = await runMiddleware(mw, {
      request: "/dashboard",
    });
    expect(hadSetter).toBe(false);
    expect(cookies.theme).toBeUndefined();
  });
});
