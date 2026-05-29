"use client";

export function Document({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>App B</title>
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
