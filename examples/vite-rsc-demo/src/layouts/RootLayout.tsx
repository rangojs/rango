import { Outlet } from "rsc-router/client";
import { Link, href } from "rsc-router/browser";
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
      <body>
        <nav>
          <Link to={href("index")}>Home</Link>
          <Link to={href("about")}>About</Link>
          <Link to={href("blog.index")}>Blog</Link>
          <Link to={href("dashboard.index")}>Dashboard</Link>
          <Link to={href("shop.index")}>Shop</Link>
          <Link to={href("todos.index")}>Todos</Link>
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
