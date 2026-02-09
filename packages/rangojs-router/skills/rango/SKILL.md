---
name: rango
description: Overview of @rangojs/router and available skills
argument-hint:
---

# @rangojs/router

Django-inspired RSC router with composable URL patterns, type-safe href, and server components.

## Skills

| Skill | Description |
|-------|-------------|
| `/router-setup` | Create and configure the RSC router |
| `/route` | Define routes with `urls()` and `path()` |
| `/layout` | Layouts that wrap child routes |
| `/loader` | Data loaders with `createLoader()` |
| `/middleware` | Request processing and authentication |
| `/intercept` | Modal/slide-over patterns for soft navigation |
| `/parallel` | Multi-column layouts and sidebars |
| `/caching` | Segment caching with memory or KV stores |
| `/document-cache` | Edge caching with Cache-Control headers |
| `/theme` | Light/dark mode with FOUC prevention |
| `/links` | URL generation: ctx.href, href, useHref, useMount, scopedHref |
| `/hooks` | Client-side React hooks |
| `/typesafety` | Type-safe routes, params, href, and environment |
| `/host-router` | Multi-app host routing with domain/subdomain patterns |
| `/tailwind` | Set up Tailwind CSS v4 with `?url` imports |
| `/response-routes` | JSON/text/HTML/XML/stream endpoints with `path.json()`, `urls.json()` |
| `/mime-routes` | Content negotiation — same URL, different response types via Accept header |
| `/fonts` | Load web fonts with preload hints |

## Quick Start

```typescript
// urls.tsx
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout }) => [
  layout(RootLayout, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
  ]),
]);

// router.tsx
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls";

export default createRouter({ document: Document }).urls(urlpatterns);
```

Use `/typesafety` for type-safe href and environment setup.
