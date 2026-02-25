/**
 * Default values for theme configuration
 */

import type { ResolvedThemeConfig, ThemeConfig } from "./types.js";

/**
 * Default theme configuration values
 */
export const THEME_DEFAULTS = {
  defaultTheme: "system",
  themes: ["light", "dark"],
  attribute: "class",
  storageKey: "theme",
  enableSystem: true,
  enableColorScheme: true,
} as const;

/**
 * Cookie configuration for theme persistence
 */
export const THEME_COOKIE: {
  readonly maxAge: number;
  readonly path: string;
  readonly sameSite: "lax";
} = {
  maxAge: 60 * 60 * 24 * 365, // 1 year
  path: "/",
  sameSite: "lax",
};

/**
 * Resolve theme config by applying defaults.
 * Accepts `true` to enable with all defaults, or a config object.
 */
export function resolveThemeConfig(
  config: ThemeConfig | true,
): ResolvedThemeConfig {
  // Handle `theme: true` shorthand
  if (config === true) {
    config = {};
  }

  const themes = config.themes ?? [...THEME_DEFAULTS.themes];

  // Build value mapping - default to identity mapping
  const value: Record<string, string> = {};
  for (const theme of themes) {
    value[theme] = config.value?.[theme] ?? theme;
  }

  return {
    defaultTheme: config.defaultTheme ?? THEME_DEFAULTS.defaultTheme,
    themes,
    attribute: config.attribute ?? THEME_DEFAULTS.attribute,
    storageKey: config.storageKey ?? THEME_DEFAULTS.storageKey,
    enableSystem: config.enableSystem ?? THEME_DEFAULTS.enableSystem,
    enableColorScheme:
      config.enableColorScheme ?? THEME_DEFAULTS.enableColorScheme,
    value,
  };
}
