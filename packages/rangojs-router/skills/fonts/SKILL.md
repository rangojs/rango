---
name: fonts
description: Load and configure web fonts with preload hints for optimal performance. Use when adding a custom font to a Rango app, fonts flash or swap on load (FOUT/FOIT), or you want font preload for performance.
argument-hint: [provider]
---

# Fonts

Load web fonts in the Document component with `<link rel="preload">` for optimal performance. Fonts are declared in `<head>` alongside your stylesheet.

## Google Fonts

```tsx
// src/document.tsx
"use client";

import type { ReactNode } from "react";
import { MetaTags } from "@rangojs/router/client";
import styles from "./index.css?url";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Preconnect to Google Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />

        {/* Load font stylesheet */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />

        {/* App styles */}
        <link rel="preload" href={styles} as="style" />
        <link rel="stylesheet" href={styles} />
        <MetaTags />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

Then reference the font in CSS:

```css
/* src/index.css */
body {
  font-family: "Inter", sans-serif;
}
```

Or with Tailwind (see `/tailwind`):

```css
/* src/index.css */
@theme {
  --font-sans: "Inter", sans-serif;
}
```

## Self-Hosted Fonts

Place font files in `public/fonts/` and use `@font-face`:

```css
/* src/index.css */
@font-face {
  font-family: "CustomFont";
  src: url("/fonts/custom-regular.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: "CustomFont";
  src: url("/fonts/custom-bold.woff2") format("woff2");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}

body {
  font-family: "CustomFont", sans-serif;
}
```

Preload the most critical weight in the Document:

```tsx
export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preload"
          href="/fonts/custom-regular.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link rel="preload" href={styles} as="style" />
        <link rel="stylesheet" href={styles} />
        <MetaTags />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

## Fontsource (Recommended for Vite)

`@fontsource-variable` packages are the recommended approach with Vite. Fonts are installed as npm dependencies, bundled by Vite, and served from your own domain -- no external requests, no privacy concerns, no FOUT from slow CDNs.

```bash
pnpm add @fontsource-variable/inter
```

Import the font CSS in your stylesheet. Vite resolves the `@fontsource-variable` import from `node_modules` and bundles the woff2 files as hashed assets automatically:

```css
/* src/index.css */
@import "@fontsource-variable/inter";

body {
  font-family: "Inter Variable", sans-serif;
}
```

With Tailwind:

```css
/* src/index.css */
@import "@fontsource-variable/inter";
@import "tailwindcss";

@theme {
  --font-sans: "Inter Variable", sans-serif;
}
```

Why this is preferred over Google Fonts with Vite:

- No external network requests at runtime -- fonts are bundled into your build output
- No `<link rel="preconnect">` or extra stylesheet needed in the Document
- Variable font = single file covers all weights, smaller total download
- Vite handles cache-busting via content hashes
- Works offline and in edge deployments (Cloudflare Workers) without external dependencies

Browse available fonts at fontsource.org. Use `@fontsource-variable/*` for variable fonts and `@fontsource/*` for static fonts.

## Performance Tips

- Prefer `@fontsource-variable` with Vite for self-hosted, zero-config font loading
- Use `font-display: swap` to prevent invisible text during font load
- Preload only the most critical font weight (usually regular 400)
- Prefer `woff2` format for smaller file sizes
- Use variable fonts when multiple weights are needed to reduce total file count
- `<link rel="preconnect">` eliminates DNS + TLS latency for external font providers
