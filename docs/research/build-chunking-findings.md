# Build Chunking & Client-Asset Leakage — Research Findings

> Branch: `research/build-chunking-leakage`. Working scratchpad; confirmed facts are
> tagged **[CONFIRMED]** (verified against source or built output), **[OBSERVED]**
> (seen in one build, needs cross-app confirmation), **[HYPOTHESIS]** (not yet verified).
>
> **STATUS — read first.** This is the investigation log, in roughly the order things
> were discovered, so statements about Rango's _current_ behavior are point-in-time.
> The investigation concluded by **shipping the public `clientChunks` API** on this
> branch. Where the body below says Rango "does NOT use `clientChunks`" or references
> an env-gated `experimentalClientChunks()` PoC, that describes the _starting_ state —
> it has since been replaced by the real `RangoOptions.clientChunks` option. See the
> **Outcome** section at the end, `build-chunking-plan.md`, and the user guide
> `../../packages/rangojs-router/docs/client-chunking.md` for the final state.

## Question

Do client assets leak across (a) routes, (b) `include()` boundaries, and (c) host-app
boundaries in a multi-router setup? If you navigate to route A, do you download route B's
client JS/CSS? Can we split to reduce the client bundle? What does plugin-rsc do with
client assets + CSS, and how do alternatives (vinext, etc.) handle this?

---

## Mechanism (source-confirmed)

### 1. Client-reference chunking mirrors the RSC/server build's chunking [CONFIRMED]

`@vitejs/plugin-rsc` (`node_modules/@vitejs/plugin-rsc/dist/plugin-BhzHKRFo.js`):

- Every `"use client"` module is collected into `manager.clientReferenceMetaMap`.
- During the **RSC (server) build** `generateBundle`, for each server chunk that contains
  client-reference stubs it computes a `serverChunk` name (line ~1409):
  - has `facadeModuleId` → `serverChunk = "facade:" + relativeId(facadeModuleId)`
  - else → `serverChunk = "shared:" + relativeId(firstSortedModuleId)`
- In the **client (browser) build**, `virtual:vite-rsc/client-references` groups refs by
  `name = clientChunks?.({id, normalizedId, serverChunk}) ?? meta.serverChunk` (line ~1312).
  Each group becomes `virtual:vite-rsc/client-references/group/<name>`, loaded via
  **dynamic `import()`** (lines ~1322-1330).

**Implication:** client component chunk grouping == how the RSC build chunked the modules
that statically import those client components. If the whole app's server tree is one RSC
chunk, all client refs collapse into one group → one client chunk.

### 2. plugin-rsc exposes a `clientChunks` override — Rango did NOT use it (starting state) [CONFIRMED]

> SUPERSEDED: Rango now forwards `clientChunks` in both presets (see Outcome). The
> paragraph below describes the state at the start of the investigation.

`useClientPluginOptions.clientChunks({ id, normalizedId, serverChunk }) => string`
lets a consumer rename/regroup client-reference chunks. At investigation start Rango
called `rsc({ entries, serverHandler })` with **no** `clientChunks`, so it inherited
the default serverChunk-mirrors-RSC grouping.

### 3. Rango's `getManualChunks` forces one "react" + one "router" chunk [CONFIRMED]

`packages/rangojs-router/src/vite/utils/shared-utils.ts:164`:

- `react`/`react-dom`/`react-server-dom-webpack`/`@vitejs/plugin-rsc` → `"react"` chunk
- `@rangojs/router` (published name) / `packages/rangojs-router/` → `"router"` chunk
- everything else (incl. the **app's own client components**) → `undefined` (Rollup decides)

Applied on the **client** env build only (`rango.ts:151`, `:310`).

---

## Empirical observations

### mini app (single router, one `include`) [OBSERVED — already-built dist]

`packages/rangojs-router/e2e/mini/dist/client/assets/`:

| chunk                   | size   | contents                                                                                         |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `react-*.js`            | 218 KB | React + react-dom + RSDW client + plugin-rsc runtime                                             |
| `router-*.js`           | 98 KB  | **entire** `@rangojs/router` browser runtime **+ app `client.tsx`, `shared.tsx`, `actions.tsx`** |
| `index-*.js`            | 475 B  | browser entry                                                                                    |
| `entry.rsc-*.js`        | 1 KB   | rsc client entry                                                                                 |
| `rolldown-runtime-*.js` | 694 B  | runtime                                                                                          |

Source map of `router-*.js` confirms **all** app client components (home, counter, search,
the `/products` include, state, hooks) + the whole router runtime land in **one** chunk.
→ **No per-route splitting. No per-include splitting.** Visiting `/counter` downloads
`/search`'s `SearchControls` and the products include's client code. **[leakage CONFIRMED for single-router]**

Note: mini's `include` (`urls/products.tsx`) has no `"use client"` of its own — its client UI
also comes from the shared `client.tsx`. Need an app where the include has its OWN client
components in a separate file to test include-boundary splitting.

---

### test-app (large single router, ~90 client components) [CONFIRMED — built]

One `router-*.js` (**153 KB**) holds the router runtime + **all ~90 app client components**
(every route's widgets). → cross-route leakage confirmed at scale.
Exception: `HydrationMismatch-*.js` got its **own 0.1 KB chunk** — because it is reached via
`await import("../components/HydrationMismatch.js")` (a dynamic `import()` in
`urls/meta.handlers.tsx`). **Dynamic `import()` is the one working split boundary today.**

### e2e-basic (small single router) [CONFIRMED — built]

One `router-*.js` (79 KB) = router runtime + app client components. Same monolithic pattern.

### cloudflare-multi-router (host-app split) [CONFIRMED — built]

`worker.rsc.tsx` wires 4 sub-apps via `createHostRouter().host(...).lazy(() => import("./apps/X/handler.js"))`.
Built client assets:

| chunk          | size   | contents                                                      |
| -------------- | ------ | ------------------------------------------------------------- |
| `react-*.js`   | 218 KB | shared React/RSDW                                             |
| `router-*.js`  | 76 KB  | shared `@rangojs/router` runtime (ONE copy across all 4 apps) |
| `handler-CNa…` | 1.0 KB | **app-a only**: `AppALayout` + `Document`                     |
| `handler-Cr-…` | 1.0 KB | **app-b only**: `AppBLayout` + `Document`                     |
| `handler-Dxv…` | 1.2 KB | **admin only**: `AdminLayout` + `Document`                    |
| `handler-jd3…` | 1.3 KB | **site only**: `SiteLayout` + `NestedLayout` + `Document`     |

→ **No cross-app leakage.** app-a's bundle does NOT contain app-b's components.
**Why it splits:** each app's handler is a **dynamic `import()`** in `worker.rsc.tsx` →
separate RSC server facade chunk → separate `serverChunk` → separate client-reference group
→ separate per-app client chunk. React + router runtime stay shared (Rango's `getManualChunks`
forces them into `"react"`/`"router"`, deduped across apps).

### The unifying rule [CONFIRMED]

**Client-chunk granularity == RSC server-chunk granularity == dynamic-import-boundary granularity
of the server module graph.** A single `include()` is a _static_ mount (`why-includes-is-sync.md`),
so it does NOT create a boundary → no split. A host sub-app loaded via `.lazy(import())` DOES.

### CSS handling [CONFIRMED — source]

- `collectAssetDeps(bundle)` ties each client-reference group's CSS to its `groupChunkId`
  (`plugin-BhzHKRFo.js:1075-1086`); CSS for server modules collected via `collectCss(rsc/ssr, importer)`.
- Stylesheets are emitted as `<link rel="stylesheet" data-precedence="vite-rsc/client-references">`,
  using React's `precedence` to hoist + dedupe (`cssLinkPrecedence` default true).
- So **CSS follows the same group chunking as JS**: one client group → one stylesheet loaded
  eagerly with it; per-route groups → per-route stylesheets. CSS injection is driven by the RSC
  render (assets-manifest `serverResources`), so only CSS of _rendered_ modules is linked.
- GAP: no app in the repo imports a real `.css` file from a client component, so this is
  source-confirmed but **not yet empirically built**. Need a CSS test scenario.

## Optimization lever (identified, to verify)

plugin-rsc's **`clientChunks({ id, normalizedId, serverChunk }) => name`** callback regroups
client references at the _client_ build level, independent of server chunking: distinct names
→ distinct `virtual:vite-rsc/client-references/group/<name>` → distinct dynamically-imported
client chunks. Rango does NOT pass it today. A path-convention mapping
(e.g. `routes/<name>/...` or `*.client.tsx` colocated per route → group `route:<name>`) would
give per-route client splitting with no API change for the consumer beyond file organization.
**This is the "vite auto-optimisation by naming convention" lever.** Must prototype to confirm
it produces separate chunks AND that Rango's `getManualChunks` doesn't re-merge them.

---

## CORRECTION: in-repo e2e apps have a chunk-merge artifact [CONFIRMED]

`getManualChunks` (`shared-utils.ts:178-184`) returns `"router"` for any path matching
`normalized.includes("packages/rangojs-router/")`. The in-repo e2e apps (mini, e2e-basic,
test-app) **live under** `packages/rangojs-router/e2e/...`, so **their own app component files
match this rule** and get force-pinned into the `"router"` chunk. That is why test-app/mini
showed app `client.tsx`/components _inside_ `router-*.js`.

**This is a test artifact, not consumer-representative.** A real external consumer installs
`@rangojs/router` under `node_modules/@rangojs/router/` and their app code does NOT match
`packages/rangojs-router/`, so their components are NOT merged into the router runtime chunk.

### Representative single-router picture — cloudflare-basic [CONFIRMED — built]

`tests/cloudflare-basic` is NOT under `packages/rangojs-router/`. Built client assets:

| chunk               | size    | contents                                                    |
| ------------------- | ------- | ----------------------------------------------------------- |
| `react-*.js`        | 219 KB  | shared React                                                |
| `router-*.js`       | 89 KB   | `@rangojs/router` runtime (own chunk, shared across routes) |
| `worker-entry-*.js` | 20.7 KB | **all 14 app client components, ONE chunk, all routes**     |

→ Real consumer: router runtime and app-components are **separate** chunks, but the
**app-components are still ONE chunk for every route** → cross-route leakage holds.
(`vite-rsc-demo`, node preset, same shape: one 138 KB `entry.rsc-*.js` app-component chunk.)

## clientChunks lever — RELOCATION PROVEN [CONFIRMED — built]

Patched Rango (env-gated, `rango.ts`, node branch) to forward
`clientChunks: experimentalClientChunks()`; `RANGO_CLIENT_CHUNKS=per-ref` returns a unique
group name per `"use client"` module. Built `vite-rsc-demo` (no path artifact):

- Baseline: one 138 KB `entry.rsc-*.js` app-component chunk.
- With `per-ref`: that chunk **split into ~35 real `cref-*.js` chunks** carrying actual
  component code (`cref-KanbanBoard` 12 KB, `cref-CardDetail` 8.8 KB, `cref-TodosList` 8.7 KB…),
  while `router-*.js` (91 KB) and `react-*.js` stayed shared and unchanged.

→ **`clientChunks` genuinely relocates client component code into separate, lazily-imported
chunks.** Returning per-ref is too granular (42 chunks); the real policy is per-route/per-feature
grouping — which needs a path the callback can key on (the callback only receives the component
module id, NOT the importing route), i.e. **route-colocated client files (naming convention).**

Note: on in-repo e2e apps (test-app) the same flag produced only tiny re-export **shims**
because `getManualChunks` re-pinned the bodies to `"router"` (the substring artifact above).
So **the optimization also requires tightening `getManualChunks`** to match only the actual
package (`node_modules/@rangojs/router/` or the package root), not the `packages/rangojs-router/`
substring, or app code colocated in-repo can't be split.

> HISTORICAL: during the investigation `rango.ts` carried an env-gated
> `experimentalClientChunks()` PoC (inert unless `RANGO_CLIENT_CHUNKS` set) used only
> for this proof. It was **removed and graduated** into the public `RangoOptions.clientChunks`
> option (`false` | `true` | function) — see Outcome.

## CSS — empirically confirmed [CONFIRMED — built]

Added `.css` imports to two client components in `vite-rsc-demo` (`CartBadge`, `KanbanBoard`,
on different routes), built both ways:

- Baseline (one app-component chunk): both rules collapsed into **one** combined
  `entry-*.css` (93 B). → all client-component CSS ships together regardless of route.
- `per-ref` split: CSS split into **per-component** `cref-CartBadge-*.css` (46 B) +
  `cref-KanbanBoard-*.css` (48 B). → **CSS follows the same group chunking as JS.**

Mechanism detail (from research + source): plugin-rsc wraps CSS-importing modules with
`import.meta.viteRsc.loadCss()` (`rscCssTransform`), tracks per-group CSS in the
assets-manifest (`clientReferenceDeps` for client refs, `serverResources` for server modules),
and injects `<link rel="stylesheet" data-precedence="vite-rsc/client-references">` /
`...="vite-rsc/importer-resources">`, deduped by React precedence. Injection is RSC-render-driven,
so only the CSS of _rendered_ modules is linked → CSS is effectively route-scoped at runtime even
today, but the underlying _asset_ is one combined file unless the JS chunks are split.
Known upstream risk: CSS link ordering non-determinism on first SSR request
([vite-plugin-react#1100](https://github.com/vitejs/vite-plugin-react/issues/1100)).

## Alternatives (external research — see `build-chunking-alternatives.md`)

| Framework           | Client-split mechanism                                                                          | Granularity                      | CSS                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------- |
| **Rango (today)**   | inherits plugin-rsc default (group == serverChunk); split only at dynamic `import()` (sub-apps) | per-router; per-sub-app          | one combined asset / router; route-scoped injection |
| **Waku**            | plugin-rsc render-time discovery; no manualChunks                                               | per-component as discovered      | auto via `loadCss()`                                |
| **vinext** (CF)     | conservative manualChunks (framework chunk) + explicit `import()`/`React.lazy`                  | per-route at explicit boundaries | `rscCssTransform`/`loadCss()`                       |
| **Next App Router** | FS routing; auto-chunk per `page`/`layout` + dynamic import                                     | per-route segment                | per-route streamed                                  |
| **Remix / RR v7**   | route module = dynamic-import boundary                                                          | per-route module                 | per-route `links()`                                 |

The single underlying rule across all: **a dynamic `import()` (or a convention that compiles to
one) is what cuts a chunk.** Next/Remix make route modules _implicitly_ dynamic; vinext is
_explicit_; Waku/Rango keep routes static → co-resident in one chunk. Rango's per-sub-app split
is therefore _correct and intentional_, not a bug. `clientChunks` (plugin-rsc PR
[#767](https://github.com/vitejs/vite-plugin-react/pull/767)) is the one lever that splits client
components **without** forcing route authors to hand-write `import()`.

## Confirmed hypotheses

- **H1 [CONFIRMED]**: Per-route client splitting needs (a) client components in per-route modules
  AND (b) a `clientChunks` mapping (path → route group). A monolithic barrel can't split by route.
- **H2 [CONFIRMED]**: `clientChunks` keyed off a path naming convention (route-colocated client
  files → `cref-<route>`) is the lowest-friction lever (the "vite auto-optimisation by naming
  convention"). Proven via the `per-ref`/`per-dir` PoC.
- **H3 [CONFIRMED]**: Today every consumer ships every route's client JS+CSS in one chunk on first
  load; the only working escape hatches are dynamic `import()` of a sub-app (coarse) or manual
  `React.lazy` inside a client component (fine). `HydrationMismatch` getting its own chunk proves
  the latter.

## Open risks before shipping an optimization

1. **No measured payoff yet.** Shared baseline is ~115 KB React + ~50 KB router runtime; per-route
   _app_ component bytes may be small. Splitting can add HTTP requests and hurt multi-route first
   loads. **Must benchmark** (bundle-analysis skill) before committing. ← go/no-go gate.
2. **Build-split ≠ lazy fetch.** Confirm grouped chunks are actually deferred on non-initial routes
   (not eagerly preloaded), or it is fragmentation with no latency win. Needs a runtime check.
3. **Shared-component duplication.** A client component used by 2 routes: define the rule
   (fall back to default `serverChunk` group for co-imported refs; don't duplicate).
4. **CSS ordering / FOUC.** More groups → more `<link>` precedence interactions; dual-mode e2e
   needed (GH#1100).
5. **`getManualChunks` substring** (`packages/rangojs-router/`) must be tightened to the real
   package root, or in-repo/colocated app code can't be split (and is wrongly merged into `router`).
6. **`experimentalMinChunkSize` is NOT available** — removed in Vite 8 / Rolldown (this repo is
   vite@8.0.14). Cannot rely on it to coalesce tiny route chunks.

---

## Outcome (shipped on this branch)

The public `clientChunks` API was implemented and verified end-to-end. See
`build-chunking-plan.md` for the full plan and `../../packages/rangojs-router/docs/client-chunking.md`
for the user guide. Resolved risks from the list above:

- Risk 1 (payoff): **benchmarked**. `vite-rsc-demo` one 138 KB app chunk →
  per-feature chunks (`app-kanban` 28 KB, `app-shop` 21 KB, `app-blog` 12 KB,
  `app-todos` 11 KB, `app-loaders-demo` 35 KB); flat `components/` now folds into the
  shared `entry.rsc` chunk; React/router unchanged. **Default is now ON pre-1.0**
  (opt out with `clientChunks: false`) — made safe by the strategy inheriting the
  default grouping where there is no route structure (see `build-chunking-plan.md`,
  "Default" + "Deferred to a follow-up PR").
- Risk 2 (lazy fetch): **resolved**. Built `mini` with `clientChunks: true` + the
  `/widgets` and `/charts` colocated routes; each route's HTML references ONLY its
  own `app-<route>-*.js` + `.css` (no eager preload of the other route).
- Risk 3 (dedup): plugin-rsc maps each module to exactly one group — no byte
  duplication. Documented the "hoist shared client components out of route dirs" rule.
- Risk 4 (CSS/FOUC): **dev+prod e2e** (`mini.test.ts`) assert the colocated CSS is
  applied for the current route only.
- Risk 5 (`getManualChunks`): **fixed** — anchored to `packages/(rangojs-router|rsc-router)/(src|dist)/`.
- Risk 6: directory-level (not per-file) grouping avoids extreme fragmentation
  without needing `experimentalMinChunkSize`.

Validation: typecheck, unit (3300), lint, format, e2e-bucketing all green; full
`mini.test.ts` 59/59 green (dev+prod) including the 5 new clientChunks tests.
