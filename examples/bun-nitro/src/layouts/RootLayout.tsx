"use client";

import type { ReactNode } from "react";
import { Link, ScrollRestoration, href } from "@rangojs/router/client";

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Bun Vercel App</title>
        <style>{`
          body {
            font-family: system-ui, -apple-system, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 2rem;
            line-height: 1.6;
          }
          nav {
            background: #f0f0f0;
            padding: 1rem;
            margin-bottom: 2rem;
            border-radius: 8px;
          }
          nav a {
            margin-right: 1rem;
            color: #0066cc;
            text-decoration: none;
          }
          nav a:hover {
            text-decoration: underline;
          }
          h1 { color: #333; }
        `}</style>
      </head>
      <body>
        <ScrollRestoration />
        <nav>
          <Link to={href("/")} prefetch="hover">
            Home
          </Link>
          <Link to={href("/about")} prefetch="hover">
            About
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
