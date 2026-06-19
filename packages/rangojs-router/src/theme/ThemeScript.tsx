/**
 * ThemeScript - Server component that renders an inline script for FOUC prevention.
 *
 * This component renders a blocking inline script that:
 * 1. Reads theme from cookie/localStorage before paint
 * 2. Applies the theme to the HTML element immediately
 * 3. Prevents flash of unstyled content (FOUC)
 *
 * Must be placed in the <head> element of your document, before any stylesheets.
 *
 * Note: when theme is enabled in the router config, `<MetaTags />` ALREADY
 * renders this FOUC script. Use `<ThemeScript />` only if you do NOT render
 * `<MetaTags />`. Rendering both is safe — the inline script guards the
 * matchMedia listener registration against double-running — but it is redundant.
 *
 * @example
 * ```tsx
 * // In your document component. Use ThemeScript only when you do not render MetaTags.
 * import { ThemeScript } from "@rangojs/router/theme";
 *
 * export function Document({ children }) {
 *   return (
 *     <html lang="en" suppressHydrationWarning>
 *       <head>
 *         <ThemeScript config={config} />
 *       </head>
 *       <body>{children}</body>
 *     </html>
 *   );
 * }
 * ```
 */

import React from "react";
import { generateThemeScript } from "./theme-script.js";
import type { ResolvedThemeConfig } from "./types.js";

export interface ThemeScriptProps {
  /**
   * Theme configuration - passed from router.themeConfig
   */
  config: ResolvedThemeConfig;

  /**
   * Optional nonce for CSP
   */
  nonce?: string;
}

export function ThemeScript({
  config,
  nonce,
}: ThemeScriptProps): React.ReactNode {
  const scriptContent = generateThemeScript(config);

  return (
    <script nonce={nonce} dangerouslySetInnerHTML={{ __html: scriptContent }} />
  );
}
