"use client";

import type { ReactNode } from "react";
import { Link, ScrollRestoration, href } from "rsc-router/client";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { BreadcrumbNav } from "../components/BreadcrumbNav.js";

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>RSC Router Demo</title>
        <style>{`
          body {
            font-family: system-ui, -apple-system, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 2rem;
            line-height: 1.6;
          }
          body.full-width {
            max-width: none;
            padding: 1rem;
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
          h2 { color: #666; }
          .segment-id {
            background: #e8f4f8;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.85rem;
            color: #0066cc;
          }
        `}</style>
      </head>
      <body className="full-width">
        <ScrollRestoration />
        <nav>
          <Link to={href("/")} prefetch="hover">
            Home
          </Link>
          <Link to={href("/about")} prefetch="hover">
            About
          </Link>
          <Link to={href("/blog")} prefetch="hover">
            Blog
          </Link>
          <Link to={href("/dashboard")} prefetch="hover">
            Dashboard
          </Link>
          <Link to={href("/shop")} prefetch="hover">
            Shop
          </Link>
          <Link to={href("/todos")} prefetch="hover">
            Todos
          </Link>
          <Link to={href("/kanban")} prefetch="hover">
            Kanban
          </Link>
          <Link to={href("/loaders")} prefetch="hover">
            Loaders
          </Link>
          <Link to={href("/errors")} prefetch="hover">
            Errors
          </Link>
        </nav>
        <BreadcrumbNav />
        <DebugSegmentWrapper type="layout" name="Root">
          <DebugSegmentWrapper type="outlet" name="Root Outlet">
            {children}
          </DebugSegmentWrapper>
        </DebugSegmentWrapper>
      </body>
    </html>
  );
}
