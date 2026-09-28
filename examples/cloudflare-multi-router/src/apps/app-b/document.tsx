"use client";

import { Html } from "@rangojs/router/client";
import appBStyles from "./styles.css?url";

export function Document({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the theme init script (rendered by Html.Meta)
    // sets the data-theme attribute before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>App B</title>
        <link rel="stylesheet" href={appBStyles} precedence="high" />
        {/* Html.Meta renders the theme init script when a theme is configured. */}
        <Html.Meta />
      </head>
      <body>
        <div
          data-testid="app-shell-marker"
          data-app-shell="b"
          style={{ display: "none" }}
        >
          app-b-shell
        </div>
        {children}
      </body>
    </html>
  );
}
