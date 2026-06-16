"use client";

import type { ReactNode } from "react";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>vercel-multi-router</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
