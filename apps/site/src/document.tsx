"use client";

import type { ReactNode } from "react";
import { MetaTags } from "@rangojs/router/client";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <MetaTags />
        <link rel="stylesheet" href="/src/app.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
