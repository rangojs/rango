/**
 * Theme module exports for @rangojs/router/theme
 *
 * This module provides the public theme API:
 * - useTheme: Hook for accessing theme state in client components
 * - ThemeProvider: Component for manual theme provider setup (typically not needed)
 * - ThemeScript: FOUC-prevention script component for document/head usage
 * - Types for theme configuration
 *
 * @example
 * ```tsx
 * // In a client component
 * import { useTheme } from "@rangojs/router/theme";
 *
 * function ThemeToggle() {
 *   const { theme, setTheme, themes } = useTheme();
 *   return (
 *     <select value={theme} onChange={e => setTheme(e.target.value)}>
 *       {themes.map(t => <option key={t}>{t}</option>)}
 *     </select>
 *   );
 * }
 * ```
 */

// Main hook for accessing theme
export { useTheme } from "./use-theme.js";

// Provider (typically auto-included via NavigationProvider when theme is enabled)
export { ThemeProvider } from "./ThemeProvider.js";

// Script component for FOUC prevention (use in document head)
export { ThemeScript, type ThemeScriptProps } from "./ThemeScript.js";

// Types
export type {
  Theme,
  ResolvedTheme,
  ThemeAttribute,
  ThemeConfig,
  ResolvedThemeConfig,
  UseThemeReturn,
  ThemeProviderProps,
  ThemeContextValue,
} from "./types.js";

// Constants
export { THEME_DEFAULTS, THEME_COOKIE } from "./constants.js";
