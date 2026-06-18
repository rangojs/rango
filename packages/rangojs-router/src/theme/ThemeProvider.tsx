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

function getSystemTheme(): ResolvedTheme {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

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

function readThemeFromStorage(storageKey: string): string | null {
  if (typeof localStorage === "undefined") return null;

  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeThemeToCookie(storageKey: string, theme: Theme): void {
  if (typeof document === "undefined") return;

  const value = encodeURIComponent(theme);
  const cookie = `${storageKey}=${value}; Path=${THEME_COOKIE.path}; Max-Age=${THEME_COOKIE.maxAge}; SameSite=${THEME_COOKIE.sameSite}`;
  document.cookie = cookie;
}

function writeThemeToStorage(storageKey: string, theme: Theme): void {
  if (typeof localStorage === "undefined") return;

  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // localStorage might be disabled or full
  }
}

function applyThemeToDocument(theme: Theme, config: ResolvedThemeConfig): void {
  if (typeof document === "undefined") return;

  const resolved =
    theme === "system" && config.enableSystem
      ? getSystemTheme()
      : (theme as ResolvedTheme);

  const value = config.value[resolved] || resolved;
  const el = document.documentElement;

  if (config.attribute === "class") {
    for (const t of config.themes) {
      const v = config.value[t] || t;
      el.classList.remove(v);
    }
    el.classList.add(value);
  } else {
    el.setAttribute(config.attribute, value);
  }

  if (config.enableColorScheme) {
    el.style.colorScheme = resolved;
  }
}

function getStoredTheme(config: ResolvedThemeConfig): Theme {
  const { storageKey, themes, defaultTheme, enableSystem } = config;

  let stored = readThemeFromCookie(storageKey);

  if (!stored) {
    stored = readThemeFromStorage(storageKey);
  }

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

export function ThemeProvider({
  config,
  initialTheme,
  children,
}: ThemeProviderProps): React.ReactNode {
  const [mounted, setMounted] = useState(false);

  const [theme, setThemeState] = useState<Theme>(() => {
    if (initialTheme) return initialTheme;
    if (typeof window === "undefined") return config.defaultTheme;
    return getStoredTheme(config);
  });

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    setMounted(true);
    setSystemTheme(getSystemTheme());
  }, []);

  const setTheme = useCallback(
    (newTheme: Theme) => {
      // Mirror the server guard (request-context.ts setTheme): reject any value
      // that is not "system" and not in the configured theme set, so the cookie
      // can never hold a value the server would reinterpret as defaultTheme on
      // the next SSR (which would desync initialTheme markup from the applied class).
      if (newTheme !== "system" && !config.themes.includes(newTheme)) {
        console.warn(
          `[Theme] Invalid theme value: "${newTheme}". Valid values: system, ${config.themes.join(", ")}`,
        );
        return;
      }
      setThemeState(newTheme);
      writeThemeToCookie(config.storageKey, newTheme);
      writeThemeToStorage(config.storageKey, newTheme);
      applyThemeToDocument(newTheme, config);
    },
    [config],
  );

  useEffect(() => {
    if (!config.enableSystem) return;
    if (typeof window === "undefined" || !window.matchMedia) return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = (e: MediaQueryListEvent) => {
      const newSystemTheme = e.matches ? "dark" : "light";
      setSystemTheme(newSystemTheme);

      if (theme === "system") {
        applyThemeToDocument("system", config);
      }
    };

    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [config, theme]);

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

  const resolvedTheme: ResolvedTheme = useMemo(() => {
    if (!mounted) {
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

  const themes = useMemo(() => {
    if (config.enableSystem) {
      return ["system", ...config.themes.filter((t) => t !== "system")];
    }
    return config.themes;
  }, [config.themes, config.enableSystem]);

  const contextValue: ThemeContextValue = useMemo(
    () => ({
      theme,
      setTheme,
      resolvedTheme,
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
