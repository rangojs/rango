"use client";

import { MetaTags, Scripts } from "@rangojs/router/client";
import type { ReactNode } from "react";
import "@fontsource-variable/open-sans";
import "@fontsource-variable/geist-mono";

import styles from "./index.css?url";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
        <link as="style" href={styles} precedence="default" rel="preload" />
        <link href={styles} precedence="default" rel="stylesheet" />
        <Scripts />
        <MetaTags />
      </head>
      <body className="min-h-dvh bg-background-100 font-sans text-gray-1000 antialiased">
        {children}
        <Scripts position="body" />
      </body>
    </html>
  );
}
