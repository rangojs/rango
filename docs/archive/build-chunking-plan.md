> **Archived.** Plan/outcome tracker; `clientChunks` shipped (#535/#536). See `packages/rangojs-router/docs/client-chunking.md`.

# Build Chunking — Plan & Outcome

Concrete plan derived from `build-chunking-findings.md` (in-repo empirical proof)
and `build-chunking-alternatives.md` (external research). Status of each item is
marked. This branch (`research/build-chunking-leakage`) implements the public
`clientChunks` API.

## Confirmed behaviors (the contract)

1. A single router ships **one** client chunk for all routes (cross-route
   leakage). `include()` does not split (static mount). [CONFIRMED, built]
2. Host sub-apps loaded via `.lazy(() => import())` split into **per-app** client
   chunks; React + router runtime are shared; **no cross-app leakage**. [CONFIRMED]
3. Client-chunk granularity == RSC server-chunk granularity == dynamic-`import()`
   boundary granularity. [CONFIRMED, source + built]
4. CSS follows the JS group chunking (one group -> one stylesheet); injection is
   RSC-render-driven so only rendered modules' CSS links. [CONFIRMED, built]
5. `@vitejs/plugin-rsc`'s `clientChunks` callback re-groups client references into
   separate, dynamically-imported chunks independent of server chunking. [CONFIRMED]

## Shipped in this branch

- **Public `RangoOptions.clientChunks`** (`true` default | `false` | function).
  Built-in strategy groups app `"use client"` modules by **route id** (segment
  after a route-root marker), returning `undefined` (default grouping) where there
  is no route structure; function = forwarded to plugin-rsc. Types `ClientChunks` /
  `ClientChunkMeta` exported from `@rangojs/router/vite`.
  - `packages/rangojs-router/src/vite/plugin-types.ts` (types + option)
  - `packages/rangojs-router/src/vite/utils/client-chunks.ts` (resolver + strategy)
  - `packages/rangojs-router/src/vite/rango.ts` (`?? true` default; wired into BOTH presets' `rsc()` call)
  - `packages/rangojs-router/src/vite/index.ts` (exports)
- **`getManualChunks` tightened** to `packages/(rangojs-router|rsc-router)/(src|dist)/`
  so in-repo/colocated app code is no longer force-merged into the `router` chunk
  (it was, blocking `clientChunks` from relocating it and misrepresenting consumer
  bundles). `shared-utils.ts`.
- **Scenario + e2e**: `mini` gained `/widgets` and `/charts` routes whose client
  components are colocated under `src/routes/{widgets,charts}/` (each with its own
  CSS, plus a same-named nested `components/Badge.tsx`), and `mini` uses plain
  `rango()` to exercise the **default**. `mini.test.ts` asserts, in **dev and
  production**, that each route loads only its own client chunk + CSS (no
  cross-route leakage and no badge collision), plus a production build-graph test
  that the chunks and stylesheets split with React/router shared.
- **Docs**: user guide `packages/rangojs-router/docs/client-chunking.md`; research
  docs under `docs/research/`.

## Benchmark

`tests/vite-rsc-demo` (heavier app, `handlers/<feature>/` layout), production build:

|                       | first-load app-component JS                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientChunks: false` | **one ~138 KB chunk** for every route                                                                                                                                        |
| default (on)          | per-route: `app-loaders-demo` 35 KB, `app-kanban` 28 KB, `app-shop` 21 KB, `app-blog` 12 KB, `app-todos` 11 KB; flat `components/` folds into the shared `entry.rsc` (26 KB) |

React (~221 KB raw) and router (~91 KB raw) stay shared in both. A route that
renders only the kanban board loads ~28 KB of its own code (plus the shared
`entry.rsc`) instead of the full 138 KB. The win scales with route-specific client
weight and colocation; flat `components/` stays in the shared chunk.

## Default: `clientChunks` ON (opt out with `false`)

Decision: ship default-on. (Originally "pre-1.0 to see it in action"; the follow-up
PR's benchmark and gate resolutions below promote this to the **1.0 stance** — see
"Follow-up PR — the four gates, RESOLVED".) The opt-out (`clientChunks: false`) is
one line. This was made safe by a change to the built-in strategy's fallback: it
splits **only where it recognizes a route structure** (a `routes`/`app`/`handlers`/…
marker) and otherwise returns `undefined` to inherit `@vitejs/plugin-rsc`'s default
`serverChunk` grouping. As a result default-on is a **no-op** for layouts it can't
key on:

| App                       | Layout                       | Result with default-on                                                                                              |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `mini`                    | `routes/<id>/…`              | splits `app-widgets` / `app-charts` (+ CSS)                                                                         |
| `vite-rsc-demo`           | `handlers/<feature>/…`       | splits `app-kanban`/`app-shop`/`app-blog`/`app-todos`/`app-loaders-demo`; flat `components/` folds into `entry.rsc` |
| `test-app`                | flat `src/components/`       | **unchanged** — one `entry.rsc` app chunk                                                                           |
| `cloudflare-basic`        | flat `src/components/`       | **unchanged** — one `worker-entry` app chunk                                                                        |
| `cloudflare-multi-router` | host sub-apps via `import()` | **unchanged** — per-app `handler-*.js`, no cross-app merge                                                          |

(Verified by building all five.) Crucially, a parent-dir fallback would have merged
every host sub-app's `components/Layout.tsx` into one `app-components` chunk,
re-introducing cross-app leakage — the `undefined` fallback prevents that.

## Follow-up PR — the four gates, RESOLVED (deterministic stance)

The default-on decision was "see it in action", not yet "proven". The follow-up PR
(`research/build-chunking-followup`) closes all four gates with a firm decision.

### Verdict: `clientChunks` ships **default-ON for 1.0**.

Per-route client splitting is the correct long-term-scale default. The benchmark
shows a clear, growing first-load win; the costs are bounded and small; and the
strategy is a no-op for the layouts it can't key on. Small apps where the split is
a wash opt out with one line. Decision rule applied: optimize for apps at scale
(where shipping every route's client code on every visit is most wasteful), not for
toy apps that can opt out.

**Gate 1 — cost-side benchmark: PASSED.** Measured on `tests/vite-rsc-demo`
(5 feature routes, ~33 KB gz app client code) built both ways with
`node tools/bench-client-chunks.mjs`:

| Metric                        | `clientChunks: false`        | default (on)                             |
| ----------------------------- | ---------------------------- | ---------------------------------------- |
| Shared runtime (every route)  | 95.3 KB gz                   | 95.6 KB gz (identical)                   |
| App code on every first paint | 38.3 KB (one combined chunk) | 13–19 KB (residual + this route's group) |
| Per-route first-load saving   | —                            | 20–25 KB gz (~51–66% of app bytes)       |
| First-load request count      | shared + 1 app chunk         | shared + 1 group (+1, multiplexed)       |
| Total client JS (whole app)   | 134.3 KB                     | 141.0 KB (+5% fragmentation overhead)    |

Cost side, honestly: splitting adds ~1 first-load request and ~5% total client JS
(per-chunk gzip/wrapper overhead), fully paid only on a cold crawl of **every**
route in one session. Land-on-one-route and typical 1–3 route sessions both win
(20–25 KB+ less first-load). The win is a function of app size: the baseline's
every-route app chunk grows with total app code, the split's per-route first-load
does not. This medium app is near the low end and already saves 20–25 KB; at scale
the win dominates the bounded overhead.

**Gate 2 — coalescing (min-chunk-size): WON'T-FIX for 1.0, by design.**
Two independent reasons:

1. **Structurally impossible inside the callback.** `@vitejs/plugin-rsc` finalizes
   client-reference grouping in one synchronous pass over `clientReferenceMetaMap`
   inside a virtual module's `load()`, **before any client chunk is rendered**; the
   callback receives only `{ id, normalizedId, serverChunk }`. Emitted byte sizes —
   what `experimentalMinChunkSize` keyed on (removed in Vite 8 / Rolldown) — do not
   exist at that point. Only module-count (via coupling to plugin-rsc's internal
   `manager`) or a post-build chunk-merge pass could coalesce; both are out of scope
   and fragile.
2. **Unnecessary.** Per-route groups are route-lazy: a tiny group costs exactly one
   extra (HTTP/2-multiplexed) request **on its own route** and never taxes another
   route's first load — there is no first-load fragmentation tax to coalesce away.
   Real apps don't even produce the degenerate case: `vite-rsc-demo`'s groups are
   3.7–9.4 KB. Sub-1 KB groups only appear in toy apps (mini), which opt out with
   `clientChunks: false`, or hand-tune with a `clientChunks` function (return
   `undefined` to fold a route back into the shared chunk).

   Reopen trigger: a real consumer report of pathological fragmentation. The fix
   would then be a post-build chunk-merge pass (the only place real sizes exist),
   not a callback change.

**Gate 3 — CSS ordering / FOUC: COVERED.** Added an e2e (`e2e/mini.test.ts`,
`/combined`) that renders client components from **two** route groups on one page —
the case where per-group `<link>` precedence actually interacts
(`vite-plugin-react#1100`) — and asserts both stylesheets apply with the correct
cascade, deterministically across a reload, in **dev and production**. The
single-route tests already covered per-route application; this covers multi-group
co-render.

**Gate 4 — convention completeness: RESOLVED.** The route-root marker list is
intentionally finite and conventional; the **`clientChunks` function** is the
configurability path for any layout (`src/parts/…`, etc.) — widening an infinite
marker list is explicitly not the mechanism. The previously-silent fallback is now
**observable**: `DEBUG=rango:chunks pnpm build` logs every client module's group,
or the reason it fell back to shared (`shared <id> (no route-root marker; inherits
default grouping)`). New `rango:chunks` debug namespace; built-in strategy logs
each decision. Also fixed a stale doc claim (the strategy inherits the default
grouping for unmarked paths — it does **not** force a parent-named `app-components`
chunk).

### Reproducing the benchmark

```sh
cd tests/vite-rsc-demo
RANGO_BENCH_CHUNKS=off pnpm build && cp -r dist/client/assets /tmp/bench-off
RANGO_BENCH_CHUNKS=on  pnpm build && cp -r dist/client/assets /tmp/bench-on
node ../../tools/bench-client-chunks.mjs /tmp/bench-off /tmp/bench-on
```

(`RANGO_BENCH_CHUNKS` is a consumer-side toggle in the app's own `vite.config.ts`
— the same one-line opt-out a real consumer writes — not a plugin env knob.)

## Risks / follow-ups (deferred, tracked)

- **Build-split vs lazy-fetch** [RESOLVED for fresh loads]: confirmed each route's
  HTML references only its own chunk + CSS (no eager preload of other routes).
  Client-side soft navigation fetches the target route's chunk on demand.
- **CSS ordering** (`vite-plugin-react#1100`) [RESOLVED, gate 3]: more groups ->
  more `<link>` precedence interactions. Covered by the dev+prod e2e — both the
  single-route application checks AND a multi-group co-render (`/combined` renders
  two route groups' CSS at once; both apply with the correct cascade,
  deterministically across a reload). Watch upstream.
- **Shared-component placement**: documented rule (hoist shared client components
  out of route dirs). No byte duplication occurs (one module -> one group); only
  the group a shared component lands in matters.
- **Directory-name collisions** [RESOLVED]: the built-in strategy keys on the
  **route id** — the segment after a route-root marker (`routes`/`app`/`pages`/
  `features`/`handlers`/…) — not the immediate parent. So `routes/foo/components/Button`
  and `routes/bar/components/Button` map to `app-foo`/`app-bar`, not a shared
  `app-components`. When no marker is present it returns `undefined` (inherits the
  default `serverChunk` grouping), so flat layouts and host-split apps are left
  unchanged. Unit-tested (`client-chunks.test.ts`) and proven end-to-end (mini has a
  same-named `components/Badge.tsx` per route; the build-graph test asserts no chunk
  holds both). Custom layouts can still use the function form.
- **`experimentalMinChunkSize` is unavailable** (removed in Vite 8 / Rolldown)
  [RESOLVED as WON'T-FIX, gate 2]: tiny route chunks are not auto-coalesced. The
  built-in strategy groups by directory (not per-file) to avoid extreme
  fragmentation, and byte-based coalescing is both structurally impossible inside
  the `clientChunks` callback (grouping is finalized before chunks are rendered) and
  unnecessary (route-lazy chunks impose no first-load tax). Real apps produce
  multi-KB groups, not sub-KB fragments; toy apps opt out. See gate 2 above.
