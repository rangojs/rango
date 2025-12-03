import { Outlet } from "rsc-router/client";
import { Link } from "rsc-router/browser";
import { href } from "../router.js";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";

export function RootLayout() {
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
        <nav>
          <Link to={href("index")} prefetch="hover">
            Home
          </Link>
          <Link to={href("about")} prefetch="hover">
            About
          </Link>
          <Link to={href("blog.index")} prefetch="hover">
            Blog
          </Link>
          <Link to={href("dashboard.index")} prefetch="hover">
            Dashboard
          </Link>
          <Link to={href("shop.index")} prefetch="hover">
            Shop
          </Link>
          <Link to={href("todos.index")} prefetch="hover">
            Todos
          </Link>
          <Link to={href("kanban.index")} prefetch="hover">
            Kanban
          </Link>
          <Link to={href("errors.index")} prefetch="hover">
            Errors
          </Link>
        </nav>
        <DebugSegmentWrapper type="layout" name="Root">
          <DebugSegmentWrapper type="outlet" name="Root Outlet">
            <Outlet />
          </DebugSegmentWrapper>
        </DebugSegmentWrapper>
      </body>
    </html>
  );
}
