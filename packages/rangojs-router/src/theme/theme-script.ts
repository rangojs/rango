/**
 * Generates an inline script for FOUC prevention.
 *
 * This script runs synchronously before page paint to:
 * 1. Read theme from cookie or localStorage
 * 2. Detect system preference if theme is "system"
 * 3. Apply theme to HTML element via class or data attribute
 * 4. Optionally set color-scheme CSS property
 *
 * The script is minified and inlined in <head> before any other content.
 */

import type { ResolvedThemeConfig } from "./types.js";

/**
 * Generate the inline script for theme initialization
 *
 * The script is designed to:
 * - Run synchronously before paint (blocking)
 * - Be as small as possible to minimize blocking time
 * - Work without any external dependencies
 * - Handle all edge cases (no localStorage, no cookie, etc.)
 */
export function generateThemeScript(config: ResolvedThemeConfig): string {
  const script = `
(function() {
  var storageKey = ${JSON.stringify(config.storageKey)};
  var defaultTheme = ${JSON.stringify(config.defaultTheme)};
  var attribute = ${JSON.stringify(config.attribute)};
  var enableSystem = ${config.enableSystem};
  var enableColorScheme = ${config.enableColorScheme};
  var valueMap = ${JSON.stringify(config.value)};
  var themes = ${JSON.stringify(config.themes)};

  function getStoredTheme() {
    var cookies = document.cookie.split(';');
    for (var i = 0; i < cookies.length; i++) {
      var cookie = cookies[i].trim();
      if (cookie.indexOf(storageKey + '=') === 0) {
        try { return decodeURIComponent(cookie.substring(storageKey.length + 1)); }
        catch (e) { return cookie.substring(storageKey.length + 1); }
      }
    }
    try {
      return localStorage.getItem(storageKey);
    } catch (e) {
      return null;
    }
  }

  function getSystemTheme() {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  }

  function resolveTheme(theme) {
    if (theme === 'system' && enableSystem) {
      return getSystemTheme();
    }
    return theme;
  }

  function applyTheme(theme) {
    var resolved = resolveTheme(theme);
    var value = valueMap[resolved] || resolved;
    var el = document.documentElement;

    if (attribute === 'class') {
      for (var i = 0; i < themes.length; i++) {
        var v = valueMap[themes[i]] || themes[i];
        el.classList.remove(v);
      }
      el.classList.add(value);
    } else {
      el.setAttribute(attribute, value);
    }

    if (enableColorScheme) {
      el.style.colorScheme = resolved;
    }
  }

  var stored = getStoredTheme();
  // A stored value is valid when it is a configured theme, OR "system" but only
  // while system detection is enabled. A stored "system" with enableSystem=false
  // (an old cookie/localStorage, or a value pushed cross-tab) must fall back to
  // defaultTheme — otherwise resolveTheme returns "system" unresolved and
  // applyTheme writes a bogus class="system" / colorScheme="system" on <html>.
  // Same rule as isValidTheme (constants.ts), inlined since this is a string.
  var systemAllowed = stored === 'system' && enableSystem;
  var theme = stored && (systemAllowed || themes.indexOf(stored) !== -1)
    ? stored
    : defaultTheme;

  applyTheme(theme);

  // Idempotency guard: MetaTags auto-injects this script when theme is enabled,
  // and ThemeScript is also a public component for the same job. If a consumer
  // renders both, the IIFE runs twice; without this guard the second run would
  // register a SECOND, never-removed matchMedia('change') listener (a leak).
  // The flag is keyed by storageKey so independent theme configs don't collide.
  var flagKey = '__rangoThemeListener_' + storageKey;
  if (enableSystem && typeof window !== 'undefined' && window.matchMedia && !window[flagKey]) {
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
        var current = getStoredTheme() || defaultTheme;
        if (current === 'system') {
          applyTheme('system');
        }
      });
      window[flagKey] = true;
    } catch (e) {
      // Older browsers may not support addEventListener on MediaQueryList
    }
  }
})();
`;

  return minifyScript(script);
}

/**
 * Basic script minification
 * Removes comments, extra whitespace, and unnecessary newlines
 */
function minifyScript(script: string): string {
  return (
    script
      // Remove single-line comments
      .replace(/\/\/.*$/gm, "")
      // Remove multi-line comments
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Remove leading/trailing whitespace from lines
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("")
      // Collapse multiple spaces to single space
      .replace(/\s+/g, " ")
      // Remove spaces around operators and punctuation
      .replace(/\s*([{};,=!<>()[\]+\-*/&|?:])\s*/g, "$1")
      // Add back necessary spaces (e.g., "var x")
      .replace(/(var|function|return|if|for|try|catch|typeof|else)\(/g, "$1 (")
      .replace(/\)([a-zA-Z])/g, ") $1")
  );
}

/**
 * Generate nonce attribute string if nonce is provided
 */
export function getNonceAttribute(nonce?: string): string {
  return nonce ? ` nonce="${nonce}"` : "";
}
