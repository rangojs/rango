"use client";

import type { ReactNode } from "react";
import {
  Link,
  ScrollRestoration,
  href,
  MetaTags,
  Scripts,
} from "@rangojs/router/client";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";
import { BreadcrumbNav } from "../components/BreadcrumbNav.js";
import { LinkStatusIndicator } from "../components/LinkStatusIndicator.js";
import { GtmPageViews } from "../components/GtmPageViews.js";
import { TitleUpdater } from "../components/TitleUpdater.js";
import { DEFAULT_GTM_ID, gtmNoScriptSrc } from "../handles/gtm.js";

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          No manual <title> here: the Meta handle owns the single document title
          (a default is set in the GTM layout, overridden per route). Two <title>
          elements would make document.title resolve to the first (manual) one at
          parse time, so the inline GTM bootstrap would read the wrong page_title
          before React reconciles the managed title.
        */}
        <MetaTags />
        {/* Renders scripts pushed via ctx.use(Script) (the GTM bootstrap is one). */}
        <Scripts />
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
        {/* Body-positioned scripts pushed via ctx.use(Script)({ position: "body" }). */}
        <Scripts position="body" />
        {/* GTM <noscript> fallback (not a <script>, so the consumer Document owns it). */}
        <noscript>
          <iframe
            src={gtmNoScriptSrc(DEFAULT_GTM_ID)}
            height="0"
            width="0"
            style={{ display: "none", visibility: "hidden" }}
            title="gtm"
          />
        </noscript>
        <GtmPageViews />
        <TitleUpdater />
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
            <LinkStatusIndicator />
          </Link>
          <Link to={href("/dashboard")} prefetch="hover">
            Dashboard
          </Link>
          <Link to={href("/shop")} prefetch="hover">
            Shop
          </Link>
          <Link to="/client-shop" prefetch="hover">
            Client Shop
          </Link>
          <Link to={href("/magazine")} prefetch="hover">
            Magazine
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
          <Link to={href("/refresh")} prefetch="hover">
            Refresh
          </Link>
          <Link to={href("/errors")} prefetch="hover">
            Errors
          </Link>
          <Link to={href("/gtm")} prefetch="hover">
            GTM
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
