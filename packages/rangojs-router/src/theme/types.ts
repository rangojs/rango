/**
 * Theme type definitions for rsc-router theme system.
 *
 * The theme system provides:
 * - Opt-in via router config
 * - FOUC prevention via inline script
 * - Server-side theme access via ctx.theme/ctx.setTheme
 * - Client-side theme access via useTheme hook
 */

/**
 * Theme value - stored in cookies/localStorage
 */
export type Theme = "light" | "dark" | "system";

/**
 * Resolved theme - actual visual appearance (system preference resolved)
 */
export type ResolvedTheme = "light" | "dark";

/**
 * Attribute used to apply theme to HTML element
 * - "class": Adds theme value as CSS class (e.g., <html class="dark">)
 * - "data-*": Sets data attribute (e.g., <html data-theme="dark">)
 */
export type ThemeAttribute = "class" | `data-${string}`;

/**
 * Theme configuration for router
 *
 * @example
 * ```typescript
 * const router = createRouter<Env>({
 *   theme: {
 *     defaultTheme: "system",
 *     themes: ["light", "dark"],
 *     attribute: "class",
 *     storageKey: "theme",
 *   }
 * });
 * ```
 */
export interface ThemeConfig {
  /**
   * Default theme when no preference is stored
   * @default "system"
   */
  defaultTheme?: Theme;

  /**
   * Available theme options
   * @default ["light", "dark"]
   */
  themes?: string[];

  /**
   * Attribute to apply to HTML element
   * @default "class"
   */
  attribute?: ThemeAttribute;

  /**
   * Key for cookie and localStorage
   * @default "theme"
   */
  storageKey?: string;

  /**
   * Enable system preference detection
   * When true, "system" theme will resolve based on prefers-color-scheme
   * @default true
   */
  enableSystem?: boolean;

  /**
   * Set CSS color-scheme property on HTML element
   * This enables native dark mode for form controls, scrollbars, etc.
   * @default true
   */
  enableColorScheme?: boolean;

  /**
   * Custom mapping of theme names to attribute values
   * Useful when theme names don't match desired attribute values
   *
   * @example
   * ```typescript
   * value: {
   *   light: "light-mode",
   *   dark: "dark-mode",
   * }
   * ```
   */
  value?: Record<string, string>;
}

/**
 * Resolved theme configuration with defaults applied
 */
export interface ResolvedThemeConfig {
  defaultTheme: Theme;
  themes: string[];
  attribute: ThemeAttribute;
  storageKey: string;
  enableSystem: boolean;
  enableColorScheme: boolean;
  value: Record<string, string>;
}

/**
 * Return type from useTheme hook
 *
 * @example
 * ```tsx
 * function ThemeToggle() {
 *   const { theme, setTheme, resolvedTheme, themes } = useTheme();
 *
 *   return (
 *     <select value={theme} onChange={e => setTheme(e.target.value as Theme)}>
 *       {themes.map(t => <option key={t}>{t}</option>)}
 *     </select>
 *   );
 * }
 * ```
 */
export interface UseThemeReturn {
  /**
   * Current theme setting ("light" | "dark" | "system")
   */
  theme: Theme;

  /**
   * Set the theme
   */
  setTheme: (theme: Theme) => void;

  /**
   * Resolved theme based on system preference
   * When theme is "system", this reflects the actual appearance
   */
  resolvedTheme: ResolvedTheme;

  /**
   * Current system preference ("light" | "dark")
   */
  systemTheme: ResolvedTheme;

  /**
   * Available theme options (includes "system" if enableSystem is true)
   */
  themes: string[];
}

/**
 * Props for ThemeProvider component
 */
export interface ThemeProviderProps {
  /**
   * Theme configuration
   */
  config: ResolvedThemeConfig;

  /**
   * Initial theme from server (from cookie)
   */
  initialTheme?: Theme;

  /**
   * Children to render
   */
  children: React.ReactNode;
}

/**
 * Context value for ThemeContext
 */
export interface ThemeContextValue extends UseThemeReturn {
  /**
   * Full theme configuration
   */
  config: ResolvedThemeConfig;
}
