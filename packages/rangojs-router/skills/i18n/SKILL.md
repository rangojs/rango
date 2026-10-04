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

// menu.tsx
export const menuRoutes = urls(({ path }) => [
  path("/", MenuIndex, { name: "index" }),
  path("/c/:slug", MenuCategory, { name: "category" }),
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
import type { Handler } from "@rangojs/router";
import { resolveLocale } from "../lib/locale";

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
export const DEFAULT_LOCALE: Locale = "en";

export const isSupported = (v: string): v is Locale =>
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
    if (isSupported(code)) return code;
  }
  return DEFAULT_LOCALE;
}
```

`cookies()` and `headers()` read the current request, so the helper works in
handlers, layouts, loaders, and middleware without passing the request in.

If you want to redirect to the canonical URL when the resolved locale
doesn't match the URL (e.g., user has `gb` cookie but visits `/`), do
that in global middleware (`router.use()`). Global middleware runs before
route matching, and its `ctx.params` come from its own pattern — not from
`include("/:locale?")` — so read the locale segment from the pathname:

```typescript
// router.tsx
import { redirect } from "@rangojs/router";
import { DEFAULT_LOCALE, isSupported, resolveLocale } from "./lib/locale";

router.use(async (ctx, next) => {
  if (ctx.request.method !== "GET") return next(); // leave actions alone
  const first = ctx.url.pathname.split("/")[1] ?? "";
  if (!isSupported(first)) {
    const resolved = resolveLocale({ params: {} }); // cookie → Accept-Language → default
    if (resolved !== DEFAULT_LOCALE) {
      const rest = ctx.url.pathname === "/" ? "" : ctx.url.pathname;
      return redirect(`/${resolved}${rest}${ctx.url.search}`);
    }
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
ctx.reverse("menu.category", { slug: "breads" }); // → "/c/breads" on an unprefixed request
```

`ctx.reverse()` auto-fills missing params from the current request, so the
last call returns `/en/c/breads` when the current URL is `/en/...`. That is
what you want for in-locale links; to leave the locale, pass it explicitly
(`{ locale: "fr" }`, or `undefined`/`""` for the bare default). Middleware and
response routes are the exception: their `ctx.reverse` fills nothing from the
request, so pass `locale` there explicitly.

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

A layout handler receives the handler context (not props) and renders its
children with `<Outlet />`. It sees the matched route's params, including
`locale` from the include below it:

```tsx
// layouts/intl-layout.tsx (server)
import type { Handler } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { resolveLocale } from "../lib/locale";
import { loadMessages } from "../lib/messages";
import { IntlClientProvider } from "../components/intl-client-provider";

export const IntlLayout: Handler = async (ctx) => {
  const locale = resolveLocale(ctx);
  const messages = await loadMessages(locale);
  return (
    <IntlClientProvider locale={locale} messages={messages}>
      <Outlet />
    </IntlClientProvider>
  );
};
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
under the layout. Server components and handlers can't use React context
providers from the client; call `createIntl({ locale, messages })` (from
`@formatjs/intl` or `react-intl`) directly with the same `messages` map for
server-rendered text.

## Common Pitfalls

| Pitfall                                                       | Fix                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ctx.params.locale === ""` returns `false`                    | Absent optionals are `undefined`, not `""`. Use `=== undefined` or `??`.                                           |
| Unknown locale (e.g. `/de`) matches as `locale: "de"`         | Add a constraint: `:locale(en\|gb\|fr)?`. Unknown values now 404.                                                  |
| Link meant for the default locale keeps `/en`                 | `ctx.reverse()` auto-fills the current `locale`. Pass `{ locale: undefined }` (or `""`) to drop it.                |
| Reverse produces `//c/breads` for absent locale               | `reverse()` collapses `undefined`/`""` segments — should not happen. File a bug.                                   |
| Locale switcher loses search params                           | Append `ctx.url.search` to the reversed URL, or pass `Object.fromEntries(ctx.searchParams)` as the third argument. |
| Global middleware's `ctx.params.locale` is always `undefined` | Global middleware params come from its own pattern. Parse the first path segment (see "Locale Resolution").        |
| Route middleware doesn't see actions                          | Route middleware doesn't wrap action execution. Use global `router.use()` for action-time locale logic.            |

## Cross-references

- `/route` — optional URL param syntax and runtime contract
- `/typesafety` — `RouteParams<"name">` typing for optionals
- `/middleware` — global vs route middleware scope (matters for actions)
- `/server-actions` — actions and the global-vs-route middleware boundary
- `/links` — `ctx.reverse()` and locale-aware URL generation
