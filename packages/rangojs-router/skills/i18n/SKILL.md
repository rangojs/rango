---
name: i18n
description: Locale-aware routing with `include("/:locale?", ...)`, locale resolution chains, and react-intl integration. Use when building a multi-language app, routes need a locale segment, or wiring up react-intl translations.
argument-hint: "[topic]"
---

# Internationalization (i18n) and Locale Routing

Rango doesn't ship an i18n module. The router gives you the URL primitives
(optional include prefixes, constraints, typed reverse) and you compose
them with whatever message library you use — `react-intl`, `lingui`,
`@formatjs/intl`, or hand-rolled.

This skill covers:

- Mounting routes under an optional locale prefix (`/`, `/en`, `/gb`)
- Constraining the prefix to a known locale set
- Resolving the active locale (URL → cookie → `Accept-Language` → default)
- Generating localized URLs via `reverse()` round-trip
- Wiring `react-intl` into an RSC route tree

## URL Shape: Optional Locale Prefix

Mount your localized routes under an optional include prefix so the
default locale lives at the bare URL and other locales get a prefix:

```typescript
// urls.tsx
import { urls } from "@rangojs/router";
import { menuRoutes } from "./menu";

export const urlpatterns = urls(({ include }) => [
  include("/:locale?", menuRoutes, { name: "menu" }),
]);
```

URLs that match:

| URL            | Matched route   | `ctx.params.locale` |
| -------------- | --------------- | ------------------- |
| `/`            | `menu.index`    | `undefined`         |
| `/en`          | `menu.index`    | `"en"`              |
| `/c/breads`    | `menu.category` | `undefined`         |
| `/en/c/breads` | `menu.category` | `"en"`              |

> **Constrain to known locales** when you want unknown locales to fall
> through to other routes (or 404) instead of being treated as a slug:
>
> ```typescript
> include("/:locale(en|gb|fr)?", menuRoutes, { name: "menu" });
> ```
>
> `/de` now 404s (constraint rejects `de`), and `/c/breads` continues to
> match `menu.category` with `locale: undefined`. Without the constraint,
> `/de` would match `menu.index` with `locale: "de"`.

## Reading the Locale in Handlers

Absent optionals are `undefined` (not `""`), so `??` coalesces correctly:

```typescript
import { Handler } from "@rangojs/router";

export const MenuIndex: Handler<"menu.index"> = (ctx) => {
  // ctx.params.locale is `string | undefined`
  const locale = resolveLocale(ctx);
  return <Welcome locale={locale} />;
};
```

The `resolveLocale` helper below implements a typical fallback chain.

## Locale Resolution

URL is the strongest signal but you usually want a fallback chain:

1. **URL prefix** — if the user navigates to `/gb/...`, honor it
2. **Cookie** — sticky preference set by a previous language switcher
3. **`Accept-Language`** — browser hint
4. **Default** — your app default

Put it in a small helper that every locale-aware handler calls:

```typescript
// lib/locale.ts
import { cookies, headers } from "@rangojs/router";

export const SUPPORTED_LOCALES = ["en", "gb", "fr"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
const DEFAULT_LOCALE: Locale = "en";

const isSupported = (v: string): v is Locale =>
  (SUPPORTED_LOCALES as readonly string[]).includes(v);

export function resolveLocale(ctx: {
  params: Record<string, string | undefined>;
}): Locale {
  const fromUrl = ctx.params.locale;
  if (fromUrl && isSupported(fromUrl)) return fromUrl;

  const fromCookie = cookies().get("locale")?.value;
  if (fromCookie && isSupported(fromCookie)) return fromCookie;

  const accept = headers().get("accept-language") ?? "";
  for (const tag of accept.split(",")) {
    const code = tag.split(";")[0].trim().split("-")[0];
    if (isSupported(code)) return code as Locale;
  }
  return DEFAULT_LOCALE;
}
```

If you want to redirect to the canonical URL when the resolved locale
doesn't match the URL (e.g., user has `gb` cookie but visits `/`), do
that in a global middleware so it covers actions too:

```typescript
import { redirect } from "@rangojs/router";

router.use("/*", async (ctx, next) => {
  const fromUrl = ctx.params.locale;
  const resolved = resolveLocale(ctx);
  if (resolved !== DEFAULT_LOCALE && !fromUrl) {
    return redirect(`/${resolved}${ctx.url.pathname}`);
  }
  await next();
});
```

## Generating Localized URLs

`reverse()` treats `undefined` and `""` for an optional param as "absent"
and collapses the segment cleanly. The round-trip is symmetric with the
matcher:

```typescript
ctx.reverse("menu.index", { locale: "" }); // → "/"
ctx.reverse("menu.index", { locale: undefined }); // → "/"
ctx.reverse("menu.index", { locale: "en" }); // → "/en"
ctx.reverse("menu.category", { locale: "en", slug: "breads" }); // → "/en/c/breads"
ctx.reverse("menu.category", { slug: "breads" }); // → "/c/breads"
```

If the active locale is the app default and your URL strategy hides it
(`"en"` → `/`, others → `/<locale>`), normalize before calling reverse:

```typescript
const normalized = locale === DEFAULT_LOCALE ? undefined : locale;
const href = ctx.reverse("menu.category", { locale: normalized, slug });
```

## react-intl Integration

`react-intl` needs a `<IntlProvider>` wrapping the tree, with `locale`
and `messages` props. The cleanest split: load messages on the server
(handler or layout), pass them through to a client provider component.

### Messages loader

Load message bundles per locale. Keep them server-side so they stream
through the RSC payload and don't bloat the client bundle:

```typescript
// lib/messages.ts
import type { Locale } from "./locale";

const loaders: Record<Locale, () => Promise<Record<string, string>>> = {
  en: () => import("../messages/en.json").then((m) => m.default),
  gb: () => import("../messages/gb.json").then((m) => m.default),
  fr: () => import("../messages/fr.json").then((m) => m.default),
};

export async function loadMessages(locale: Locale) {
  return loaders[locale]();
}
```

### Server layout: hand off to the client provider

```tsx
// layouts/intl-layout.tsx (server component)
import type { ReactNode } from "react";
import { resolveLocale } from "../lib/locale";
import { loadMessages } from "../lib/messages";
import { IntlClientProvider } from "../components/intl-client-provider";

export async function IntlLayout({
  ctx,
  children,
}: {
  ctx: any;
  children: ReactNode;
}) {
  const locale = resolveLocale(ctx);
  const messages = await loadMessages(locale);
  return (
    <IntlClientProvider locale={locale} messages={messages}>
      {children}
    </IntlClientProvider>
  );
}
```

### Client provider

```tsx
// components/intl-client-provider.tsx
"use client";

import { IntlProvider } from "react-intl";
import type { ReactNode } from "react";

export function IntlClientProvider({
  locale,
  messages,
  children,
}: {
  locale: string;
  messages: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <IntlProvider
      locale={locale}
      defaultLocale="en"
      messages={messages}
      onError={(err) => {
        if (err.code === "MISSING_TRANSLATION") return; // common, log only
        console.error(err);
      }}
    >
      {children}
    </IntlProvider>
  );
}
```

### Mounting

Wrap your localized routes with the layout:

```typescript
import { urls } from "@rangojs/router";
import { IntlLayout } from "./layouts/intl-layout";
import { menuRoutes } from "./menu";

export const urlpatterns = urls(({ layout, include }) => [
  layout(IntlLayout, () => [
    include("/:locale?", menuRoutes, { name: "menu" }),
  ]),
]);
```

`<FormattedMessage>`, `useIntl()`, etc. work in any client component
under the layout. Server components can use `formatjs`'s `createIntl()`
directly with the same `messages` map for static text.

## Common Pitfalls

| Pitfall                                                       | Fix                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ctx.params.locale === ""` returns `false`                    | Absent optionals are `undefined`, not `""`. Use `=== undefined` or `??`.               |
| `ctx.params.locale ?? "en"` returns `""`                      | Pre-fix behavior. After the include-prefix fix this works correctly.                   |
| Bare `/` 404s when mounted via `include("/:locale?", routes)` | Requires the all-optional pattern fix in `compilePattern` (shipped).                   |
| Unknown locale (e.g. `/de`) matches as `locale: "de"`         | Add a constraint: `:locale(en\|gb\|fr)?`. Unknown values now 404.                      |
| Reverse produces `//c/breads` for absent locale               | `reverse()` collapses `undefined`/`""` segments — should not happen. File a bug.       |
| Locale switcher loses search params                           | Read `ctx.url.search` and pass to `reverse(..., undefined, parsedSearch)`.             |
| Action middleware can't read `ctx.params.locale`              | Route middleware doesn't wrap action execution. Use global `router.use()` for actions. |

## Cross-references

- `/route` — optional URL param syntax and runtime contract
- `/typesafety` — `RouteParams<"name">` typing for optionals
- `/middleware` — global vs route middleware scope (matters for actions)
- `/server-actions` — actions and the global-vs-route middleware boundary
- `/links` — `ctx.reverse()` and locale-aware URL generation
