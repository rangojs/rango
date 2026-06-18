/**
 * Default values for theme configuration
 */

import type { ResolvedThemeConfig, Theme, ThemeConfig } from "./types.js";

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

  const enableSystem = config.enableSystem ?? THEME_DEFAULTS.enableSystem;

  // When system detection is disabled, "system" is not a valid resolved theme.
  // Coerce both the unset default and an explicit defaultTheme:"system" to the
  // first concrete theme, so the FOUC script / ThemeProvider never apply a bogus
  // class="system" / colorScheme="system" on <html>.
  const requestedDefault = config.defaultTheme ?? THEME_DEFAULTS.defaultTheme;
  const defaultTheme =
    !enableSystem && requestedDefault === "system"
      ? (themes[0] as Theme)
      : requestedDefault;

  return {
    defaultTheme,
    themes,
    attribute: config.attribute ?? THEME_DEFAULTS.attribute,
    storageKey: config.storageKey ?? THEME_DEFAULTS.storageKey,
    enableSystem,
    enableColorScheme:
      config.enableColorScheme ?? THEME_DEFAULTS.enableColorScheme,
    value,
  };
}
