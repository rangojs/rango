---
name: tailwind
description: Set up Tailwind CSS v4 with the Document component and CSS imports. Use when adding Tailwind CSS to a Rango app, or Tailwind classes aren't being applied or generated.
argument-hint: [setup]
---

# Tailwind CSS

Set up Tailwind CSS v4 in a Rango app: the Vite plugin, the CSS entry, loading
it from the Document with Vite's `?url` import, theme tokens, class-based dark
mode, and fonts. The general stylesheet pattern is explained in `/css`.

## Install

```bash
pnpm add -D tailwindcss @tailwindcss/vite
```

## Vite Plugin

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    rango(),
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

Import the CSS file with `?url` to get its hashed URL, then preload and link it
in `<head>`. Give the `<link rel="stylesheet">` a `precedence` prop so React 19
manages it as a resource: de-duped by `href`, ordered, and loaded before paint
(no flash of unstyled content).

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

The `?url` suffix tells Vite to return the processed CSS file's URL instead of
injecting it as a side effect, giving a stable, hashed asset path in both
development and production. A bare `import "./index.css"` also produces managed
CSS, but it is not guaranteed to be in the initial streamed `<head>`; prefer
`?url` + `<link precedence>` for document CSS (see `/css`).

For **host-router** apps (`/host-router`), navigating between apps is a full
document load, so each app's Tailwind stylesheet is loaded by its own Document;
there is nothing to coordinate across apps.

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

Combine with the Rango theme system (see `/theme`). With `attribute: "class"`
(the default) the theme script puts `class="dark"` or `class="light"` on
`<html>` before first paint; add `suppressHydrationWarning` to the Document's
`<html>` so React accepts that change:

```typescript
export const router = createRouter({
  document: Document,
  urls: urlpatterns,
  theme: { attribute: "class" },
});
```

Tailwind v4's `dark:` variant follows `prefers-color-scheme` by default. Point
it at the class instead, so the user's stored choice wins over the OS setting:

```css
/* src/index.css */
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));
```

Then use the `dark:` variant as usual:

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

- Use the `?url` import for the document stylesheet: a bare side-effect import is not guaranteed to be in the initial streamed `<head>` (see `/css`)
- `<link rel="preload" as="style">` starts the stylesheet download early
- Tailwind v4 does not need a `tailwind.config.js` -- use `@theme` in CSS instead
- The `@tailwindcss/vite` plugin handles content detection automatically
