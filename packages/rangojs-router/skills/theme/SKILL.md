---
name: theme
description: Opt-in light/dark theme system with FOUC prevention, server-side theme access, and a useTheme() hook. Use when adding a light/dark mode toggle, reading or setting the theme in handlers or middleware, or when the page flashes the wrong theme on load (FOUC).
argument-hint: [setup]
---

# Theme Support

Opt-in theme system. Enabling it gives you:

- an inline script (rendered by `<MetaTags />`) that applies the stored theme
  to `<html>` before first paint, so there is no flash of the wrong theme;
- `ctx.theme` / `ctx.setTheme()` in handlers and middleware;
- the `useTheme()` hook in client components (the provider is added for you).

The theme is stored in a cookie (so the server can read it) and in
localStorage.

## Enable

```typescript
import { createRouter } from "@rangojs/router";

// All defaults
export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  theme: true,
});

// Custom config (values shown are the defaults unless noted)
export const router = createRouter<AppBindings>({
  document: Document,
  urls: urlpatterns,
  theme: {
    defaultTheme: "system", // "light" | "dark" | "system"
    themes: ["light", "dark"],
    attribute: "class", // or any "data-*" attribute, e.g. "data-theme"
    storageKey: "theme", // cookie and localStorage key
    enableSystem: true, // resolve "system" via prefers-color-scheme
    enableColorScheme: true, // set style="color-scheme: ..." on <html>
    value: { dark: "theme-dark" }, // optional: attribute value per theme (not a default)
  },
});
```

With `attribute: "class"` the resolved theme is added as a class on `<html>`
(`<html class="dark">`); with a `data-*` attribute it is set as that
attribute's value (`<html data-theme="dark">`). `"system"` resolves to
`"light"` or `"dark"` before it is applied. With `enableSystem: false`,
`"system"` is not a valid theme and a `"system"` default falls back to the
first entry in `themes`.

## Document requirements

- Render `<MetaTags />` in `<head>`: it emits the FOUC-prevention script
  first, before the meta tags. The default Document already does this.
- Add `suppressHydrationWarning` to `<html>`: the script changes its
  `class`/`style` before React hydrates.

```tsx
"use client";
import type { ReactNode } from "react";
import { MetaTags } from "@rangojs/router/client";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <MetaTags />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

A Document that does not render `<MetaTags />` can place `<ThemeScript />`
from `@rangojs/router/theme` in `<head>` instead. It takes the resolved config
(`config: ResolvedThemeConfig`) and an optional `nonce`.

## Server (handlers and middleware)

`ctx.theme` is the stored theme, or `defaultTheme` when there is none.
`ctx.setTheme(theme)` sets the theme cookie on the response; invalid values
are rejected with a console warning. Both are typed optional because they only
exist when `theme` is configured.

```typescript
import type { Middleware } from "@rangojs/router";

// In a handler
path("/settings", (ctx) => {
  const currentTheme = ctx.theme; // "light" | "dark" | "system" | undefined
  return <SettingsPage theme={currentTheme} />;
});

// In middleware: apply a theme chosen through a query param
export const themeFromQuery: Middleware = async (ctx, next) => {
  const requested = ctx.url.searchParams.get("theme");
  if (requested === "light" || requested === "dark") {
    ctx.setTheme?.(requested);
  }
  await next();
};
```

Loaders do not get `ctx.theme` or `ctx.setTheme`. A loader that needs the
theme reads the cookie directly (loaders run fresh on every request, so the
read is safe):

```typescript
import { cookies, createLoader } from "@rangojs/router";

export const ThemedLoader = createLoader(async () => {
  const theme = cookies().get("theme")?.value ?? "system"; // storageKey
  return loadThemedAssets(theme);
});
```

## Client

```tsx
"use client";
import { useTheme, type Theme } from "@rangojs/router/theme";

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme, themes } = useTheme();

  return (
    <label>
      Theme ({resolvedTheme})
      <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
        {themes.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}
```

`useTheme()` returns:

- `theme`: the stored setting (`"light" | "dark" | "system"`)
- `setTheme(theme)`: update the theme; writes the cookie and localStorage
- `resolvedTheme`: what is actually shown (`"system"` resolved)
- `systemTheme`: the current OS preference (`"light" | "dark"`)
- `themes`: the configured themes, with `"system"` first when `enableSystem` is on

`useTheme()` throws when `theme` is not enabled in `createRouter()`.

## Related

- `/tailwind`: pairing `attribute: "class"` with Tailwind's `dark:` variant
- `/css`: where document stylesheets go
- `/router-setup`: the Document component
