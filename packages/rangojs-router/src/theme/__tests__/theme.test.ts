import { describe, it, expect, vi } from "vitest";
import {
  resolveThemeConfig,
  THEME_DEFAULTS,
  THEME_COOKIE,
} from "../constants.js";
import { generateThemeScript } from "../theme-script.js";
import type { ThemeConfig, ResolvedThemeConfig } from "../types.js";

describe("Theme Configuration", () => {
  describe("resolveThemeConfig", () => {
    it("should apply defaults when no config provided", () => {
      const config: ThemeConfig = {};
      const resolved = resolveThemeConfig(config);

      expect(resolved.defaultTheme).toBe(THEME_DEFAULTS.defaultTheme);
      expect(resolved.themes).toEqual(THEME_DEFAULTS.themes);
      expect(resolved.attribute).toBe(THEME_DEFAULTS.attribute);
      expect(resolved.storageKey).toBe(THEME_DEFAULTS.storageKey);
      expect(resolved.enableSystem).toBe(THEME_DEFAULTS.enableSystem);
      expect(resolved.enableColorScheme).toBe(THEME_DEFAULTS.enableColorScheme);
    });

    it("should preserve custom config values", () => {
      const config: ThemeConfig = {
        defaultTheme: "dark",
        themes: ["light", "dark", "sepia"],
        attribute: "data-theme",
        storageKey: "app-theme",
        enableSystem: false,
        enableColorScheme: false,
      };
      const resolved = resolveThemeConfig(config);

      expect(resolved.defaultTheme).toBe("dark");
      expect(resolved.themes).toEqual(["light", "dark", "sepia"]);
      expect(resolved.attribute).toBe("data-theme");
      expect(resolved.storageKey).toBe("app-theme");
      expect(resolved.enableSystem).toBe(false);
      expect(resolved.enableColorScheme).toBe(false);
    });

    it("should generate value mapping for themes", () => {
      const config: ThemeConfig = {
        themes: ["light", "dark"],
      };
      const resolved = resolveThemeConfig(config);

      expect(resolved.value).toEqual({
        light: "light",
        dark: "dark",
      });
    });

    it("should use custom value mapping when provided", () => {
      const config: ThemeConfig = {
        themes: ["light", "dark"],
        value: {
          light: "light-mode",
          dark: "dark-mode",
        },
      };
      const resolved = resolveThemeConfig(config);

      expect(resolved.value).toEqual({
        light: "light-mode",
        dark: "dark-mode",
      });
    });

    // G1: with system detection disabled, "system" is not a resolvable theme,
    // so resolveThemeConfig must NOT keep defaultTheme:"system" (which would
    // apply a bogus class="system" / colorScheme="system" on <html>).
    it("coerces defaultTheme away from 'system' when enableSystem is false", () => {
      const resolved = resolveThemeConfig({ enableSystem: false });
      expect(resolved.enableSystem).toBe(false);
      expect(resolved.defaultTheme).not.toBe("system");
      expect(resolved.themes).toContain(resolved.defaultTheme);
      expect(resolved.defaultTheme).toBe(resolved.themes[0]);
    });

    it("downgrades an explicit defaultTheme:'system' to themes[0] when enableSystem is false", () => {
      const resolved = resolveThemeConfig({
        enableSystem: false,
        defaultTheme: "system",
        themes: ["sepia", "midnight"],
      });
      expect(resolved.defaultTheme).toBe("sepia");
    });

    it("keeps defaultTheme:'system' when enableSystem is true (default)", () => {
      const resolved = resolveThemeConfig({});
      expect(resolved.enableSystem).toBe(true);
      expect(resolved.defaultTheme).toBe("system");
    });

    it("keeps an explicit concrete defaultTheme even when enableSystem is false", () => {
      const resolved = resolveThemeConfig({
        enableSystem: false,
        defaultTheme: "dark",
      });
      expect(resolved.defaultTheme).toBe("dark");
    });
  });

  describe("THEME_COOKIE", () => {
    it("should have correct defaults", () => {
      expect(THEME_COOKIE.maxAge).toBe(60 * 60 * 24 * 365);
      expect(THEME_COOKIE.path).toBe("/");
      expect(THEME_COOKIE.sameSite).toBe("lax");
    });
  });
});

describe("theme cookie decode resilience", () => {
  it("inline script contains guarded decodeURIComponent", () => {
    const config: ResolvedThemeConfig = {
      defaultTheme: "light",
      themes: ["light", "dark"],
      attribute: "class",
      storageKey: "theme",
      enableSystem: false,
      enableColorScheme: false,
      value: { light: "light", dark: "dark" },
    };

    const script = generateThemeScript(config);

    // The generated script must wrap decodeURIComponent in try/catch
    expect(script).toContain("try");
    expect(script).toContain("catch");
    expect(script).toContain("decodeURIComponent");
  });

  it("inline script falls back to default with malformed cookie", () => {
    const config: ResolvedThemeConfig = {
      defaultTheme: "light",
      themes: ["light", "dark"],
      attribute: "data-theme",
      storageKey: "theme",
      enableSystem: false,
      enableColorScheme: false,
      value: { light: "light", dark: "dark" },
    };

    const script = generateThemeScript(config);

    // Evaluate the script with a malformed cookie — should not throw
    // and should fall back to defaultTheme ("light")
    const mockEl = {
      setAttribute: vi.fn(),
      classList: { remove: vi.fn(), add: vi.fn() },
      style: {},
    };

    const fn = new Function("document", "window", "localStorage", script);
    expect(() =>
      fn(
        {
          cookie: "theme=%zz",
          documentElement: mockEl,
        },
        { matchMedia: undefined },
        { getItem: () => null },
      ),
    ).not.toThrow();

    // Should have applied the default theme "light"
    expect(mockEl.setAttribute).toHaveBeenCalledWith("data-theme", "light");
  });
});

// G5: MetaTags auto-injects this FOUC script and ThemeScript is a public
// component for the same job. A consumer rendering both runs the IIFE twice.
// The script must guard the matchMedia('change') listener so a second run does
// not register a second, never-removed listener (a leak).
describe("theme script matchMedia listener idempotency", () => {
  function runScriptTwice(storageKey: string): number {
    const config: ResolvedThemeConfig = {
      defaultTheme: "system",
      themes: ["light", "dark"],
      attribute: "class",
      storageKey,
      enableSystem: true,
      enableColorScheme: true,
      value: { light: "light", dark: "dark" },
    };
    const script = generateThemeScript(config);

    let listeners = 0;
    const mql = {
      matches: false,
      addEventListener: () => {
        listeners++;
      },
    };
    // A single shared window so the guard flag persists across both runs,
    // mirroring two <script> tags executing in one document.
    const win: Record<string, unknown> = { matchMedia: () => mql };
    const doc = {
      cookie: "",
      documentElement: {
        classList: { remove: () => {}, add: () => {} },
        setAttribute: () => {},
        style: {},
      },
    };
    const ls = { getItem: () => null };

    const fn = new Function("document", "window", "localStorage", script);
    fn(doc, win, ls);
    fn(doc, win, ls);
    return listeners;
  }

  it("registers the matchMedia change listener only ONCE across two injections", () => {
    expect(runScriptTwice("theme")).toBe(1);
  });

  it("isolates the guard flag per storageKey", () => {
    // Two independent theme configs (different storageKey) must each register
    // their own listener; the guard must not cross-suppress them.
    expect(runScriptTwice("theme-a")).toBe(1);
    expect(runScriptTwice("theme-b")).toBe(1);
  });
});

describe("Theme Script", () => {
  describe("generateThemeScript", () => {
    it("should generate a minified script", () => {
      const config: ResolvedThemeConfig = {
        defaultTheme: "system",
        themes: ["light", "dark"],
        attribute: "class",
        storageKey: "theme",
        enableSystem: true,
        enableColorScheme: true,
        value: { light: "light", dark: "dark" },
      };

      const script = generateThemeScript(config);

      // Should be a string
      expect(typeof script).toBe("string");

      // Should not have multi-line formatting (minified)
      expect(script.includes("\n  ")).toBe(false);

      // Should contain key configuration values
      expect(script.includes('"theme"')).toBe(true);
      expect(script.includes('"system"')).toBe(true);
      expect(script.includes('"class"')).toBe(true);
    });

    it("should handle data-* attributes", () => {
      const config: ResolvedThemeConfig = {
        defaultTheme: "light",
        themes: ["light", "dark"],
        attribute: "data-theme",
        storageKey: "theme",
        enableSystem: true,
        enableColorScheme: true,
        value: { light: "light", dark: "dark" },
      };

      const script = generateThemeScript(config);

      expect(script.includes('"data-theme"')).toBe(true);
    });
  });
});
