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
              body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 2rem; max-width: 1100px; margin: 0 auto; }
              h1 { margin-bottom: 1rem; font-size: 2rem; }
              h2 { margin: 1.5rem 0 0.75rem; font-size: 1.5rem; }
              a { color: #0070f3; text-decoration: none; }
              a:hover { text-decoration: underline; }
              pre { background: #f5f5f5; padding: 1rem; border-radius: 4px; overflow: auto; }
              code { font-family: monospace; background: #f5f5f5; padding: 0.1rem 0.3rem; border-radius: 2px; }
              ul, ol { margin-left: 1.5rem; line-height: 1.8; }
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
