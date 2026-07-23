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
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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

function renderProvider(overrides?: { enableSystem?: boolean }): {
  ctx: ThemeContextValue;
} {
  const config = resolveThemeConfig({
    themes: ["light", "dark"],
    ...(overrides?.enableSystem !== undefined
      ? { enableSystem: overrides.enableSystem }
      : {}),
  });
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

  it("rejects 'system' when enableSystem is false (no cookie, warns)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx } = renderProvider({ enableSystem: false });

    // Seed a concrete theme so we can prove the bogus "system" write is skipped.
    act(() => ctx.setTheme("dark"));
    expect(readCookieTheme()).toBe("dark");

    act(() => ctx.setTheme("system"));

    // "system" must NOT reach the cookie when system detection is off — otherwise
    // the next SSR re-applies a bogus class="system" on <html>.
    expect(readCookieTheme()).toBe("dark");
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("system"))).toBe(
      true,
    );
    expect(document.documentElement.className).not.toContain("system");
  });
});

// P3: a cross-tab `storage` event can carry any value (another tab, or stale
// localStorage). The storage handler must apply the SAME validity rule as
// setTheme — a received "system" with enableSystem=false must fall back to
// defaultTheme, never apply class="system"/colorScheme="system".
describe("cross-tab storage handler validity (enableSystem:false)", () => {
  function dispatchStorage(newValue: string | null): void {
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "theme", newValue }),
      );
    });
  }

  it("coerces a cross-tab 'system' to defaultTheme when enableSystem is false", () => {
    renderProvider({ enableSystem: false });
    // defaultTheme is the first concrete theme ("light") when system is off.
    dispatchStorage("system");
    expect(document.documentElement.className).not.toContain("system");
    expect(document.documentElement.style.colorScheme).not.toBe("system");
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("applies a valid cross-tab concrete theme as-is", () => {
    renderProvider({ enableSystem: false });
    dispatchStorage("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("coerces an unknown cross-tab value to defaultTheme", () => {
    renderProvider({ enableSystem: false });
    dispatchStorage("purple");
    expect(document.documentElement.classList.contains("purple")).toBe(false);
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
});

describe("post-mount cookie re-sync (PPR shell HIT theme fidelity)", () => {
  beforeEach(() => {
    // The G2 suite's setTheme calls persist to localStorage and afterEach only
    // clears the cookie; the mount re-sync would read that leak.
    localStorage.clear();
    document.documentElement.className = "";
  });

  it("re-syncs state and document from the stored cookie when initialTheme differs", () => {
    // A PPR shell HIT deliberately hydrates with the CAPTURE's initialTheme
    // (the resume tree must match the frozen prelude). The visitor's real
    // theme lives in the cookie; the provider must converge to it after mount.
    document.cookie = "theme=dark; Path=/";
    const { ctx } = renderProvider();
    expect(ctx.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("keeps initialTheme when no stored theme exists", () => {
    const { ctx } = renderProvider();
    expect(ctx.theme).toBe("light");
  });
});

// HYDRATION PARITY: the initializer is both the server (SSR/resume) render and
// the client's hydration render — it must NEVER read cookie/localStorage. The
// server renders with the payload's initialTheme (on a PPR shell HIT that is
// the CAPTURE's theme, possibly undefined); if the client initializer read the
// visitor's stored theme instead, any raw-theme text (a toggle label) would
// mismatch, hydration would fail, and React's client regeneration would wipe
// the FOUC-applied class from <html>. This suite pins the first-render value.
describe("initializer hydration parity (never reads storage)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
  });

  function renderRecordingFirstTheme(initialTheme?: Theme): {
    first: Theme;
    ctx: ThemeContextValue;
  } {
    const config = resolveThemeConfig({
      themes: ["light", "dark"],
      defaultTheme: "light",
    });
    const seen: Theme[] = [];
    const captured: { ctx?: ThemeContextValue } = {};

    function Capture() {
      const ctx = useContext(ThemeContext)!;
      seen.push(ctx.theme);
      captured.ctx = ctx;
      return null;
    }

    render(
      <ThemeProvider config={config} initialTheme={initialTheme}>
        <Capture />
      </ThemeProvider>,
    );

    return { first: seen[0], ctx: captured.ctx! };
  }

  it("first render is defaultTheme when initialTheme is absent, even with a stored dark cookie (PPR HIT shape)", () => {
    document.cookie = "theme=dark; Path=/";
    const { first, ctx } = renderRecordingFirstTheme(undefined);
    // Server parity: the resume tree rendered defaultTheme; the client's first
    // render must match it, NOT the cookie.
    expect(first).toBe("light");
    // The post-mount re-sync then converges to the visitor's stored theme.
    expect(ctx.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("first render is initialTheme when provided, even with a conflicting stored cookie", () => {
    document.cookie = "theme=dark; Path=/";
    const { first, ctx } = renderRecordingFirstTheme("light");
    expect(first).toBe("light");
    expect(ctx.theme).toBe("dark");
  });

  it("first render ignores localStorage too", () => {
    localStorage.setItem("theme", "dark");
    const { first, ctx } = renderRecordingFirstTheme(undefined);
    expect(first).toBe("light");
    expect(ctx.theme).toBe("dark");
  });
});
