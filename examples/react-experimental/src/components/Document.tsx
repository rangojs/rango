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
              body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 2rem; max-width: 800px; margin: 0 auto; }
              nav { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #eee; }
              nav a { margin-right: 1rem; color: #0070f3; text-decoration: none; }
              nav a:hover { text-decoration: underline; }
              h1 { margin-bottom: 1rem; }
              button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; background: #0070f3; color: white; border: none; border-radius: 4px; }
              button:hover { background: #0051a8; }
              .counter { font-size: 2rem; margin: 1rem 0; }

              /* Fade transitions */
              ::view-transition-new(.fade-in) {
                animation: fade-in 300ms ease-in;
              }
              ::view-transition-old(.fade-out) {
                animation: fade-out 300ms ease-out;
              }

              /* Slide-up/down transitions (gallery detail) */
              ::view-transition-new(.slide-up) {
                animation: slide-up 300ms ease-out;
              }
              ::view-transition-old(.slide-down) {
                animation: slide-down 300ms ease-in;
              }

              /* Shared morph transition (gallery named) */
              ::view-transition-group(.gallery-morph) {
                animation-duration: 350ms;
                animation-timing-function: ease-in-out;
              }

              /* Direction-aware slide transitions */
              ::view-transition-new(.slide-from-right) {
                animation: slide-from-right 300ms ease-in-out;
              }
              ::view-transition-old(.slide-to-left) {
                animation: slide-to-left 300ms ease-in-out;
              }
              ::view-transition-new(.slide-from-left) {
                animation: slide-from-left 300ms ease-in-out;
              }
              ::view-transition-old(.slide-to-right) {
                animation: slide-to-right 300ms ease-in-out;
              }

              @keyframes fade-in {
                from { opacity: 0; }
                to { opacity: 1; }
              }
              @keyframes fade-out {
                from { opacity: 1; }
                to { opacity: 0; }
              }
              @keyframes slide-up {
                from { transform: translateY(30px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
              }
              @keyframes slide-down {
                from { transform: translateY(0); opacity: 1; }
                to { transform: translateY(30px); opacity: 0; }
              }
              @keyframes slide-from-right {
                from { transform: translateX(100%); }
                to { transform: translateX(0); }
              }
              @keyframes slide-to-left {
                from { transform: translateX(0); }
                to { transform: translateX(-100%); }
              }
              @keyframes slide-from-left {
                from { transform: translateX(-100%); }
                to { transform: translateX(0); }
              }
              @keyframes slide-to-right {
                from { transform: translateX(0); }
                to { transform: translateX(100%); }
              }
            `,
          }}
        />
      </head>
      <body>
        <nav data-testid="nav">
          <Link to={href("/")} data-testid="nav-home">Home</Link>
          <Link to={href("/about")} data-testid="nav-about">About</Link>
          <Link to={href("/counter")} data-testid="nav-counter">Counter</Link>
          <Link to={href("/static")} data-testid="nav-static">Static</Link>
          <Link to={href("/prerender")} data-testid="nav-prerender">Prerender</Link>
          <Link to={href("/transition-a")} data-testid="nav-transition-a">Slide A</Link>
          <Link to={href("/transition-b")} data-testid="nav-transition-b">Slide B</Link>
          <Link to={href("/gallery")} data-testid="nav-gallery">Gallery</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
