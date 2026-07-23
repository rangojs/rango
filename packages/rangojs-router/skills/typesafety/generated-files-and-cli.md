# Generated Files and CLI Setup

## Router Setup

```typescript
// router.tsx
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls";

const router = createRouter<AppBindings>({
  document: Document,
}).routes(urlpatterns);

// Server-side named-route reverse (type-safe via routeMap)
export const reverse = router.reverse;

export default router;
```

### Which global type should I use?

Use the generated route map by default. Manual `RegisteredRoutes` augmentation
is only needed when you want the richer `typeof router.routeMap` shape
available globally.

- `GeneratedRouteMap` — auto-registered by `router.named-routes.gen.ts`
  Use for `Handler<"name">` (type annotation), `Prerender<"name">(...)` (function
  call with type arg for param inference), server `ctx.reverse()`, and
  named-route param/search inference.
- `typeof router.routeMap` — the real merged route map from your router
  instance, including response-route metadata such as `{ path, response }`.
- `RegisteredRoutes` — manual global hook for exposing `typeof router.routeMap`
  to global utilities that need the exact router-builder map, especially
  `Rango.PathResponse`.

### Generated Route Type Surfaces

There are three distinct typing surfaces. They are **not** interchangeable —
pick the one that matches what you need to type:

| Surface             | Source                                               | Scope  | Gives                                    | Does not give                                                                                    |
| ------------------- | ---------------------------------------------------- | ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GeneratedRouteMap` | `router.named-routes.gen.ts` (auto)                  | global | route names, path params, search schemas | response/MIME payloads                                                                           |
| `routes`            | per-module `*.gen.ts` (`rango generate`)             | local  | local names, params, search              | the global app map                                                                               |
| `RegisteredRoutes`  | manual `extends` of a `typeof router.routeMap` alias | global | paths, params, **response payloads**     | the `Handler`/`Prerender` default (those read `GeneratedRouteMap` to avoid a `router.tsx` cycle) |

Key consequence: `href()` and the ambient `Rango.Path` type are typed from
whichever map is present — they prefer `RegisteredRoutes` when you wire it, otherwise fall back to
the auto-generated `GeneratedRouteMap`, so **`rango generate` alone gives you
path-checked `href()`** with no manual augmentation. Response and MIME payload
inference is the exception: it comes only from `typeof router.routeMap` (via
`RegisteredRoutes`), because `GeneratedRouteMap` carries paths + search but no
payloads — so `Rango.PathResponse` resolves to `never` until you wire
`RegisteredRoutes`.

Recommended setup:

```typescript
// router.tsx
import { createRouter } from "@rangojs/router";
import { urlpatterns } from "./urls";
import type { AppBindings, AppVars } from "./env";

export const router = createRouter<AppBindings>({}).routes(urlpatterns);

// The alias is required: an interface heritage clause cannot take a `typeof`
// type query directly (TS1109).
type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVars {}
    interface RegisteredRoutes extends AppRoutes {}
  }
}
```

### Single-App Setup Checklist

For one app, keep the ambient types, generated named-routes file, and router
instance in the same TypeScript program:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "noEmit": true,
  },
  "include": ["src"],
  "files": ["src/router.tsx"],
}
```

Then generate the route types from the router file:

```bash
npx rango generate src/router.tsx
```

This creates `src/router.named-routes.gen.ts`, which augments
`Rango.GeneratedRouteMap`. Keep that generated file committed with the router
source. The `files` entry keeps `router.tsx` in the program even when nothing
imports it directly, so `Rango.Env`, `Rango.Vars`, and optional
`Rango.RegisteredRoutes` augmentation are visible to handlers, loaders, actions,
and client helpers.

### Named Routes, `$$routeNames`, And `router.routeMap`

There are two runtime/type surfaces with similar names:

- `router.named-routes.gen.ts` exports `NamedRoutes` and augments
  `Rango.GeneratedRouteMap`. The Vite plugin imports that file internally and
  injects it as `$$routeNames` so `router.reverse` has the static route-name map.
  App code should not pass or import `$$routeNames` directly.
- `router.routeMap` is the public router instance property for type extraction.
  Use `typeof router.routeMap` when augmenting `Rango.RegisteredRoutes` for
  global response payload helpers such as `Rango.PathResponse`.

Do not document or use a public `router.routeNames` API unless one is
intentionally added. Today, the public extraction surface is `router.routeMap`;
the generated file and `$$routeNames` are build machinery.

### Typecheck cost when composing many include modules

`urls()` infers a route registry from everything in its array — including the
module types behind every `include()` thunk, recursively. In an app composing
MANY include modules (dozens of groups, or factory-produced groups), that
inference chain can explode: measured on a 26k-route app with 50 nested
include modules, root inference hit 4.05M type instantiations / 20 s check
time; the same app checks at ~140k / 3.6 s after widening.

The fix is to annotate the intermediate modules' exports with the wide
`UrlPatterns` type, which stops per-route literal types from propagating
upward:

```typescript
import { urls, type UrlPatterns } from "@rangojs/router";

export const shopPatterns: UrlPatterns<any> = urls(({ path }) => [
  // ...hundreds of routes
]);
export default shopPatterns;
```

Nothing is lost: named-route typing (`Handler<"name">`, `ctx.reverse`,
`href`) comes from the generated `router.named-routes.gen.ts`, not from the
inferred `urls()` type. Keep full inference on modules whose
`Rango.PathResponse` payloads you assert (e.g. `path.json` response routes);
widen the big mechanical groups. Use `UrlPatterns<any>` (not
`UrlPatterns<unknown>` — `unknown` env breaks handler assignability).
Diagnose with `tsc --extendedDiagnostics` and watch the Instantiations count.

## Multi-Project tsconfig Setup

For monorepos or multi-app setups, each app should have its own TypeScript
program. Do not typecheck two Rango apps with different `Rango.Env`,
`Rango.Vars`, or `Rango.RegisteredRoutes` declarations in one tsconfig, because
ambient global interfaces merge across the whole program.

### Multiple routers in one program

`Rango.GeneratedRouteMap` is a **single global interface**. Each router's
generated `router.named-routes.gen.ts` augments it, so two routers in the **same
TS program** that define overlapping route names (e.g. both have a `home`) make
the augmentations collide:

```text
Interface 'GeneratedRouteMap' cannot simultaneously extend ...
Named property 'home' ... are not identical.
```

This is the multi-router / host-router case. Resolve it by:

- **Separate TS programs** — give each router its own tsconfig (as below) so only
  one generated map is in scope per program. Recommended.
- **Unique route-name prefixes** — name routes per router (`appA.home`,
  `appB.home`) so the merged global map has no duplicate keys.

A single global generated map is a single-router convenience; global named-route
typing across multiple routers in one program is not supported today (it would
need per-router scoping in the generated map).

Use a shared base tsconfig for common compiler options, then make every app
tsconfig include its own source tree, its own `router.tsx`, and the generated
`router.named-routes.gen.ts` that lives beside that router.

```jsonc
// tsconfig.base.json (root)
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
  },
}
```

```jsonc
// apps/shop/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "files": ["src/router.tsx"],
}
```

```jsonc
// apps/blog/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "files": ["src/router.tsx"],
}
```

Run generation per app:

```bash
npx rango generate apps/shop/src/router.tsx
npx rango generate apps/blog/src/router.tsx
```

If an app has multiple tsconfigs (`tsconfig.app.json`, `tsconfig.test.json`,
`tsconfig.worker.json`), every tsconfig that typechecks Rango handlers,
components, loaders, actions, or client navigation must see the same app-local
type surfaces:

```jsonc
// apps/shop/tsconfig.test.json
{
  "extends": "./tsconfig.json",
  "include": ["src", "tests"],
  "files": ["src/router.tsx"],
}
```

The `files` array ensures `router.tsx` is always included even if nothing
directly imports it. The generated `router.named-routes.gen.ts` is normally
covered by `include: ["src"]`; if a tsconfig uses a narrow `include`, add the
generated file explicitly. Each app gets its own typed environment and named
route map without interfering with other apps.

For response and MIME payload lookup in each app, augment `RegisteredRoutes`
inside that app's router file:

```typescript
// apps/shop/src/router.tsx
export const router = createRouter<ShopEnv>({ document: Document }).routes(
  urlpatterns,
);

type ShopRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface Env extends ShopEnv {}
    interface RegisteredRoutes extends ShopRoutes {}
  }
}
```

## Complete Type-Safe Setup

```typescript
// 1. env.ts - Environment types
export interface AppBindings {
  DB: D1Database;
  KV: KVNamespace;
}

export interface AppVariables {
  user?: { id: string; email: string; role: string };
}

// 2. urls.tsx - Route definitions with names
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout, loader }) => [
  path("/", HomePage, { name: "home" }),

  layout(<ShopLayout />, () => [
    path("/shop", ShopIndex, { name: "shop" }),
    path("/shop/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader),
    ]),
  ]),
]);

// 3. router.tsx - Create router and export reverse
const router = createRouter<AppBindings>({
  document: Document,
}).routes(urlpatterns);

// Register bindings and variables globally for implicit typing
declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
  }
}

export const reverse = router.reverse;
export default router;

// 4. Run `npx rango generate src/router.tsx` to generate
//    router.named-routes.gen.ts (auto-registers GeneratedRouteMap globally).
//    No manual RegisteredRoutes declaration is needed for named-route handlers,
//    ctx.reverse, prerender, href(), or Rango.Path. Add `RegisteredRoutes
//    extends AppRoutes` (an alias of typeof router.routeMap) when global
//    response payload helpers such as Rango.PathResponse need the richer
//    router.routeMap metadata.

// 5. loaders/*.ts - Type-safe loaders
export const ProductLoader = createLoader(async (ctx) => {
  // ctx.params: { slug: string }
  // ctx.get("user"): User | undefined  (from Rango.Vars)
  // ctx.env.DB: D1Database  (plain bindings from Rango.Env)
  return { product: await fetchProduct(ctx.params.slug) };
});

// 6. Server: ctx.reverse for named routes
path("/product/:slug", (ctx) => {
  return <Link to={ctx.reverse("shop")}>Back to Shop</Link>;
}, { name: "product" })

// 7. Client: useHref for mounted paths, href for absolute
"use client";
import { useHref, href, Link } from "@rangojs/router/client";
<Link to={href("/shop/product/widget")}>Widget</Link>
```
