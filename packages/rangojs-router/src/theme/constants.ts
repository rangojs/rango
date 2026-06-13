/**
 * Default values for theme configuration
 */

import type { ResolvedThemeConfig, ThemeConfig } from "./types.js";

export const THEME_DEFAULTS = {
  defaultTheme: "system",
  themes: ["light", "dark"],
  attribute: "class",
  storageKey: "theme",
  enableSystem: true,
  enableColorScheme: true,
} as const;

export const THEME_COOKIE: {
  readonly maxAge: number;
  readonly path: string;
  readonly sameSite: "lax";
} = {
  maxAge: 60 * 60 * 24 * 365, // 1 year
  path: "/",
  sameSite: "lax",
};

export function resolveThemeConfig(
  config: ThemeConfig | true,
): ResolvedThemeConfig {
  if (config === true) {
    config = {};
  }

  const themes = config.themes ?? [...THEME_DEFAULTS.themes];

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
