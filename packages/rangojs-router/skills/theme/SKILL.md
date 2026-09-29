---
name: theme
description: Opt-in light/dark theme system with FOUC prevention, server-side theme access, and a useTheme() hook. Use when adding a light/dark mode toggle, reading or setting the theme in handlers or middleware, or when the page flashes the wrong theme on load (FOUC).
argument-hint: [setup]
---

# Theme Support

Opt-in theme system. Enabling it gives you:

- an inline script (rendered by `<Html.Meta />`) that applies the stored theme
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

- Render `<Html.Meta />` in `<head>`: it emits the FOUC-prevention script
  first, before the meta tags. The default Document already does this.
- Add `suppressHydrationWarning` to `<html>`: the script changes its
  `class`/`style` before React hydrates.

```tsx
"use client";
import type { ReactNode } from "react";
import { Html } from "@rangojs/router/client";

export function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Html.Meta />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

A Document that does not render `<Html.Meta />` can place `<ThemeScript />`
from `@rangojs/router/theme` in `<head>` instead. It takes the resolved config
(`config: ResolvedThemeConfig`) and an optional `nonce`.

## Server (handlers and middleware)

`ctx.theme` is the stored theme, or `defaultTheme` when there is none.
`ctx.setTheme(theme)` sets the theme cookie on the response; invalid values
are rejected with a console warning. Both are typed optional because they only
exist when `theme` is configured.

`ctx.theme` is the visitor's theme cookie, so a handler reads it only on a
route whose output is rendered per request:

```typescript
import type { Middleware } from "@rangojs/router";

// In a handler on a route without ppr or cache()
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

### On `ppr` and `cache()` routes

A `ppr` shell and a `cache()` entry are shared by every visitor, so a handler
there must not read the visitor's theme. `ctx.theme` (handler and middleware)
and `getRequestContext().theme` are guarded like `cookies()`:

| Where the theme is read                                    | What happens                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| a handler on a `ppr` route                                 | The shell capture is refused (warned once per URL); every request stays a MISS                        |
| inside a `cache()` boundary                                | Throws on a cache miss, like `cookies()`                                                              |
| inside a `"use cache"` function (handler or middleware)    | Throws; read it outside and pass it in as an argument                                                 |
| after `ctx.dynamic()` on `ppr`                             | Allowed: that render is never captured                                                                |
| middleware `ctx.set()` of the theme, read by a handler     | Not guarded: the first visitor's theme bakes into the shell or `cache()` entry, like a session object |
| a route with no `ppr` or `cache()` above it, or middleware | Allowed: rendered per request                                                                         |

The theme getters are read-only and non-enumerable: `{ ...ctx }` and
`Object.assign({}, ctx)` do not carry `theme`, and assigning it throws.

`ctx.setTheme()` throws in a handler on these routes too, like any response
write there; call it from middleware.

Read the theme where it is per request instead:

- `useTheme()` in a client component. The `<html>` class is right before
  paint (the theme script sets it). On a `ppr` HIT the shell carries the
  no-cookie default (`defaultTheme`), whoever captured it: a visitor with no
  stored theme sees the default, and one with a stored theme sees it after
  hydration.
- A live loader (no `ssr: false`). Loaders do not get `ctx.theme` or
  `ctx.setTheme`; read the cookie directly. A live loader runs on every
  request, HITs included, and on a `ppr` route needs `loading()` or an inline
  `<Suspense>` above its reader. A bake-lane loader (`ssr: false`) runs at
  capture, where this `cookies()` read refuses the capture.

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
