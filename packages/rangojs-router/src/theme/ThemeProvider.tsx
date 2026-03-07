"use client";

/**
 * ThemeProvider - Client component that provides theme state and management.
 *
 * Features:
 * - Syncs theme to cookie/localStorage
 * - Detects system preference changes
 * - Cross-tab synchronization via storage events
 * - Updates HTML element attribute when theme changes
 * - Handles SSR hydration by deferring system theme detection
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
} from "react";
import { ThemeContext } from "./theme-context.js";
import type {
  ResolvedTheme,
  ResolvedThemeConfig,
  Theme,
  ThemeContextValue,
  ThemeProviderProps,
} from "./types.js";
import { THEME_COOKIE } from "./constants.js";

/**
 * Get system preference for color scheme
 */
function getSystemTheme(): ResolvedTheme {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

/**
 * Read theme from cookie
 */
function readThemeFromCookie(storageKey: string): string | null {
  if (typeof document === "undefined") return null;

  const cookies = document.cookie.split(";");
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split("=");
    if (name === storageKey) {
      const raw = rest.join("=");
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

/**
 * Read theme from localStorage
 */
function readThemeFromStorage(storageKey: string): string | null {
  if (typeof localStorage === "undefined") return null;

  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/**
 * Write theme to cookie
 */
function writeThemeToCookie(storageKey: string, theme: Theme): void {
  if (typeof document === "undefined") return;

  const value = encodeURIComponent(theme);
  const cookie = `${storageKey}=${value}; Path=${THEME_COOKIE.path}; Max-Age=${THEME_COOKIE.maxAge}; SameSite=${THEME_COOKIE.sameSite}`;
  document.cookie = cookie;
}

/**
 * Write theme to localStorage
 */
function writeThemeToStorage(storageKey: string, theme: Theme): void {
  if (typeof localStorage === "undefined") return;

  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // localStorage might be disabled or full
  }
}

/**
 * Apply theme to HTML element
 */
function applyThemeToDocument(theme: Theme, config: ResolvedThemeConfig): void {
  if (typeof document === "undefined") return;

  const resolved =
    theme === "system" && config.enableSystem
      ? getSystemTheme()
      : (theme as ResolvedTheme);

  const value = config.value[resolved] || resolved;
  const el = document.documentElement;

  // Apply attribute
  if (config.attribute === "class") {
    // Remove all theme classes
    for (const t of config.themes) {
      const v = config.value[t] || t;
      el.classList.remove(v);
    }
    // Add current theme class
    el.classList.add(value);
  } else {
    el.setAttribute(config.attribute, value);
  }

  // Set color-scheme for native dark mode support
  if (config.enableColorScheme) {
    el.style.colorScheme = resolved;
  }
}

/**
 * Get the resolved stored theme (validated against available themes)
 */
function getStoredTheme(config: ResolvedThemeConfig): Theme {
  const { storageKey, themes, defaultTheme, enableSystem } = config;

  // Try cookie first (for SSR consistency)
  let stored = readThemeFromCookie(storageKey);

  // Fall back to localStorage
  if (!stored) {
    stored = readThemeFromStorage(storageKey);
  }

  // Validate stored value
  if (stored) {
    if (stored === "system" && enableSystem) {
      return "system";
    }
    if (themes.includes(stored)) {
      return stored as Theme;
    }
  }

  return defaultTheme;
}

/**
 * ThemeProvider component
 *
 * Provides theme state to the component tree via context.
 * Handles theme persistence, system preference detection, and cross-tab sync.
 */
export function ThemeProvider({
  config,
  initialTheme,
  children,
}: ThemeProviderProps): React.ReactNode {
  // Track mount state to avoid hydration mismatches
  // During SSR and initial hydration, mounted is false
  const [mounted, setMounted] = useState(false);

  // Initialize theme from prop, storage, or default
  const [theme, setThemeState] = useState<Theme>(() => {
    if (initialTheme) return initialTheme;
    if (typeof window === "undefined") return config.defaultTheme;
    return getStoredTheme(config);
  });

  // Track system preference - use stable default during SSR
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("light");

  // Set mounted after hydration and detect actual system theme
  useEffect(() => {
    setMounted(true);
    setSystemTheme(getSystemTheme());
  }, []);

  // Set theme and persist to storage
  const setTheme = useCallback(
    (newTheme: Theme) => {
      setThemeState(newTheme);
      writeThemeToCookie(config.storageKey, newTheme);
      writeThemeToStorage(config.storageKey, newTheme);
      applyThemeToDocument(newTheme, config);
    },
    [config],
  );

  // Listen for system preference changes
  useEffect(() => {
    if (!config.enableSystem) return;
    if (typeof window === "undefined" || !window.matchMedia) return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = (e: MediaQueryListEvent) => {
      const newSystemTheme = e.matches ? "dark" : "light";
      setSystemTheme(newSystemTheme);

      // If current theme is "system", re-apply to update document
      if (theme === "system") {
        applyThemeToDocument("system", config);
      }
    };

    // Modern browsers
    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [config, theme]);

  // Cross-tab synchronization via localStorage storage event
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key !== config.storageKey) return;

      const newTheme = e.newValue;
      if (!newTheme) return;

      // Validate and apply
      if (newTheme === "system" || config.themes.includes(newTheme)) {
        setThemeState(newTheme as Theme);
        applyThemeToDocument(newTheme as Theme, config);
      }
    };

    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [config]);

  // Compute resolved theme
  // During SSR (not mounted), use the initial theme or default to avoid hydration mismatch
  const resolvedTheme: ResolvedTheme = useMemo(() => {
    if (!mounted) {
      // During SSR, return the initial theme if it's not "system", otherwise "light"
      // The inline script will apply the correct class before hydration
      if (initialTheme && initialTheme !== "system") {
        return initialTheme as ResolvedTheme;
      }
      return "light";
    }
    if (theme === "system" && config.enableSystem) {
      return systemTheme;
    }
    return theme as ResolvedTheme;
  }, [theme, systemTheme, config.enableSystem, mounted, initialTheme]);

  // Build themes list (include "system" if enabled)
  const themes = useMemo(() => {
    if (config.enableSystem) {
      return ["system", ...config.themes.filter((t) => t !== "system")];
    }
    return config.themes;
  }, [config.themes, config.enableSystem]);

  // Context value
  // During SSR (not mounted), return stable values to avoid hydration mismatch
  const contextValue: ThemeContextValue = useMemo(
    () => ({
      theme,
      setTheme,
      resolvedTheme,
      // Return stable "light" for systemTheme during SSR - actual value updates after mount
      systemTheme: mounted ? systemTheme : "light",
      themes,
      config,
    }),
    [theme, setTheme, resolvedTheme, systemTheme, themes, config, mounted],
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}
