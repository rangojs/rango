# Rango

**A code-first, type-safe router for React Server Components.**

Your whole app is one route tree you can read top to bottom. Every route
has a name, and URLs are built from those names.

```tsx
// src/router.tsx
import { createRouter, urls } from "@rangojs/router";

const urlpatterns = urls(({ path, layout }) => [
  layout(<SiteLayout />, () => [
    path("/", HomePage, { name: "home" }),

    layout(<ShopLayout />, () => [
      path("/products", ProductList, { name: "products" }),
      path("/products/:slug", ProductPage, { name: "product" }),
    ]),
  ]),
]);

export const router = createRouter().routes(urlpatterns);
```

`SiteLayout` wraps every page and `ShopLayout` wraps only the shop. Each
renders its children through `<Outlet />`. A page is an async Server
Component whose params are typed by route name:

```tsx
// src/routes/product.tsx
import type { Handler } from "@rangojs/router";

export const ProductPage: Handler<"product"> = async (ctx) => {
  const product = await db.products.find(ctx.params.slug); // slug: string
  return <ProductView product={product} back={ctx.reverse("products")} />;
};
```

You don't register anything. The Vite plugin generates the route types, so a
misspelled route name or a missing param is a compile error.

As the app grows, you add to the same tree:

```tsx
cache({ ttl: 600 }, () => [
  path("/products/:slug", ProductPage, { name: "product" }, () => [
    loader(StockLoader), // stays live: runs on every request, even on a cache hit
  ]),
]),
path.json("/products/:slug", getProduct, { name: "productJson" }), // same URL, JSON for API clients
include("/account", () => import("./account"), { name: "account" }), // code-split
```

> **Pre-1.0:** Rango follows semver 0.x. Breaking changes land in minor
> releases and are listed in the
> [changelog](packages/rangojs-router/CHANGELOG.md). npm `latest` is the
> current release; `experimental` tracks `main`.

## What it gives you

- **One tree you can read.** `urls()`, `path()`, `layout()` and `include()`
  put URL structure, module boundaries and shared concerns in declared code,
  not filesystem conventions. Route modules can be mounted, renamed and
  lazy-loaded as units.
- **URLs built from names.** Route names, params and search schemas are
  checked wherever you build a URL: `ctx.reverse()`, `href()`,
  `useReverse()`. If a route module is mounted twice, its links resolve
  correctly for each mount.
- **Cached shell, live data.** `cache()`, `Prerender()` and `ppr` store the
  rendered UI. Loaders underneath keep running on every request, and you
  invalidate with tags (`updateTag("products")`) from the action that changed
  the data.
- **Server Actions that work without JavaScript.** Forms behave the same with
  and without client JS. `revalidate()` matches actions by reference, so
  renaming an action is a type error, not a silent stale page.
- **Layouts beyond nesting.** Parallel slots, intercepted routes (modals on
  soft navigation), `loading()` skeletons, and error or not-found boundaries
  are all part of the tree.
- **Pages and APIs in one router.** `path.json()`, `.text()`, `.xml()`,
  `.md()`, `.image()`, `.stream()` and `.any()` sit next to your pages, with
  `Accept`-based content negotiation, typed payloads, and RFC 9457 errors.
- **Testable at every layer.** `runLoader`, `runMiddleware` and
  `renderHandler` test pieces in isolation. `parityDescribe` runs one e2e
  body against both dev and production builds, and `expectParity` checks
  JS and no-JS give the same result.
- **Built-in diagnostics.** `ctx.debugPerformance()` gives you a per-request
  waterfall and `Server-Timing` headers. The package ships about 50
  [agent skills](packages/rangojs-router/skills/rango/SKILL.md) so coding
  agents learn the API from the version you installed.

## Get started

```bash
pnpm create rango my-app
```

Pick a target with `--template basic` (Node), `--template cloudflare`, or
`--template vercel`, and add `--js` for plain JavaScript. With npm, run
`npm create rango@latest my-app`. Requires Node.js 24 or newer.

Then read the **[package guide](packages/rangojs-router/README.md)**. It
builds a small shop step by step and covers the core API along the way.

## Learn more

- [Package guide](packages/rangojs-router/README.md): the step-by-step tour
  plus the reference tables
- [Why Rango](packages/rangojs-router/docs/why-rango.md): the reasoning
  behind each design decision
- [Rango vs Next.js, TanStack Start and Waku](packages/rangojs-router/skills/comparison/references/framework-comparison.md)
- [Agent skills catalog](packages/rangojs-router/skills/rango/SKILL.md): one
  guide per feature, written for coding agents and readable by people
- [Examples](examples/): Cloudflare and Vercel apps, including multi-app host
  routing

## Developing this repository

Prerequisites: Node.js 24 (see `.nvmrc`) and pnpm 11 (`packageManager` is
pinned).

```bash
pnpm install
pnpm build
pnpm dev
```

```
.
├── packages/rangojs-router/   # @rangojs/router, its unit tests and e2e apps
├── tests/                     # Consumer apps that use the published API
├── examples/                  # Cloudflare and Vercel example apps
├── apps/docs/                 # Documentation site
├── docs/                      # Design documents
└── tools/                     # Repo checks and bundle tooling
```

| Script                     | Purpose                                       |
| -------------------------- | --------------------------------------------- |
| `pnpm dev`                 | Run the dev servers                           |
| `pnpm build`               | Build all packages                            |
| `pnpm build-router`        | Build only `@rangojs/router`                  |
| `pnpm typecheck`           | Type-check every package                      |
| `pnpm test:unit:all`       | Unit and Flight tests for every package       |
| `pnpm test:e2e`            | Playwright suites                             |
| `pnpm lint`, `pnpm format` | oxlint and oxfmt checks (`format:fix` to fix) |

Router debug logging is off by default. `INTERNAL_RANGO_DEBUG=1 pnpm dev`
turns on structured server and browser logs, tagged with request and
transaction ids.

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md) for the
pre-push checks. Report security issues through [SECURITY.md](./SECURITY.md),
not the public issue tracker.

## License

[MIT](./LICENSE)
