"use client";

// app-a is the cross-app TARGET in the shared-stylesheet repro: it renders the
// SHARED href MANAGED (precedence), exactly like the real store/document.tsx.
import sharedStyles from "../../shared-tailwind.css?url";

export function Document({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>App A</title>
        <link rel="preload" href={sharedStyles} as="style" precedence="high" />
        <link rel="stylesheet" href={sharedStyles} precedence="high" />
      </head>
      <body>
        <div
          data-testid="app-shell-marker"
          data-app-shell="a"
          style={{ display: "none" }}
        >
          app-a-shell
        </div>
        {children}
      </body>
    </html>
  );
}
