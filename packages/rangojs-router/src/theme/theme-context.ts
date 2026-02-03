"use client";

/**
 * Theme context for sharing theme state and configuration.
 *
 * Used by:
 * - ThemeProvider to provide theme state
 * - useTheme hook to access theme state
 * - MetaTags to check if theme is enabled and render script
 */

import { createContext, useContext, type Context } from "react";
import type { ResolvedThemeConfig, ThemeContextValue } from "./types.js";

/**
 * React context for theme state
 * null when theme is not enabled in router config
 */
export const ThemeContext: Context<ThemeContextValue | null> = createContext<ThemeContextValue | null>(null);

/**
 * SSR module-level state for theme config.
 * Populated by initThemeConfigSync before React renders.
 * Used by MetaTags during SSR to render the theme script.
 */
let ssrThemeConfig: ResolvedThemeConfig | null = null;

/**
 * Initialize theme config synchronously for SSR.
 * Called before rendering to populate state for MetaTags.
 *
 * @param config - Theme config from router, or null if theme is disabled
 */
export function initThemeConfigSync(config: ResolvedThemeConfig | null): void {
  ssrThemeConfig = config;
}

/**
 * Get theme config for SSR/hydration.
 * Used by MetaTags to render the theme script.
 *
 * @returns Theme config if available, null otherwise
 */
export function getSSRThemeConfig(): ResolvedThemeConfig | null {
  return ssrThemeConfig;
}

/**
 * Get theme context (internal use)
 * Returns null if theme is not enabled
 */
export function useThemeContext(): ThemeContextValue | null {
  return useContext(ThemeContext);
}

/**
 * Get theme context, throwing if not available
 * Use this in useTheme hook
 */
export function requireThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error(
      "useTheme must be used within a ThemeProvider. " +
        "Make sure theme is enabled in your router config: " +
        "createRSCRouter({ theme: { ... } })"
    );
  }
  return ctx;
}
