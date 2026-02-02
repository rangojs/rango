---
name: theme
description: Opt-in theme system with FOUC prevention for light/dark mode
argument-hint: [setup]
---

# Theme Support

Opt-in theme system with FOUC prevention.

## Enable

```typescript
// Simple - all defaults
const router = createRSCRouter<Env>({ theme: true });

// Custom config
const router = createRSCRouter<Env>({
  theme: {
    defaultTheme: "system",      // "light" | "dark" | "system"
    themes: ["light", "dark"],
    attribute: "class",          // or "data-theme"
    storageKey: "theme",
  }
});
```

## Server (route handlers)

```typescript
route("settings", (ctx) => {
  const current = ctx.theme;    // read from cookie
  ctx.setTheme("dark");         // set cookie
  return <Settings />;
});
```

## Client

```tsx
"use client";
import { useTheme } from "@rangojs/router/theme";

function ThemeToggle() {
  const { theme, setTheme, resolvedTheme, systemTheme, themes } = useTheme();
  return <button onClick={() => setTheme("dark")}>Dark</button>;
}
```

## Notes

- `<MetaTags />` auto-renders inline script for FOUC prevention
- Add `suppressHydrationWarning` to `<html>`
- Theme persists in localStorage + cookie (for SSR)
