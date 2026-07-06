---
name: typesafety
description: Set up type-safe routes, params, and environment types in @rangojs/router. Use when route or search params aren't typed, TypeScript can't infer a loader's return type, or wiring up typed environment bindings.
argument-hint: [setup]
---

# Type Safety Setup

@rangojs/router provides end-to-end type safety for routes, parameters, and
environment. Without it: `ctx.reverse()`/`href()` accept any string (typos
404 at runtime, not compile time), `ctx.search`/`ctx.params` fall back to
loose `Record<string, string>`, and `ctx.env`/`ctx.get()` are untyped so a
missing binding surfaces as `undefined` in production instead of a build
error.

Each topic's full setup, code, and caveats live in a companion file linked
below. Read the one for your case.

## Routing table

| I need...                                                                                                            | Topic                                  | File                                                           |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| Named routes, `.gen.ts` surfaces, `RegisteredRoutes` vs `GeneratedRouteMap`, tsconfig checklist                      | Router setup & generated route types   | [`./generated-files-and-cli.md`](./generated-files-and-cli.md) |
| Type-safe `path()` names, `ctx.reverse()`, `href()`/`useHref()`, `Rango.PathResponse`, stable `path#export` identity | Route & href typing                    | [`./route-types.md`](./route-types.md)                         |
| Typed `search` schemas, `RouteSearchParams`/`RouteParams`, loader return types                                       | Search params & loader typing          | [`./params-and-search.md`](./params-and-search.md)             |
| Typed `env`/bindings, `Rango.Vars`, `createVar()`, handle typing, loader/handle ref props, location state typing     | Environment, context, and state typing | [`./env-and-bindings.md`](./env-and-bindings.md)               |
| Multi-app / multi-router tsconfig setup, avoiding `GeneratedRouteMap` collisions                                     | Multi-project setup & full walkthrough | [`./generated-files-and-cli.md`](./generated-files-and-cli.md) |
| Slow typecheck with many `include()` modules (instantiation blowup), wide `UrlPatterns<any>` annotations             | Typecheck cost at route scale          | [`./generated-files-and-cli.md`](./generated-files-and-cli.md) |

## Companion files

- [`./generated-files-and-cli.md`](./generated-files-and-cli.md) — Router
  setup, the three route-typing surfaces (`GeneratedRouteMap` /
  per-module `routes` / `RegisteredRoutes`), the single-app setup checklist,
  `$$routeNames` vs `router.routeMap`, multi-project tsconfig setup, and the
  complete end-to-end setup walkthrough.
- [`./route-types.md`](./route-types.md) — Type-safe route names, server
  `ctx.reverse()`, client `href()`/`useHref()`, `Rango.Path`,
  `Rango.PathResponse` (incl. overriding JSON/Flight serialization), and the
  `path#export` stable identity scheme shared by loaders/handles/cached
  functions/actions.
- [`./params-and-search.md`](./params-and-search.md) — Typed `search`
  schemas on `path()`, `Handler<"name">` param/search inference,
  `RouteSearchParams`/`RouteParams` utility types, and loader return-type
  inference.
- [`./env-and-bindings.md`](./env-and-bindings.md) — Environment bindings
  (`TEnv`) and `Rango.Env`/`Rango.Vars` registration, `createVar<T>()`
  scoped context tokens, handle typing, passing loaders/handles as typed
  props, and location state typing.

See `/links` for the full URL generation guide (per-module `*.gen.ts`,
`useReverse`).
