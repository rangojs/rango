---
name: theme
description: Opt-in theme system with FOUC prevention for light/dark mode
argument-hint: [setup]
---

# Theme Support

Opt-in theme system with FOUC prevention.

## Enable

```typescript
import { createRouter } from "@rangojs/router/server";

// Simple - all defaults
const router = createRouter<Env>({
  document: Document,
  urls: urlpatterns,
  theme: true,
});

// Custom config
const router = createRouter<Env>({
  document: Document,
  urls: urlpatterns,
  theme: {
    defaultTheme: "system",      // "light" | "dark" | "system"
    themes: ["light", "dark"],
    attribute: "class",          // or "data-theme"
    storageKey: "theme",
  }
});
```

## Server (in loaders/middleware)

```typescript
import { createLoader, createMiddleware } from "@rangojs/router/server";

// In a loader
export const SettingsLoader = createLoader("settings", async (ctx) => {
  const currentTheme = ctx.theme;    // read from cookie
  return { theme: currentTheme };
});

// In middleware
export const themeMiddleware = createMiddleware(async (ctx, next) => {
  // Set theme based on user preference
  ctx.setTheme("dark");
  await next();
});
```

## Client

```tsx
"use client";
import { useTheme } from "@rangojs/router/theme";

function ThemeToggle() {
  const { theme, setTheme, resolvedTheme, systemTheme, themes } = useTheme();

  return (
    <select value={theme} onChange={(e) => setTheme(e.target.value)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  );
}
```

## Notes

- `<MetaTags />` auto-renders inline script for FOUC prevention
- Add `suppressHydrationWarning` to `<html>`
- Theme persists in localStorage + cookie (for SSR)
