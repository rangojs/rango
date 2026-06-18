// @vitest-environment happy-dom

/**
 * G2: the client setTheme (ThemeProvider) must reject the SAME inputs the
 * server ctx.setTheme rejects (request-context.ts). Without this guard the
 * client could write a cookie value the server reinterprets as defaultTheme on
 * the next SSR, desyncing the SSR markup from the applied class (FOUC + a
 * hydration-state mismatch). These tests drive the public ThemeProvider through
 * @testing-library/react, calling setTheme via the context the same way a
 * consumer component would.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { useContext } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { ThemeProvider } from "../ThemeProvider.js";
import { ThemeContext } from "../theme-context.js";
import { resolveThemeConfig } from "../constants.js";
import type { Theme, ThemeContextValue } from "../types.js";

afterEach(() => {
  cleanup();
  document.cookie = "theme=; Path=/; Max-Age=0";
  vi.restoreAllMocks();
});

function renderProvider(): { ctx: ThemeContextValue } {
  const config = resolveThemeConfig({ themes: ["light", "dark"] });
  const captured: { ctx?: ThemeContextValue } = {};

  function Capture() {
    captured.ctx = useContext(ThemeContext)!;
    return null;
  }

  render(
    <ThemeProvider config={config} initialTheme="light">
      <Capture />
    </ThemeProvider>,
  );

  return { ctx: captured.ctx! };
}

function readCookieTheme(): string | null {
  for (const c of document.cookie.split(";")) {
    const [k, ...rest] = c.trim().split("=");
    if (k === "theme") return decodeURIComponent(rest.join("="));
  }
  return null;
}

describe("client setTheme validation (mirrors server ctx.setTheme)", () => {
  it("accepts a configured theme and writes the cookie", () => {
    const { ctx } = renderProvider();
    act(() => ctx.setTheme("dark"));
    expect(ctx).toBeTruthy();
    expect(readCookieTheme()).toBe("dark");
  });

  it("rejects a theme not in the configured set (no cookie write, warns)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx } = renderProvider();

    act(() => ctx.setTheme("dark"));
    expect(readCookieTheme()).toBe("dark");

    act(() => ctx.setTheme("purple" as Theme));

    // The bogus value must NOT be written to the cookie; the prior valid theme
    // remains, exactly like the server's setTheme (which skips Set-Cookie).
    expect(readCookieTheme()).toBe("dark");
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("purple"))).toBe(
      true,
    );
  });

  it("still accepts 'system' as a special value", () => {
    const { ctx } = renderProvider();
    act(() => ctx.setTheme("system"));
    expect(readCookieTheme()).toBe("system");
  });
});
