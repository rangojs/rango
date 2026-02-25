import { describe, it, expect } from "vitest";
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
  });

  describe("THEME_COOKIE", () => {
    it("should have correct defaults", () => {
      expect(THEME_COOKIE.maxAge).toBe(60 * 60 * 24 * 365);
      expect(THEME_COOKIE.path).toBe("/");
      expect(THEME_COOKIE.sameSite).toBe("lax");
    });
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
