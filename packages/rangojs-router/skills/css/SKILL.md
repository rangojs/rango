---
name: css
description: Import and apply CSS in a Rango app. Render document/app stylesheets in the Document `<head>` with Vite's `?url` import plus a `precedence`-managed `<link rel="stylesheet">` (React 19 resource model — deduped, ordered, loaded before paint). Use when wiring global/app CSS or a Document `<head>` stylesheet, or when deciding between `?url` + `<link>` and side-effect imports. Cross-app (host-router) navigation is a full document load, so each app's document CSS is always re-established by its own load.
argument-hint:
---

# CSS imports

Document/app CSS in Rango lives in the Document `<head>`, loaded with Vite's
`?url` import and a `precedence`-managed `<link rel="stylesheet">`. This page is
the why and the one cross-app caveat; `/tailwind` is the concrete setup, `/theme`
is dark mode, `/fonts` is fonts.

## The pattern

```tsx
// document.tsx
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
      <body>{children}</body>
    </html>
  );
}
```

- **`?url`** returns the processed file's hashed URL instead of injecting it as a
  side effect, giving a stable asset path that works in dev and production.
- **`precedence`** opts the `<link rel="stylesheet">` into React 19's managed
  stylesheet model: React de-duplicates it by `href`, orders it by precedence
  (any string value — it only decides cascade order relative to other managed
  sheets), and loads it **before paint**, so there is no flash of unstyled
  content. This is the recommended way to render a stylesheet link.

## Cross-app (host-router) navigation

You do **not** need to coordinate CSS across apps mounted under one host router.
A client-side navigation that crosses an app boundary is a **full document load**
(the server returns `X-RSC-Reload` on an app switch — see `/host-router`), so the
target app's entire document — its stylesheets, theme, meta — is re-established
by the target app's own load. Each app owns its document; how one app renders a
stylesheet has no effect on another.

(This replaced an earlier soft cross-app swap. Under it, a stylesheet shared
across apps by `href` — classically every app's `@import "tailwindcss"` compiling
to one hashed asset — could be silently dropped by React's by-`href` resource
dedup when the apps disagreed on `precedence` (one unmanaged, one managed). The
full reload removes that footgun entirely, which is the main reason cross-app
navigation is a hard boundary.)

## Side-effect imports vs `?url`

A bare `import "./index.css"` (no `?url`, no `<link>`) also produces _managed_ CSS
— `@vitejs/plugin-rsc` collects it via `import.meta.viteRsc.loadCss` and injects
it with a precedence. It is fine for **component-local** CSS that loads with its
client chunk. For **document-level** CSS, prefer the `?url` + `<link precedence>`
form above: a side-effect import is not guaranteed to be in the initial streamed
`<head>` (an SSR-streaming caveat), whereas the explicit `<link>` is.

## Related

- `/tailwind` — Tailwind v4 setup using this pattern.
- `/host-router` — multi-app routing; why cross-app navigation is a full reload.
- `/theme` — dark mode / theme attribute.
- `/fonts` — self-hosted fonts via `@fontsource`.
