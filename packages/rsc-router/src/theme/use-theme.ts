"use client";

/**
 * useTheme - Hook for accessing theme state in client components.
 *
 * @example
 * ```tsx
 * import { useTheme } from "@ivogt/rsc-router/theme";
 *
 * function ThemeToggle() {
 *   const { theme, setTheme, resolvedTheme, themes } = useTheme();
 *
 *   return (
 *     <select value={theme} onChange={e => setTheme(e.target.value)}>
 *       {themes.map(t => <option key={t}>{t}</option>)}
 *     </select>
 *   );
 * }
 * ```
 */

import { requireThemeContext } from "./theme-context.js";
import type { UseThemeReturn } from "./types.js";

/**
 * Hook to access theme state and methods.
 *
 * Must be used within a ThemeProvider (which is automatically included
 * in NavigationProvider when theme is enabled in router config).
 *
 * @returns Theme state and methods
 * @throws Error if used outside ThemeProvider
 */
export function useTheme(): UseThemeReturn {
  const ctx = requireThemeContext();

  return {
    theme: ctx.theme,
    setTheme: ctx.setTheme,
    resolvedTheme: ctx.resolvedTheme,
    systemTheme: ctx.systemTheme,
    themes: ctx.themes,
  };
}
