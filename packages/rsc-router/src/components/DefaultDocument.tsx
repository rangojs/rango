"use client";

import type { ReactNode, ReactElement } from "react";
import { MetaTags } from "../handles/MetaTags.js";

/**
 * Default document component that provides a basic HTML structure.
 * Used when no custom document is provided to createRSCRouter.
 * Includes MetaTags for automatic charset, viewport, and route meta support.
 */
export function DefaultDocument({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en">
      <head>
        <MetaTags />
      </head>
      <body>{children}</body>
    </html>
  );
}
