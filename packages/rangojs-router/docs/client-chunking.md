# Client Chunking: how the browser bundle is split, and how to reduce it

This guide explains how `@rangojs/router` splits your client (`"use client"`)
components into browser chunks, what ships on first load, and the levers for
shrinking the client bundle of a given route.

## TL;DR

- **Per-route client splitting is ON by default**: `rango()` groups your
  `"use client"` components by route id, so visiting `/a` does not download `/b`'s
  client code. Opt out with `rango({ clientChunks: false })`. (The cost-side
  benchmark backing this default is in "When is splitting worth it?" below.)
- The default is **safe because it only splits where it recognizes a route
  structure**. Three branches:
  - **Structured route dirs** (`routes/<id>/…`, `app/<id>/…`, `handlers/<id>/…`, …)
    → split into a per-route chunk `app-<id>` (+ its CSS). Under an `app/`
    source root, `app/routes/<id>/…` also becomes `app-<id>`.
  - **Flat `src/components/…`** (no route structure) → **stays shared**: one app
    chunk, exactly as if splitting were off. No change for flat apps.
  - **Host sub-apps** loaded via a dynamic `import()` → already split per app by
    their server boundary; the default leaves that untouched (no cross-app merge).
  - A **custom `clientChunks` function** fully overrides all of the above.
- A group is the **loading unit**: rendering any member downloads the whole
  group's chunk. `DEBUG=rango:chunks` logs each group's size at build end.
- React (~115 KB gzip) and the Rango runtime (~50 KB gzip) are shared on every
  route regardless. Splitting only moves **route-specific** client code, so it
  helps most when routes carry material client weight (editors, charts, grids).

## How chunking works

Rango builds on `@vitejs/plugin-rsc`. Client (`"use client"`) modules become
_client references_. The granularity of client chunks is determined by one rule:

> **Client-chunk granularity == RSC/server-chunk granularity == dynamic-`import()`
> boundary granularity of your server module graph.**

A router defines its routes in one module graph that is statically imported from
a single server entry, so the RSC build produces one server chunk for it, and all
its client references collapse into **one** client chunk. There is no per-route
boundary unless you introduce one.

What lands where in a production build:

| Chunk            | Contents                                                     | Shared?                        |
| ---------------- | ------------------------------------------------------------ | ------------------------------ |
| `react-*.js`     | React, react-dom, the RSC client runtime                     | yes (all routes, all sub-apps) |
| `router-*.js`    | the `@rangojs/router` browser runtime (~50 KB gzip)          | yes                            |
| app client chunk | **all** your `"use client"` components, one chunk by default | per-router                     |
| `*.css`          | one combined stylesheet for the app client chunk by default  | per-router                     |

Host sub-apps (via `createHostRouter().host(...).lazy(() => import("./app/handler.js"))`)
each get their **own** app client chunk because the dynamic `import()` is a real
server-graph boundary. There is no cross-app leakage: app A's bundle never
contains app B's components.

## Splitting a single router per route

### Option 1 — the default (built-in route strategy) + route colocation

The built-in directory strategy is **on by default** — plain `rango()` already
applies it. (`rango({ clientChunks: true })` is the explicit, equivalent form;
`rango({ clientChunks: false })` opts out.)

```ts
// vite.config.ts
import { rango } from "@rangojs/router/vite";

export default defineConfig({
  plugins: [rango()], // per-route client splitting is already on
});
```

To benefit, colocate each route's client components under a directory named for
the route:

```
src/
  routes/
    dashboard/
      Chart.tsx               // -> chunk "app-dashboard-*.js" + its CSS
      chart.css
      components/
        Legend.tsx            // -> ALSO "app-dashboard" (route id, not "components")
    settings/
      Form.tsx                // -> chunk "app-settings-*.js" + its CSS
      components/
        Field.tsx             // -> ALSO "app-settings"
  components/
    Button.tsx                // no route marker -> stays in the shared chunk
```

`clientChunks: true` groups each app `"use client"` module by its **route id**.
It looks for a route-root directory in the path — one of `routes`, `route`,
`pages`, `page`, `app`, `features`, `feature`, `views`, `view`, `handlers`,
`urls`, `modules`, `screens`, `sections` — and keys the chunk on **the segment
immediately after it**. So everything under `routes/dashboard/…`, at any nesting
depth, lands in `app-dashboard` — including a nested `routes/dashboard/components/`.
This is deliberate: two routes can each have a `components/Legend.tsx` without
colliding into one `app-components` chunk (which would re-introduce cross-route
leakage). The chunk loads only when a dashboard route renders; visiting
`/settings` does not download it. CSS splits at the same granularity
(`app-dashboard-*.css`).

The **first** marker directory in the path wins (the match is
case-insensitive), with one exception for `app/`. Many projects use `app/` as
their source root (`app/components`, `app/routes/<id>`), while others use it as
a Next-style route root (`app/<segment>/…`). When `app/` is directly followed by
another marker that has a directory after it, `app/` is treated as a source
root and the inner marker keys the group. Otherwise `app/` is the route root, as
before:

| Path                                    | Group            |
| --------------------------------------- | ---------------- |
| `app/routes/dashboard/Chart.tsx`        | `app-dashboard`  |
| `app/features/auth/LoginForm.tsx`       | `app-auth`       |
| `src/app/routes/cart/Cart.tsx`          | `app-cart`       |
| `src/routes/cart/Cart.tsx`              | `app-cart`       |
| `src/pages/cart/Cart.tsx`               | `app-cart`       |
| `app/dashboard/widgets/Chart.tsx`       | `app-dashboard`  |
| `app/components/Header.tsx`             | `app-components` |
| `app/routes/Layout.tsx` (no route dir)  | `app-routes`     |
| `app/routes/products.$id.tsx`           | `app-routes`     |
| `app/app/routes/x/W.tsx`                | `app-routes`     |
| `routes/view/edit/Form.tsx` (not `app`) | `app-view`       |
| `app/routes/cart/X.tsx`                 | `app-cart`       |
| `app/features/cart/Z.tsx`               | `app-cart`       |
| `app/routes/components/C.tsx`           | `app-components` |

Through 0.19.1, `app/routes/dashboard/Chart.tsx` grouped as `app-routes`, so
every route under `app/routes/` shared one chunk (#1022).

The same route id under different markers is **one group**, and the group is
the loading unit. `app/routes/cart/`, `app/features/cart/` and
`src/routes/cart/` all become `app-cart` (through 0.19.1 the first two were
`app-routes` and `app-features`), so rendering a component from any of them
downloads all three. A route folder named `components` (`app/routes/components/`)
joins the shared `app/components/` group. Rename the folder or use a
`clientChunks` function if that pooling is unwanted.

Files directly in `app/routes/` (the React Router / Remix flat-file layout,
`app/routes/products.$id.tsx`) have no route directory after the marker, so they
still share one `app-routes` group and load as one unit. Use a `clientChunks`
function to split them per file. The deferral applies once: `app/app/routes/<id>/`
keys on the inner `app` and pools as `app-routes`.

`app/components/` is not followed by a marker, so it keeps its own
`app-components` group. That separates shared components from every route's
group. A path-only rule cannot tell `app/components/` under a source root from a
Next-style route folder named `components`, and returning `undefined` would not
help: the module would join the default `serverChunk` group, which for a router
that imports every route statically holds every other unmarked client module
too. If `app-components` mixes a small always-rendered header with heavy
components that only some routes use, move the heavy ones under their route
directory or name the group yourself with a `clientChunks` function.

A Next-style project whose top-level route folder is itself named after a marker
and holds subdirectories (`app/features/<sub>/…`) now groups by `<sub>`; a
`clientChunks` function keeps the old grouping. Run the debug namespace below to
confirm the grouping.

When the path has **no** route-root directory (e.g. a flat `src/components/`),
the strategy returns `undefined` and the module **inherits `@vitejs/plugin-rsc`'s
default grouping** — it folds into the shared app chunk, exactly as if splitting
were off. It is **not** forced into a parent-named `app-components` chunk: a
parent-dir fallback would merge unrelated modules across routes (and, worse, merge
every host sub-app's `components/Layout.tsx` into one chunk, re-introducing the
cross-app leakage the host split exists to prevent). Returning `undefined` is what
makes the default a true no-op for flat and host-split layouts.

React, the router runtime, and anything in `node_modules` always stay on the
shared grouping — they are never fragmented per route.

#### Seeing what split (and what didn't)

The route-root marker list is intentionally finite and conventional. A layout it
doesn't recognize (say `src/parts/<feature>/…`) silently inherits the shared
grouping — no error, no split. To make that observable, run a production build
with the `rango:chunks` debug namespace:

```sh
DEBUG=rango:chunks pnpm build
# rango:chunks split src/routes/dashboard/Chart.tsx -> app-dashboard
# rango:chunks shared src/parts/editor/Editor.tsx (no route-root marker; inherits default grouping)
# rango:chunks group app-dashboard: 3 client reference(s), 48211 B (14020 B gzip) -> assets/app-dashboard-Bx1.js
```

Every `"use client"` module the built-in strategy sees is logged with its group,
or with the reason it fell back to shared. At the end of the client build, one
`group` line per emitted group gives its client-reference count and the size of
the group's own chunk (React and the router runtime live in shared chunks and
are not counted). The `group` lines also cover groups named by a custom
`clientChunks` function or by the default grouping. A large group that an
always-rendered component belongs to is downloaded on every route; this is where
you see it. If your app code shows up as `shared`
when you expected a split, either colocate it under a marker directory or take
full control with a `clientChunks` **function** (next). Widening the built-in
marker list is deliberately **not** the configurability mechanism — the function
is, because it covers any layout without an ever-growing convention list.

### Option 2 — custom `clientChunks` function

For full control, pass a function. It receives each client reference module and
returns a group name (or `undefined` to keep the default grouping):

```ts
rango({
  clientChunks: ({ normalizedId }) => {
    // Group by the segment after "src/routes/<name>/".
    const m = normalizedId.match(/\/routes\/([^/]+)\//);
    return m ? `route-${m[1]}` : undefined; // undefined -> shared default group
  },
});
```

This is forwarded directly to `@vitejs/plugin-rsc`'s `clientChunks` option.

### Option 3 — dynamic `import()` of a sub-app (coarse boundary)

If you compose multiple apps through `@rangojs/router/host`, load each handler
with `.lazy(() => import("./apps/admin/handler.js"))`. Each app already splits
into its own client chunk with no extra configuration. Treat the dynamic
`import()` as the sanctioned "I want a separate chunk here" boundary.

### Option 4 — `React.lazy` for a heavy intra-route component

For a heavy component that is conditionally rendered _within_ a route (a modal, a
rich editor, a chart that appears on interaction), lazy-load it the standard way:

```tsx
"use client";
import { lazy, Suspense } from "react";
const HeavyEditor = lazy(() => import("./HeavyEditor.js"));

export function Panel() {
  return (
    <Suspense fallback={null}>
      <HeavyEditor />
    </Suspense>
  );
}
```

The dynamic `import()` puts `HeavyEditor` in its own chunk fetched only when it
renders — independent of `clientChunks` grouping.

## The shared-component rule

Every `"use client"` module maps to exactly **one** group, so there is never byte
duplication. A group is also the **loading unit**: `@vitejs/plugin-rsc` resolves
a client reference by importing its group's module, so rendering any one member
downloads the whole group's chunk, every other member included. A layout header
that sits in a group with 40 route-specific components brings all 40 to every
page. The only question is _which_ group a shared component lands in:

- Put genuinely shared client components **outside** route directories (e.g.
  `src/components/` or `src/shared/`) so they form one shared group loaded once.
- A component placed under `routes/dashboard/` but also rendered by `/settings`
  still works, but visiting `/settings` loads the whole `app-dashboard` chunk
  for it, not just that component. Hoist shared components to a shared
  directory.

## Error / not-found fallbacks: the `app-fallback` chunk

A `"use client"` component you register as an `errorBoundary` or `notFoundBoundary`
fallback is grouped into a dedicated **`app-fallback`** chunk, regardless of where
it lives:

```tsx
// router.tsx
import { ClientErrorFallback } from "./ClientErrorFallback.js"; // "use client"

errorBoundary(<ClientErrorFallback />); // -> app-fallback-*.js
notFoundBoundary(<NotFound />); //        -> app-fallback-*.js
```

Two reasons this is the right default, both of which matter most for the
**root/layout-level** boundaries that wrap large subtrees:

- **Chunk names that match reality.** Without this, a small fallback (a 1 KB error
  component is common) can be the alphabetically-first module in a large shared
  chunk, so rolldown names the whole chunk after it — a 487 KB `ErrorBoundary-*.js`
  that is really your theme. Pulling the boundary out lets that chunk be named after
  a real module.
- **Resilience.** The error UI must not be co-bundled with the very code it exists
  to catch failures for. As its own chunk it is decoupled: a failure in a route
  chunk does not take the fallback down with it.

It is also genuinely **off the happy path**: error/not-found fallbacks are resolved
server-side and only become client references when an error/404 is actually caught,
so `app-fallback` is fetched only when a fallback renders — never on a successful
navigation. (Suspense `loading()` skeletons are deliberately **not** grouped here:
they must paint immediately while content streams, so they stay eager.)

Both registration styles are covered: the route-tree `errorBoundary(<X/>)` /
`notFoundBoundary(<X/>)` helpers **and** the router-level `createRouter({
defaultErrorBoundary, defaultNotFoundBoundary, notFound })` options. The boundary
may also be a **handler function** and/or **wrap** the client component in server
providers (the common pattern — the boundary needs an Intl/theme provider the
unmounted layout would have supplied):

```tsx
createRouter({
  defaultErrorBoundary: ({ error }) => (
    <FallbackIntl locales={...}>
      <ThemedError error={error} /> {/* the "use client" boundary -> app-fallback */}
    </FallbackIntl>
  ),
});
```

The build invokes the handler with synthetic props (only to construct the JSX
tree — the inner components are not rendered) and walks it for the client
boundary.

Notes:

- A component used as **both** a fallback and normal route UI lands in
  `app-fallback` (one module, one group); keep dedicated fallback components
  separate to avoid pulling route UI onto the error path.
- This applies to the built-in strategy (`clientChunks: true`/default). A custom
  `clientChunks` function owns grouping entirely and is not refined.
- **Limit:** a boundary that picks a _different_ client component depending on the
  runtime error (a conditional that the synthetic build-time error doesn't take),
  or that needs a real render context to even return its tree, can't be resolved
  statically — it simply stays on the default grouping. Use a `clientChunks`
  function to force those into a group.

## CSS

CSS imported by a client component is collected per client-reference group and
emitted as a `<link rel="stylesheet">` with React's `precedence` attribute, so
React hoists and dedupes it. CSS therefore splits at the **same granularity as
JS**: one app chunk -> one combined stylesheet; per-route chunks -> per-route
stylesheets. Injection is driven by the RSC render, so only the CSS of the
components actually rendered on the current route is linked — no FOUC, no
unrelated routes' CSS.

## When is splitting worth it? (measured)

On every route the browser already loads React (~115 KB gzip) and the Rango
runtime (~50 KB gzip); those are shared and unaffected. Splitting only moves your
**app-specific** client bytes. Here is the cost side, measured on a real app
(`tests/vite-rsc-demo`, 5 feature routes, ~33 KB gzip of app client code) built
both ways (`node tools/bench-client-chunks.mjs`):

| Metric                            | `clientChunks: false`            | default (on)                                    |
| --------------------------------- | -------------------------------- | ----------------------------------------------- |
| Shared runtime (every route)      | 95 KB gz                         | 95 KB gz (identical)                            |
| App code on **every first paint** | **38.3 KB** (one combined chunk) | **13–19 KB** (residual + this route's group)    |
| Per-route first-load saving       | —                                | **20–25 KB gz (~51–66% of app bytes)**          |
| First-load requests               | shared + 1 app chunk             | shared + 1 group = **+1 request** (multiplexed) |
| Total client JS (whole app)       | 134 KB                           | 141 KB (**+5%** fragmentation overhead)         |

Read this as three navigation patterns:

- **Land on one route (the common case): split wins.** You download only that
  route's client code, not every route's — here ~20–25 KB less, more on a bigger
  app.
- **A typical 1–3 route session: split wins.** After the first route the ~95 KB
  shared baseline is cached; each further route adds only its own small group.
- **A full cold crawl of _every_ route in one session: split costs ~5%.** That is
  the only case the +7 KB fragmentation overhead is fully paid, and it is not a
  realistic first-load.

**This is why the default scales.** The baseline's every-route app chunk grows
with your **total** app client code; the split's per-route first-load grows only
with **one** route's code. The larger the app — and the smaller the fraction of it
any single user visits — the bigger the win and the more wasteful shipping every
route's code on every visit becomes. Per-route groups in this real app are
3.7–9.4 KB (not sub-KB fragments), so there is nothing to coalesce; tiny groups
only appear in toy apps, which opt out with one line.

If your app is small and every route's client code is trivial, the split is a wash
and the one-line opt-out (`clientChunks: false`) is the right call. To measure your
own app, build both ways and run `node tools/bench-client-chunks.mjs <dist-off>
<dist-on>` (or compare first-load client JS for a representative route with the
`tools/bundle-report.mjs` analyzer).

## Caveats

- `clientChunks` is a **production-build** optimization. In dev, Vite serves
  modules individually; the no-leakage property holds (only the rendered route's
  modules load) but there are no named `app-*` chunks.
- Upstream `@vitejs/plugin-rsc` has a known first-request CSS-ordering edge case
  when many client groups interact
  ([vite-plugin-react#1100](https://github.com/vitejs/vite-plugin-react/issues/1100)).
  The e2e suite covers a page that renders **two** route groups' CSS at once and
  asserts both stylesheets apply with the correct cascade, deterministically
  across reloads, in dev and a production preview (`e2e/mini.test.ts`,
  `/combined`). Still validate your own styling under a production preview when
  adopting splitting.
- **No minimum-chunk-size coalescing.** `experimentalMinChunkSize` was removed in
  Vite 8 / Rolldown, and byte-based coalescing cannot be reconstructed inside the
  `clientChunks` callback — grouping is finalized before any chunk is rendered, so
  emitted sizes do not exist yet. It is also unnecessary: per-route groups are
  fetched lazily, so a tiny group costs one extra (multiplexed) request **on its
  own route only** and never taxes another route's first load. An app whose routes
  are uniformly tiny is the small-app case that opts out with
  `clientChunks: false`, or hand-tunes grouping with a `clientChunks` function
  (return `undefined` to fold a route back into the shared chunk).
