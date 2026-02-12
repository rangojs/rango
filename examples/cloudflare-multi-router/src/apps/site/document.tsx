"use client";

import type { ReactNode } from "react";
import { MetaTags } from "@rangojs/router/client";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <MetaTags />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 2rem; max-width: 800px; margin: 0 auto; }
              nav { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #eee; }
              nav a { margin-right: 1rem; color: #0070f3; text-decoration: none; }
              nav a:hover { text-decoration: underline; }
              h1 { margin-bottom: 1rem; }
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
