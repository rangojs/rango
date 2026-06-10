# Dogfooding `@rangojs/router/testing` on the mini app — findings

Mini is the second dogfood target (after `tests/cloudflare-basic`, whose
`test/FINDINGS.md` is the primary findings log + the working-recipe rationale).
Setup here is the shipped preset: `resolve: { alias: rangoTestAliases() }` (no
`cloudflare` flag — mini is a node-preset app). 4 entries are exercised:
`generated-routes`, `dispatch`, `renderRoute` (`/dom`), `renderToFlightString`
(`/flight`).

What mini adds over cloudflare-basic: **mini has no `Prerender()`, so the FULL
app router imports in a bare test** (cloudflare-basic's Prerender routes block
that). That exposed a new finding:

## Finding (FIXED) — `assertGeneratedRoutesMatch` false-flagged `include()`d routes

> **Resolution:** `diffGeneratedRoutes`/`assertGeneratedRoutesMatch` now
> **force-expand lazy includes** (calling `findMatch` on a concrete path derived
> from each generated pattern) before diffing, so the whole-app drift check works
> in a unit test. `test/generated-routes.test.ts` now asserts a fully clean diff
> for the whole mini app (products.\* included) and still catches real drift. The
> original analysis is kept below for context.

`assertGeneratedRoutesMatch(router, NamedRoutes)` / `diffGeneratedRoutes` compare
the generated `*.named-routes.gen.ts` (the COMPLETE static route list) against
`router.routeMap`. But `router.routeMap` — and the internal global route map —
contain only the **eager, top-level** routes. Routes mounted via `include()`
(here `/products` → `products.index` / `products.detail`) are **lazy**: they only
populate after the router manifest resolves, which needs the
`virtual:rsc-router/routes-manifest/<routerId>` virtual module that does not
exist in a bare Vitest process.

Consequence: for any app using `include()`, `assertGeneratedRoutesMatch(router,
NamedRoutes)` **always throws**, reporting every included route as a false
"missing". Only two diff directions are reliable in a unit test:

| direction  | meaning                                     | reliable in a unit test?                                       |
| ---------- | ------------------------------------------- | -------------------------------------------------------------- |
| `extra`    | route in runtime map, NOT in generated file | YES — real drift (added/renamed a route, forgot to regenerate) |
| `mismatch` | same name, different pattern                | YES — real drift                                               |
| `missing`  | in generated file, NOT in runtime map       | NO — also fires for every lazy `include()`d route              |

So `test/generated-routes.test.ts` asserts on `extra` + `mismatch` (and pins the
expected `missing` set as the lazy includes, which is a wiring signal, not
drift). The whole-app "missing" drift check belongs to e2e / a build step where
the manifest is resolved.

**Recommendation:** either (a) document this in the `/testing` guide's
generated-routes section (assert `extra`/`mismatch` in unit tests; full check at
build/e2e), or (b) give the primitive a way to resolve the full runtime map (e.g.
accept a pre-resolved map, or an option to only check the reliable directions).
This was surfaced to the maintainer; not fixed in-place pending a decision on the
primitive's contract.

## Everything else matched cloudflare-basic

- `dispatch` (full router): 404 on unmatched, and the "does not render RSC
  routes" directive on RSC routes (mini is RSC-heavy; few response routes).
- `renderRoute`: real client components (`ParamReadout` via useParams,
  `GlobalReverse` via useReverse over the generated global map).
- `renderToFlightString`: pure leaf server component (mini's own server
  components read `ctx.use(...)`, which is outside v1 flight scope).
- The preset (`rangoTestAliases()`) made the full router importable with zero
  local stubs; the type fixes mean no casts are needed.
