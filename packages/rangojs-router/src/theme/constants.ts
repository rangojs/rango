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

/**
 * Single owner of the setTheme validity rule, shared by the client
 * (ThemeProvider) and server (ctx.setTheme) guards so they cannot drift.
 *
 * A theme is valid when it is one of the configured concrete themes, OR
 * "system" but only while system detection is enabled. Rejecting "system" when
 * `enableSystem` is false is load-bearing: applyThemeToDocument would otherwise
 * leave "system" unresolved and write a bogus class="system" / colorScheme
 * ="system" on <html> (the same bogus value resolveThemeConfig coerces away for
 * the default).
 */
export function isValidTheme(
  theme: string,
  config: Pick<ResolvedThemeConfig, "themes" | "enableSystem">,
): boolean {
  if (theme === "system") return config.enableSystem;
  return config.themes.includes(theme);
}

/**
 * Emit the shared "[Theme] Invalid theme value" warning. One owner of the
 * message string so the client and server guards stay byte-identical.
 *
 * The valid-values list mirrors isValidTheme: "system" is only listed when
 * enableSystem is true, otherwise the message would advertise a value the guard
 * itself rejects.
 */
export function warnInvalidTheme(
  theme: string,
  config: Pick<ResolvedThemeConfig, "themes" | "enableSystem">,
): void {
  const validValues = config.enableSystem
    ? ["system", ...config.themes]
    : config.themes;
  console.warn(
    `[Theme] Invalid theme value: "${theme}". Valid values: ${validValues.join(", ")}`,
  );
}

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
