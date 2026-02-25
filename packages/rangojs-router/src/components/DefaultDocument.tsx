"use client";

import type { ReactNode, ReactElement } from "react";
import { MetaTags } from "../handles/MetaTags.js";

/**
 * Default document component that provides a basic HTML structure.
 * Used when no custom document is provided to createRouter.
 * Includes MetaTags for automatic charset, viewport, and route meta support.
 *
 * Uses suppressHydrationWarning on <html> because the theme script
 * may modify class/style attributes before React hydrates.
 */
export function DefaultDocument({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <MetaTags />
      </head>
      <body>{children}</body>
    </html>
  );
}
