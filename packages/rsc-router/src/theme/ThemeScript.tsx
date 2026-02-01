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
 * @example
 * ```tsx
 * // In your document component
 * import { ThemeScript } from "@ivogt/rsc-router/theme";
 *
 * export function Document({ children }) {
 *   return (
 *     <html lang="en" suppressHydrationWarning>
 *       <head>
 *         <ThemeScript />
 *         <MetaTags />
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

/**
 * Server component that renders the theme initialization script.
 *
 * This renders a synchronous inline script that applies the theme
 * to the HTML element before React hydration, preventing FOUC.
 */
export function ThemeScript({ config, nonce }: ThemeScriptProps): React.ReactNode {
  const scriptContent = generateThemeScript(config);

  return (
    <script
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: scriptContent }}
    />
  );
}
