# Client Chunking: how the browser bundle is split, and how to reduce it

This guide explains how `@rangojs/router` splits your client (`"use client"`)
components into browser chunks, what ships on first load, and the levers for
shrinking the client bundle of a given route.

## TL;DR

- **Per-route client splitting is ON by default** (pre-1.0): `rango()` groups your
  `"use client"` components by route id, so visiting `/a` does not download `/b`'s
  client code. Opt out with `rango({ clientChunks: false })`.
- The default is **safe because it only splits where it recognizes a route
  structure**. Three branches:
  - **Structured route dirs** (`routes/<id>/…`, `app/<id>/…`, `handlers/<id>/…`, …)
    → split into a per-route chunk `app-<id>` (+ its CSS).
  - **Flat `src/components/…`** (no route structure) → **stays shared**: one app
    chunk, exactly as if splitting were off. No change for flat apps.
  - **Host sub-apps** loaded via a dynamic `import()` → already split per app by
    their server boundary; the default leaves that untouched (no cross-app merge).
  - A **custom `clientChunks` function** fully overrides all of the above.
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
    Button.tsx                // -> shared "app-components-*.js" (no route root)
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

When the path has **no** route-root directory (e.g. a flat `src/components/`),
the strategy falls back to the immediate **parent directory name** — so a flat
`components/` folder collapses to one shared `app-components` chunk, as intended.

React, the router runtime, and anything in `node_modules` always stay on the
shared grouping — they are never fragmented per route.

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
duplication. The only question is _which_ group a shared component lands in:

- Put genuinely shared client components **outside** route directories (e.g.
  `src/components/` or `src/shared/`) so they form one shared group loaded once.
- A component placed under `routes/dashboard/` but also rendered by `/settings`
  still works — visiting `/settings` will load the `app-dashboard` chunk for it —
  but it is clearer to hoist shared components to a shared directory.

## CSS

CSS imported by a client component is collected per client-reference group and
emitted as a `<link rel="stylesheet">` with React's `precedence` attribute, so
React hoists and dedupes it. CSS therefore splits at the **same granularity as
JS**: one app chunk -> one combined stylesheet; per-route chunks -> per-route
stylesheets. Injection is driven by the RSC render, so only the CSS of the
components actually rendered on the current route is linked — no FOUC, no
unrelated routes' CSS.

## When is splitting worth it?

It is on by default, but be aware of the trade-off. On every route the browser
already loads React (~115 KB gzip) and the Rango runtime (~50 KB gzip); those
dominate. Per-route splitting only moves your **app-specific** client bytes. It is
a clear win when routes carry heavy, independent client code (dashboards, editors,
data grids) and a wash — or a small regression from extra requests — when client
components are small and shared. The default only splits where it recognizes a
route structure, so a flat-layout app is unaffected either way.

To measure for your app, build with and without `clientChunks: false` and compare
the first-load client JS for a representative route (the bundle-analysis tooling,
`tools/bundle-report.mjs`, helps here). If extra requests hurt more than the byte
savings help, opt out with `clientChunks: false`.

## Caveats

- `clientChunks` is a **production-build** optimization. In dev, Vite serves
  modules individually; the no-leakage property holds (only the rendered route's
  modules load) but there are no named `app-*` chunks.
- Upstream `@vitejs/plugin-rsc` has a known first-request CSS-ordering edge case
  when many client groups interact
  ([vite-plugin-react#1100](https://github.com/vitejs/vite-plugin-react/issues/1100));
  validate styling in both dev and a production preview when adopting splitting.
