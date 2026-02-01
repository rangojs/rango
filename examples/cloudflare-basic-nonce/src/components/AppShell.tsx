"use client";

import type { ReactNode } from "react";
import { Link, href, MetaTags } from "@ivogt/rsc-router/client";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
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
              button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; background: #0070f3; color: white; border: none; border-radius: 4px; }
              button:hover { background: #0051a8; }
              .counter { font-size: 2rem; margin: 1rem 0; }
              .csp-badge { display: inline-block; background: #10b981; color: white; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; margin-left: 0.5rem; }
            `,
          }}
        />
      </head>
      <body>
        <nav data-testid="nav">
          <Link to={href("/")} data-testid="nav-home">Home</Link>
          <Link to={href("/about")} data-testid="nav-about">About</Link>
          <Link to={href("/counter")} data-testid="nav-counter">Counter</Link>
          <span className="csp-badge">CSP Enabled</span>
        </nav>
        {children}
      </body>
    </html>
  );
}
