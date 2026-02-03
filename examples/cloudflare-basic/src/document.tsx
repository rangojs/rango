"use client";

import type { ReactNode } from "react";
import { Link, MetaTags } from "@rangojs/router/client";
import { BreadcrumbNav } from "./components/BreadcrumbNav.js";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <MetaTags />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 2rem; max-width: 1100px; margin: 0 auto; }
              nav { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #eee; }
              nav a { margin-right: 1rem; color: #0070f3; text-decoration: none; }
              nav a:hover { text-decoration: underline; }
              h1 { margin-bottom: 1rem; }
              button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; background: #0070f3; color: white; border: none; border-radius: 4px; }
              button:hover { background: #0051a8; }
              .counter { font-size: 2rem; margin: 1rem 0; }

              /* Dark mode styles */
              .dark body { background: #1a1a1a; color: #e0e0e0; }
              .dark nav { border-bottom-color: #444; }
              .dark button { background: #0051a8; }
              .dark button:hover { background: #0070f3; }
            `,
          }}
        />
      </head>
      <body>
        <nav data-testid="nav">
          <Link to="/" data-testid="nav-home">
            Home
          </Link>
          <Link to="/about" data-testid="nav-about">
            About
          </Link>
          <Link to="/counter" data-testid="nav-counter">
            Counter
          </Link>
          <Link to="/blog" data-testid="nav-blog">
            Blog
          </Link>
          <Link to="/theme" data-testid="nav-theme">
            Theme
          </Link>
          <Link to="/slow/1" data-testid="nav-slow-1">
            Slow 1
          </Link>
          <Link to="/slow/2" data-testid="nav-slow-2">
            Slow 2
          </Link>
          <Link to="/slow/fast" data-testid="nav-fast">
            Fast
          </Link>
        </nav>
        <BreadcrumbNav />
        {children}
      </body>
    </html>
  );
}
