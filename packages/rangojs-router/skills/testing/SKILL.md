---
name: testing
description: Test @rangojs/router apps — unit (loaders/middleware/reverse/components), integration (dispatch/Flight), and e2e (dev+prod parity, progressive enhancement)
argument-hint: [layer]
---

# Testing @rangojs/router apps

Rango ships six consumer-facing testing entries, one per test runtime/dependency:
`@rangojs/router/testing` (unit + integration, under a Vite-driven Vitest
project), `@rangojs/router/testing/vitest` (the `rangoTestConfig`/`rangoTestAliases`
setup preset), `@rangojs/router/testing/dom` (`renderRoute`, needs RTL + a DOM
env), `@rangojs/router/testing/e2e` (the Playwright harness),
`@rangojs/router/testing/flight` (real Flight, react-server condition only), and
`@rangojs/router/testing/flight-matchers` (the Flight matchers).

The hard problem in an RSC app is that the layer you reach for is dictated by
**what the behavior touches** — a pure predicate is a one-line vitest test; a real
async Server Component cannot be a plain node test at all. Pick the layer
**first**, then the primitive. Reaching one layer too high (e2e for a reverse
function) is slow; one too low (a node test for Flight) fails to compile or
silently asserts nothing.

This page is the router. Each primitive's full API (options, the seeded context
your code receives, the return shape), a minimal recipe, and its caveats live in a
dedicated sub-file linked from the decision tree below. Read the one for your case.

> **Setup is the first wall.** The vitest projects, the `rangoTestConfig` vs
> `rangoTestAliases` choice (Node >= 23), and the react-server `@rangojs/router ->
index.rsc.ts` alias are all in [`./setup.md`](./setup.md). Read it before writing
> `vitest.config.ts`. Platform bindings (`env.DB`/DO/R2) are your own double —
> [`./bindings.md`](./bindings.md).

For the long-form prose guide (setup walkthrough + migration), see
[`docs/testing.md`](https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/testing.md)
(the `docs/` directory is not shipped in the published package, so this is an
absolute link).

## When to use

Use this skill when adding or changing tests for a Rango app: a loader,
middleware, a server action, a route map, a client component, a response route,
cache/SWR behavior, prerender, or a navigation/PE flow.

Two non-negotiable mandates (from the repo's `CLAUDE.md`, and they apply to
consumer apps too):

- **Every e2e covers BOTH dev and production.** A dev-only e2e is not acceptable.
  Use `parityDescribe` — it generates the dev and production describes from one
  body, so you cannot forget the prod half. See [`./e2e-parity.md`](./e2e-parity.md).
- **Progressive-enhancement parity** is a first-class assertion. A form-driven
  flow must produce the same observable result with JS on and JS off. Use
  `expectParity`.

## The read-first shape

Four import roots, each matched to the dependency/runtime that can load it — this
split is forced by hard walls, not preference:

- `@rangojs/router/testing` — unit + integration primitives. Run these under a
  **Vite-driven Vitest** project with the rango Vite plugin active (the router
  internals import the `@rangojs/router:version` virtual; without the plugin, the
  preset stubs it). References neither React, RTL, Playwright, nor the RSC runtime.
- `@rangojs/router/testing/dom` — `renderRoute` (the RTL component stub). Kept
  separate so the unit barrel stays free of React/RTL; it lazy-loads
  `@testing-library/react` and needs a DOM env (happy-dom/jsdom).
- `@rangojs/router/testing/e2e` — the Playwright harness. Kept separate so it
  loads in a plain (non-Vite) Playwright runner; the helpers take your
  `test`/`expect`, so this entry never imports `@playwright/test` at runtime.
- `@rangojs/router/testing/flight` — real Flight rendering. Its serializer loads
  only under the `react-server` node condition; pulling it elsewhere throws.

The single rule that drives everything:

> **If the behavior needs a real Flight render, it cannot be a plain vitest node
> test.** It is either `renderToFlightString`/`renderServerTree`/`renderHandler`
> (under the react-server vitest project) or an e2e test. There is no middle
> ground in node.

## Decision tree: behavior -> layer -> primitive

Each primitive links to its sub-file (API + recipe + caveats).

| The behavior is…                                                                                          | Layer        | Primitive                                                                      | Import root                      |
| --------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------ | -------------------------------- |
| a pure function / `reverse` / `href` / a predicate (`revalidate`, `isAction`)                             | unit + types | [`reverse`/`@ts-expect-error`](./reverse-and-types.md)                         | `@rangojs/router/testing`        |
| one loader's data logic                                                                                   | unit (node)  | [`runLoader`](./loader.md)                                                     | `@rangojs/router/testing`        |
| one middleware's ordering / short-circuit / cookie+header merge                                           | unit (node)  | [`runMiddleware`](./middleware.md)                                             | `@rangojs/router/testing`        |
| a `"use server"` action's cookie / header / flash output (even on `throw redirect()`)                     | unit (node)  | [`runInRequestContext`](./server-actions.md)                                   | `@rangojs/router/testing`        |
| a handle's `collect`/accumulator, or a seeded handle read                                                 | unit         | [`collectHandle` / seeded `handles`](./handles.md)                             | `@rangojs/router/testing[/dom]`  |
| a CLIENT component reading router context (`useParams`/`useReverse`/`Outlet`/`useNavigation`/`useLoader`) | unit (DOM)   | [`renderRoute`](./client-components.md)                                        | `@rangojs/router/testing/dom`    |
| a redirect / status / headers / cookies / **response route** (json/text/html/xml/md), no Flight           | integration  | [`dispatch`](./response-routes.md)                                             | `@rangojs/router/testing`        |
| a real async **Server Component** / Flight serialization shape                                            | RSC unit     | [`renderToFlightString` + `toMatchFlight`](./flight.md)                        | `@rangojs/router/testing/flight` |
| a client island's **typed props** / the **server-rendered** host content                                  | RSC unit     | [`renderServerTree` + `findClientBoundaries`/`findElements`](./server-tree.md) | `@rangojs/router/testing/flight` |
| a real route **handler** `(ctx) => rsc` (params/loaders/vars -> rendered RSC + effects)                   | RSC unit     | [`renderHandler`](./render-handler.md)                                         | `@rangojs/router/testing/flight` |
| navigation, hydration, PE parity, view transitions, real SSR                                              | e2e          | [`createRangoE2E` -> `parityDescribe`/`expectParity`](./e2e-parity.md)         | `@rangojs/router/testing/e2e`    |
| cache hit/miss/stale, prerender (= a cache hit by design)                                                 | e2e + signal | [`assertCacheStatus` / telemetry sink](./cache-prerender.md)                   | `@rangojs/router/testing[/e2e]`  |
| generated route map drift vs runtime                                                                      | unit (node)  | [`assertGeneratedRoutesMatch`](./reverse-and-types.md)                         | `@rangojs/router/testing`        |
| a platform binding (`env.DB` / Durable Object / `env.R2`)                                                 | unit/integr. | [your own double via `env`](./bindings.md)                                     | (any primitive's `env` option)   |

Cross-references to the DSL skills: `/loader`, `/middleware`, `/server-actions`,
`/handler-use`, `/hooks`, `/response-routes`, `/route`, `/caching`, `/prerender`,
`/typesafety`.

## Sub-files

- Cross-cutting: [`setup.md`](./setup.md), [`bindings.md`](./bindings.md)
- Unit (node): [`loader.md`](./loader.md), [`middleware.md`](./middleware.md),
  [`server-actions.md`](./server-actions.md), [`handles.md`](./handles.md),
  [`reverse-and-types.md`](./reverse-and-types.md)
- Unit (DOM): [`client-components.md`](./client-components.md)
- RSC unit: [`flight.md`](./flight.md), [`server-tree.md`](./server-tree.md),
  [`render-handler.md`](./render-handler.md)
- Integration: [`response-routes.md`](./response-routes.md)
- E2E: [`e2e-parity.md`](./e2e-parity.md), [`cache-prerender.md`](./cache-prerender.md)

## Pre-push checklist (mirror CLAUDE.md)

Before pushing, run all of these and fix any failure:

1. `pnpm run typecheck` (or `pnpm exec tsc --noEmit`)
2. `pnpm run test:unit` (node + DOM vitest)
3. `pnpm run test:unit:rsc` (the react-server Flight project)
4. `pnpm run lint`
5. `pnpm run format`

And: **every e2e has a production counterpart.** `parityDescribe` makes this
automatic — if you wrote a plain `test.describe` for a behavior, convert it.
