"use client";

import type { ReactNode, ReactElement } from "react";

/**
 * Default document component that provides a basic HTML structure.
 * Used when no custom document is provided to createRSCRouter.
 */
export function DefaultDocument({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>{children}</body>
    </html>
  );
}
