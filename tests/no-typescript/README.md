# no-typescript

A minimal Rango app whose **hand-written source is 100% plain JavaScript** — no
hand-authored `.ts`/`.tsx`, no `tsconfig.json`, no `typescript` dependency. Its
purpose is to verify that `@rangojs/router` works without TypeScript, end to
end, in both dev and production.

The only TypeScript files are the **generated** route-types artifacts
(`*.gen.ts`), committed like in every other app:

- `src/router.named-routes.gen.ts` — emitted by the Vite plugin on dev/build;
  augments the global route-name types and exports `NamedRoutes`.
- `src/blog/urls.gen.ts` — emitted by `npx rango generate` for the `urls()`
  module; exports the local `routes` map consumed by `useReverse`.

A JS app never needs to import these for runtime named-route reverse to work:
`ctx.reverse("name", params)` resolves from the router's runtime route table.
The per-module `routes` map is imported only for client-side `useReverse`, and
Vite transpiles the `.ts` on import. `e2e/smoke.test.js` exercises both paths.

> Footgun fixed while building this app: `rango generate` used to overwrite a
> `.jsx`/`.js` source instead of writing a sibling `.gen.ts` (the gen-path
> regex matched only `.tsx?`). Fixed in
> `packages/rangojs-router/src/build/route-types/per-module-writer.ts` with a
> regression test.

## What it covers

A focused smoke test (`e2e/smoke.test.js`, run in **both dev and production**)
exercises the full feature surface from JS:

| Feature                                | Where                                                           |
| -------------------------------------- | --------------------------------------------------------------- |
| Routing / layouts / `Link`             | `src/router.jsx`, `components/AppLayout.jsx`                    |
| `include()` composition                | `src/blog/urls.jsx` mounted at `/blog`                          |
| Dynamic params                         | `/blog/:slug`, `/features/:slug`                                |
| Server actions (`"use server"`)        | `src/actions.js`, `components/Counter.jsx`                      |
| Loaders (`useLoader`)                  | `src/loaders.js`, `components/Metrics.jsx` (`/dashboard`)       |
| Revalidation                           | `revalidate()` on `/dashboard` (loader re-runs after an action) |
| Fetchable loaders (`useFetchLoader`)   | `components/FetchWidget.jsx` (`/fetch`)                         |
| Handles                                | `src/handles.js`, `BreadcrumbNav`, `ctx.use(...)`               |
| Location state (navigation)            | `Link state={[...]}` + `FeatureLoading`                         |
| Location state (action)                | `ctx.setLocationState(...)` + `Flash` (`/flash`)                |
| Named-route reverse (server)           | `ctx.reverse(...)` in `src/pages/about.jsx`                     |
| `useReverse` (client, generated `.ts`) | `BlogReverseNav` imports `blog/urls.gen.ts`                     |
| `transition()` (same-route SWR)        | `/features/:slug` + sibling-nav assertion                       |

## Commands

```bash
pnpm dev          # vite dev
pnpm build        # vite build
pnpm preview      # vite preview (production)
pnpm test:e2e     # full Playwright run (dev + production)
pnpm test         # dev project only
```

## Regenerating route types

```bash
npx rango generate src/router.jsx src/blog/urls.jsx
```
