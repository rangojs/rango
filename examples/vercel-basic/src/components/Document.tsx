"use client";

import type { ReactNode } from "react";
import { Link, MetaTags, href } from "@rangojs/router/client";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <MetaTags />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 2rem; max-width: 760px; margin: 0 auto; }
              nav { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #eee; }
              nav a { margin-right: 1rem; color: #0070f3; text-decoration: none; }
              nav a:hover { text-decoration: underline; }
              h1 { margin-bottom: 1rem; }
              time { font-variant-numeric: tabular-nums; font-weight: 600; }
            `,
          }}
        />
      </head>
      <body>
        <nav data-testid="nav">
          <Link to={href("/")} data-testid="nav-home">
            Home
          </Link>
          <Link to={href("/about")} data-testid="nav-about">
            About
          </Link>
          <Link to={href("/cached")} data-testid="nav-cached">
            Cached
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
