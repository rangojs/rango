# Several apps under createHostRouter()

One deployment, several independently routed apps: marketing on the apex
(`example.com`, `www.example.com`), the product on `app.`, the staff tools
on `admin.`, the docs on `docs.`. Each app is an ordinary `createRouter()`
app with its own `urls()`, Document and generated route map; the host router
only picks which one handles a request.

Reach for this when parts of the product want different documents, chrome,
deploy cadence or hostnames. Sections that share one document belong in one
router as `include()`s ([`./large-app.md`](./large-app.md)): a navigation
between apps is always a document load.

References in the router repository: `examples/cloudflare-multi-router` (a
Cloudflare host entry, path-mounted and host-mounted apps, a shared cache)
and `packages/rangojs-router/e2e/test-app/.host-fixture` (the Node preset,
the host-override cookie, two apps on one store).

## File tree

```
src/
  worker.rsc.tsx              the host router (Cloudflare: you own the entry)
  env.ts                      bindings shared by every app
  shared/
    document.tsx              "use client" Document the apps pass to createRouter()
    styles.css                one stylesheet (e.g. @import "tailwindcss")
    theme.ts                  one ThemeConfig
    cache.ts                  one cache store factory
    origins.ts                each app's origin, per environment
    top-nav.tsx               components every app renders
  apps/
    site/   router.tsx  handler.ts  urls.tsx  router.named-routes.gen.ts  tsconfig.json
    app/    router.tsx  handler.ts  urls.tsx  router.named-routes.gen.ts  tsconfig.json  …
    admin/  …
    docs/   …
tsconfig.json                 the host entry's program only
```

## The host router

```tsx
// src/worker.rsc.tsx
import {
  createHostRouter,
  defineHosts,
  isNoRouteMatchError,
} from "@rangojs/router/host";
import type { AppBindings } from "./env";

export const hosts = defineHosts({
  site: [".", "www.*"],
  app: "app.*",
  admin: "admin.*",
  docs: "docs.*",
});

// Dev: every app answers on localhost, and the x-rango-host cookie picks one
// (x-rango-host=admin.example.com). The request is forwarded unchanged.
const hostRouter = createHostRouter({
  hostOverride: { cookieName: "x-rango-host", allowedHosts: ["localhost"] },
});

// Lazy mounts: an app's module graph loads on its first request, and each app
// keeps its own cache version.
hostRouter.host(hosts.admin).lazy(() => import("./apps/admin/handler"));
hostRouter.host(hosts.app).lazy(() => import("./apps/app/handler"));
hostRouter.host(hosts.docs).lazy(() => import("./apps/docs/handler"));
hostRouter.host(hosts.site).lazy(() => import("./apps/site/handler"));
// localhost has one label: neither "." nor "*." matches it.
hostRouter.host(["localhost"]).lazy(() => import("./apps/site/handler"));

export default {
  async fetch(request, env, ctx) {
    try {
      return await hostRouter.match(request, { env, ctx });
    } catch (err) {
      if (isNoRouteMatchError(err))
        return new Response("Not Found", { status: 404 });
      throw err;
    }
  },
} satisfies ExportedHandler<AppBindings>;
```

Patterns are tried in registration order, first match wins; "apex" means
exactly two labels (no public-suffix list), so `example.co.uk` needs its own
pattern (`/host-router` → "Pattern Syntax").

On the `node` and `vercel` presets rango owns the entry: export the instance
(`export default hostRouter`), drop the `fetch` wrapper, and an unmatched host
answers 404 on its own. Point `rango({ hostRouter: "./src/worker.rsc.tsx" })`
at the module when auto-detection cannot pick it.

## Each app

```ts
// src/apps/app/handler.ts: what the host router's lazy mount imports
import { router } from "./router";

export default (request: Request, input: any) => router.fetch(request, input);
```

```tsx
// src/apps/app/router.tsx
import { createRouter } from "@rangojs/router";
import { Document } from "../../shared/document";
import { appCache } from "../../shared/cache";
import { theme } from "../../shared/theme";
import type { AppBindings } from "../../env";
import { loadSession } from "./session";
import { appPatterns } from "./urls";

export const router = createRouter<AppBindings>({
  document: Document,
  cache: appCache,
  theme,
})
  .use(loadSession)
  .routes(appPatterns);
```

```tsx
// src/apps/app/urls.tsx
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { TopNav } from "../../shared/top-nav";
import { DashboardPage, LoginPage } from "./pages";
import { requireUser } from "./session";

function Shell() {
  return (
    <>
      <TopNav />
      <Outlet />
    </>
  );
}

export const appPatterns = urls(({ path, layout, middleware }) => [
  path("/login", LoginPage, { name: "login" }),
  layout(Shell, () => [
    middleware(requireUser),
    path("/", DashboardPage, { name: "dashboard" }),
    // … the app's sections as includes, as in ./large-app.md
  ]),
]);
```

Inside an app, everything in the other recipes applies unchanged: the `app.`
app is [`./large-app.md`](./large-app.md) without its marketing pages, the
`docs.` app is [`./content-site.md`](./content-site.md), and `site` is a
handful of `ppr` pages:

```tsx
// src/apps/site/urls.tsx (excerpt)
export const sitePatterns = urls(({ path, layout }) => [
  layout(SiteLayout, () => [
    path("/", Home, { name: "home", ppr: true }),
    path("/pricing", Pricing, { name: "pricing", ppr: true }),
  ]),
]);
```

## What is shared, and how

| Shared        | How                                                                                            | Notes                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Components    | ordinary imports from `src/shared/`                                                            | One Vite build and one client manifest: a shared client component ships as the same hashed asset to every app. Keep route-name-typed calls (`ctx.reverse("…")`, `href()`) out of shared code; each app's names are its own. |
| The Document  | one `"use client"` component every `createRouter({ document })` passes, or one per app         | Each document load is that app's own; apps may differ freely                                                                                                                                                                |
| CSS           | `import styles from "../../shared/styles.css?url"` in the Document, `<link precedence>`        | Compiles to one hashed asset, cached across apps. Apps need not agree on `precedence`: a cross-app navigation is a document load (`/css`)                                                                                   |
| Theme         | one `ThemeConfig` object passed as `theme` to every router                                     | The stored choice is a host-only cookie (`src/theme/ThemeProvider.tsx`, no `Domain`), so a theme picked on `app.` does not follow the user to `docs.`                                                                       |
| Cache store   | one factory (`cache: appCache`), one KV namespace                                              | Keys holding one router's output start with that router's id, so two apps never read each other's shells, records or loader entries. Keep `createRouter({ ... })` an inline object literal (or pass `id`) so ids are stable |
| Session       | a cookie on the parent domain, `cookies().set("session", token, { domain: "example.com", … })` | Set by the app that signs users in; every app resolves it in its own `router.use()`                                                                                                                                         |
| Client caches | not shared                                                                                     | The state cookie is `rango-state_{routerId}`, one per app, so sibling apps on one origin do not collide                                                                                                                     |

## TypeScript: one program per app

Every router's `router.named-routes.gen.ts` augments the one global
`Rango.GeneratedRouteMap`, so two apps with overlapping route names
(`home`, `login`) collide in one program. Give each app its own
`tsconfig.json`, and keep the root program to the host entry:

```jsonc
// tsconfig.json: the host entry only
{ "extends": "./tsconfig.base.json", "include": ["src/env.ts", "src/worker.rsc.tsx"] }

// src/apps/app/tsconfig.json: one app, its generated map, the shared code
{ "extends": "../../../tsconfig.base.json", "include": ["**/*", "../../shared/**/*", "../../env.ts"] }
```

The root program still type-checks the apps' source through the lazy
`import()`s, but not their generated maps, as long as no app source imports
its own `*.named-routes.gen.ts`. Run `tsc -p` for each program in CI.
Generated and committed: one `router.named-routes.gen.ts` per app (plus
per-module `*.gen.ts` where an app uses `useReverse(routes)`). See
`/typesafety` → multi-project setup.

## Dev: the host-override cookie

`vite dev` serves every app on one origin, `localhost`. The
`hostOverride` option picks the app from a cookie when the request's real
host matches `allowedHosts`:

```js
// browser devtools, on http://localhost:5173
document.cookie = "x-rango-host=admin.example.com; path=/";
```

Reload and the admin app answers; delete the cookie for the site. Without a
`fallback()`, a cookie the router refuses (a malformed hostname, a host not
in `allowedHosts`) answers 400 and clears the cookie. Playwright sets it with
`context.addCookies([{ name: "x-rango-host", value: "admin.example.com", url }])`,
which is how both reference apps run their dev and production e2e.

All apps answer under one origin in this mode, so links to another app's
production host leave the dev server; switch apps by changing the cookie.

## Links between apps

A navigation from one app to another is a full document load, by design. A
soft in-place swap between apps shipped once (#476) and was replaced by a
document navigation (#555): a stylesheet two apps share by `href` could drop
on the swap (React dedups stylesheets by `href`), and the theme, warmup and
prefetch settings, which are document-lifetime, would remount or never take
effect. A document load re-establishes the target app's whole document.

| The other app is                                               | Link with                                                                                         | What happens                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| On another host (`app.example.com`)                            | an absolute URL: `<Link to="https://app.example.com/">` or `<a href>`                             | Another origin is external to `<Link>` (`src/browser/react/Link.tsx`) and to the plain-anchor interceptor: the browser navigates, nothing is prefetched                              |
| On the same origin under a path (`host(["example.com/docs"])`) | `<Link to="/docs" reloadDocument prefetch="none">` or `<a href="/docs" data-no-intercept="true">` | A document navigation at the click. A plain same-origin `<Link>` also ends in a document load, after a wasted round trip: the server answers the partial request with `X-RSC-Reload` |

```tsx
// src/shared/origins.ts
export const ORIGINS = {
  site: import.meta.env.VITE_SITE_ORIGIN ?? "https://example.com",
  app: import.meta.env.VITE_APP_ORIGIN ?? "https://app.example.com",
  docs: import.meta.env.VITE_DOCS_ORIGIN ?? "https://docs.example.com",
} as const;

// src/shared/top-nav.tsx: a server component every app renders
import { Link } from "@rangojs/router/client";
import { ORIGINS } from "./origins";

export function TopNav() {
  return (
    <nav>
      <Link to={`${ORIGINS.site}/`}>Home</Link>
      <Link to={`${ORIGINS.docs}/`}>Docs</Link>
      <Link to={`${ORIGINS.app}/`}>Open the app</Link>
    </nav>
  );
}
```

`reloadDocument` alone does not stop the prefetch: without
`prefetch="none"`, a visible link still sends one, which the other app
answers with `X-RSC-Reload` and the client drops. Make each app's entry pages
fast as documents (`ppr`, or `Prerender`), since every cross-app click lands
on one.

## Deploys

Each `createRouter()` app has its own cache version, computed from the code
its router can run up to a lazy mount. A deploy that changes the admin app's
server code clears the admin app's cached data and stored HTML and reloads
its open tabs; the other apps keep theirs. Code shared by statically
importing modules moves every app that imports it (`/host-router` →
"Deploys and the cache").

## Why

| Choice                       | Why                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| One `createRouter()` per app | Own document, routes, names, middleware, cache version                                        |
| `.lazy()` mounts             | An app's graph loads on its first request, and the mount is where its cache version stops     |
| `defineHosts`                | One typed table of patterns, reused by tests                                                  |
| The cookie override in dev   | One dev origin, hydration same-origin; the reference apps' e2e drive every app through it     |
| Absolute URLs between hosts  | Another origin is another document; no request is wasted on a prefetch or a reload round trip |
| A program per app            | Route-name augmentations of different apps cannot collide                                     |
