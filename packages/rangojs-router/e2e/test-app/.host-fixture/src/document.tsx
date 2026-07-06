"use client";

import type { ReactNode } from "react";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>host-fixture</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
