---
name: tailwind
description: Set up Tailwind CSS v4 with the Document component and CSS imports. Use when adding Tailwind CSS to a Rango app, or Tailwind classes aren't being applied or generated.
argument-hint: "[setup]"
---

# Tailwind CSS

Set up Tailwind CSS v4 with the Rango router. Styles are loaded through the Document component using Vite's `?url` CSS import.

## Install

```bash
pnpm add -D tailwindcss @tailwindcss/vite
```

## Vite Plugin

```typescript
// vite.config.ts
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    // ... other plugins
  ],
});
```

## CSS Entry Point

```css
/* src/index.css */
@import "tailwindcss";
```

## Document Component

Import the CSS file with `?url` to get a hashed URL, then preload and link it in
`<head>`. Give the `<link rel="stylesheet">` a `precedence` prop so React 19
manages it as a resource — de-duped by `href`, ordered, and loaded before paint
(no flash of unstyled content). See
[Stylesheets and cross-app navigation](#stylesheets-and-cross-app-navigation):

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
        <link rel="preload" href={styles} as="style" precedence="default" />
        <link rel="stylesheet" href={styles} precedence="default" />
        <MetaTags />
      </head>
      <body className="font-sans antialiased text-slate-900 bg-slate-50">
        {children}
      </body>
    </html>
  );
}
```

## Stylesheets and cross-app navigation

The `precedence` prop opts a `<link rel="stylesheet">` into React 19's managed
stylesheet model — React de-duplicates it by `href`, orders it by precedence, and
loads it before paint (avoiding a flash of unstyled content). It is the
recommended way to render a stylesheet link, which is why the example above uses
it. (A bare side-effect `import "./index.css"` also produces managed CSS via
`@vitejs/plugin-rsc`, but carries an SSR-streaming caveat — prefer the `?url` +
`<link precedence>` form for document CSS. See `/css`.)

For **host-router** apps (`/host-router`), a client-side navigation that crosses
an app boundary is a **full document load**, not a soft swap — the framework
redirects on an app switch. So each app's document (its stylesheets, theme, meta)
is always re-established cleanly by the target app's own load; you do not have to
coordinate stylesheet `href`s or `precedence` across apps. (This replaced an
earlier soft cross-app swap, under which a stylesheet shared across apps — every
app's `@import "tailwindcss"` compiles to one hashed asset — could be dropped by
React's by-`href` resource dedup if the apps disagreed on `precedence`. The full
reload removes that footgun entirely.)

The `?url` suffix tells Vite to return the processed CSS file's URL instead of injecting it as a side effect. This gives you a stable, hashed asset path that works in both development and production.

## Customizing the Theme

Tailwind v4 uses CSS `@theme` for customization:

```css
/* src/index.css */
@import "tailwindcss";

@theme {
  --font-sans: "Inter", system-ui, sans-serif;
  --color-primary: #3b82f6;
  --color-secondary: #64748b;
  --breakpoint-3xl: 1920px;
}
```

## Dark Mode

Combine with the Rango theme system (see `/theme`):

```typescript
const router = createRouter({
  document: Document,
  urls: urlpatterns,
  theme: { attribute: "class" },
});
```

Then use Tailwind's `dark:` variant which reads the `class` attribute:

```tsx
<div className="bg-white dark:bg-slate-900 text-slate-900 dark:text-white">
  Content
</div>
```

## With Custom Fonts

Use `@fontsource-variable` for self-hosted fonts bundled by Vite (see `/fonts` for all options):

```bash
pnpm add @fontsource-variable/inter
```

```css
/* src/index.css */
@import "@fontsource-variable/inter";
@import "tailwindcss";

@theme {
  --font-sans: "Inter Variable", system-ui, sans-serif;
}
```

No extra `<link>` tags needed in the Document -- Vite bundles the font files from `node_modules` automatically.

## Notes

- `?url` import is required -- bare CSS imports inject styles as a side effect and do not work with SSR streaming
- `<link rel="preload" as="style">` eliminates render-blocking by starting the download early
- Tailwind v4 does not need a `tailwind.config.js` -- use `@theme` in CSS instead
- The `@tailwindcss/vite` plugin handles content detection automatically
