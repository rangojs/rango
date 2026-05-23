# Generated Route Type Surfaces Handoff

> **Status: Applied.** The audit findings below have been actioned in the skills
> and docs (`/typesafety`, `/response-routes`, `/links`, `/hooks`, `/rango`,
> `docs/manifests.md`, `docs/design/consolidate-gen-files.md`). This file is
> retained as the record of the three generated type surfaces and the audit; the
> "Current problems" / "Suggested change" notes describe the pre-fix state.
>
> Note: `href()` / `ValidPaths` were subsequently changed to read
> `GeneratedRouteMap` as a fallback (not only `RegisteredRoutes`), so the
> `PathResponse` guidance now applies specifically to response-payload inference.
> See `/typesafety` for the current contract.
>
> **Namespace renamed.** The ambient namespace and the exported router interface
> were renamed `RSCRouter` → `Rango` (follow-up #3 below, now applied). The body
> of this document uses the current `Rango` naming; the former `RSCRouter` spelling
> appears only in the migration record (#3), where it is needed to describe the
> change.

## Additional Handoff Work

The original audit has been applied. Keep these follow-ups attached to the same
type-surface workstream so the generated route story stays consistent for
library code, generated files, docs, and skills.

### 1. Tighten `routes()` env compatibility

Current follow-up:

- `routes()` was widened so env-agnostic `urls()` blocks can attach to any
  router, but avoid leaving it as `UrlPatterns<any, any>`.
- The intended contract is:
  - `urls()` blocks with no explicit env requirement attach to any router.
  - `urls<RequiredEnv>()` blocks attach only when the router env satisfies
    `RequiredEnv`.
  - A router with `{}` must not accept a URL block that requires `env.DB`.
- A simple union such as `UrlPatterns<TEnv, ...> | UrlPatterns<unknown, ...>` is
  not enough if the env marker is optional or covariant; it can still allow
  explicit env blocks through the `unknown` side. Prefer a conditional helper
  that extracts the pattern env and checks whether `TEnv extends PatternEnv`,
  while treating `unknown` as env-agnostic.

Relevant files:

- `src/router/router-interfaces.ts`
- `src/urls/pattern-types.ts`
- `src/__tests__/routes-env-compat.check.ts`

Suggested type-test shape:

```ts
const open = urls({
  home: "/",
});

const needsDb = urls<{ DB: D1Database }>()({
  users: "/users",
});

createRouter<{}>({ document: Document }).routes(open);

// @ts-expect-error router env does not satisfy the URL block env
createRouter<{}>({ document: Document }).routes(needsDb);

createRouter<{ DB: D1Database }>({ document: Document }).routes(needsDb);
```

### 2. Reconcile `/typesafety` wording after `GeneratedRouteMap` fallback

Current follow-up:

- The type system now lets `href()` and `ValidPaths` read
  `GeneratedRouteMap` when `RegisteredRoutes` is absent.
- The docs and skills should not say `href()` / `ValidPaths` remain fully
  permissive until `RegisteredRoutes` is declared.
- Keep the sharper distinction:
  - `GeneratedRouteMap` gives global path names, params, search, `href()`, and
    `ValidPaths`.
  - `RegisteredRoutes extends typeof router.routeMap` is still required when a
    global utility needs response/MIME payload metadata such as `PathResponse`.

Relevant files:

- `skills/typesafety/SKILL.md`
- `skills/response-routes/SKILL.md`
- `src/types/global-namespace.ts`

### 3. Rename the ambient namespace `RSCRouter` to `Rango` — DONE

**Status: Applied.** Renamed `RSCRouter` → `Rango` across source, codegen output,
committed `*.named-routes.gen.ts` fixtures, all apps/demos, docs, and skills in a
single pass (no deprecated compatibility namespace). Per the decision, this also
renamed the exported router interface (`RSCRouter<TEnv, TRoutes>` → `Rango<…>`)
and the related public/internal types (`RSCRouterOptions` → `RangoOptions`,
`RSCRouterContext` → `RangoContext`, `RSCRouterInternal` → `RangoInternal`,
`RSCRouterProps` → `RangoProps`). The original proposal follows.

Original follow-up:

- The ambient global namespace is public authoring surface. `Rango` likely reads
  better than `RSCRouter` for app-level augmentation:

```ts
declare global {
  namespace Rango {
    interface Env extends AppEnv {}
    interface Vars extends AppVars {}
    interface RegisteredRoutes extends typeof router.routeMap {}
  }
}
```

- Keep this scoped to the ambient namespace unless the public exported router
  interface named `RSCRouter` is intentionally being renamed too. Those are
  separate API decisions.
- If this is done before stable external adoption, prefer a one-shot rename
  across source, generated output, tests, demos, docs, and skills. Avoid adding a
  deprecated compatibility namespace unless there is an explicit migration goal.

Relevant files and checks:

- `src/types/global-namespace.ts`
- `src/build/route-types/codegen.ts`
- generated `router.named-routes.gen.ts` fixtures and demos
- docs and skills that show `declare global { namespace RSCRouter { ... } }`
- `rg -n "namespace RSCRouter|RSCRouter\\."`

## Goal

Make the skills and examples describe generated route typing without blending
three separate surfaces:

1. `router.named-routes.gen.ts` and `Rango.GeneratedRouteMap`
2. Per-module `*.gen.ts` files exporting `routes`
3. `typeof router.routeMap` exposed through `Rango.RegisteredRoutes`

This matters most for response routes and MIME routes: payload inference comes
from `typeof router.routeMap`, not from `router.named-routes.gen.ts`.

## Source Of Truth

### Global namespace interfaces

Source: `src/types/global-namespace.ts`

- `Rango.GeneratedRouteMap` is empty by default and populated by generated
  `router.named-routes.gen.ts`.
- `Rango.RegisteredRoutes` is empty by default and populated manually by the
  app when it wants global path utilities to know the router instance shape.
- `DefaultReverseRouteMap` prefers `GeneratedRouteMap`, then falls back to
  `RegisteredRoutes`, then to `Record<string, string>`.
- `DefaultHandlerRouteMap` uses `GeneratedRouteMap` only, or `{}` when missing.
  It intentionally does not default through `RegisteredRoutes`, because
  `RegisteredRoutes extends typeof router.routeMap` can create a cycle through
  `router.tsx`.

### Router named routes

Source: `src/build/route-types/codegen.ts`

`router.named-routes.gen.ts` emits:

```ts
export const NamedRoutes = {
  "blog.post": "/blog/:postId",
  "search.index": { path: "/search", search: { q: "string" } },
} as const;

declare global {
  namespace Rango {
    interface GeneratedRouteMap extends Readonly<typeof NamedRoutes> {}
  }
}
```

This gives route names, path params, and search schemas. It does not carry
response payload metadata.

Use this surface for:

- `Handler<"blog.post">`
- `Prerender<"blog.post">`
- `ctx.reverse("blog.post")` / server named-route reverse
- `RouteParams<"blog.post">` and `RouteSearchParams<"search.index">` when the
  generated map is in the program

Do not tell users to import `router.named-routes.gen.ts` by hand.

### Per-module route maps

Source: `src/build/route-types/codegen.ts`

Per-module generation emits:

```ts
export const routes = {
  index: "/",
  detail: "/:postId",
} as const;
export type routes = typeof routes;
```

This file does not augment globals. It is an explicit local exposure boundary.
Names from this map are local and should be dot-prefixed in typed handler and
reverse APIs:

```ts
import type { routes } from "./urls.gen.js";

export const Detail: Handler<".detail", routes> = (ctx) => null;
```

Use this surface for:

- `useReverse(routes)` in client components
- opt-in local handler typing such as `Handler<".detail", routes>`
- local module examples where a reusable URL module should not expose the full
  app manifest

It is okay to import per-module `.gen.ts` files when the example is explicitly
about local route maps. The "do not import generated files" guidance should be
narrowed to "do not import `router.named-routes.gen.ts`".

### Router instance route map

Source: `src/router/router-interfaces.ts`, `src/router.ts`,
`src/__tests__/reverse-types.test.ts`

`typeof router.routeMap` is the richer route map produced by the actual router
builder chain. It includes response-route payload metadata from `path.json()`,
`path.text()`, MIME routes, and other response route tags.

Use this surface for:

- `href()` / `ValidPaths`
- `PathResponse`
- response and MIME payload inference by URL pattern
- apps that want global path utilities to know response-route metadata

Recommended global augmentation when response/path utilities matter:

```ts
const router = createRouter<AppEnv>({ document: Document }).routes(urlpatterns);

declare global {
  namespace Rango {
    interface Env extends AppEnv {}
    interface Vars extends AppVars {}
    interface RegisteredRoutes extends typeof router.routeMap {}
  }
}
```

`router.namedRoutes` is not the current public surface in this codebase. The
current property is `router.routeMap`. If a `router.namedRoutes` alias is desired,
that is a separate API design decision; docs should not imply it exists today.

## Audit Findings

### `skills/typesafety/SKILL.md`

Current problems:

- The opening guidance is close, but the generated surface table should say
  explicitly that `GeneratedRouteMap` is path/search only and that
  response/MIME payload inference requires `typeof router.routeMap`.
- The recommended setup includes `RegisteredRoutes extends typeof
router.routeMap`, but the complete setup later says no manual
  `RegisteredRoutes` declaration is needed. That is only true for named-route
  handler/reverse/prerender typing, not for global path utilities or
  `PathResponse`.
- The per-module example uses `Handler<"search", routes>`. Current handler
  typing requires local route names to be dot-prefixed:
  `Handler<".search", routes>`.
- The "don't import from `*.gen.ts`" paragraph is too broad. It conflicts with
  the valid `useReverse(routes)` pattern in `/links`.

Suggested change:

- Add a "Generated Route Type Surfaces" table near the top:

| Surface             | Source                                  | Scope  | Gives                            | Does not give                  |
| ------------------- | --------------------------------------- | ------ | -------------------------------- | ------------------------------ |
| `GeneratedRouteMap` | `router.named-routes.gen.ts`            | global | names, params, search            | response payloads              |
| `routes`            | per-module `.gen.ts`                    | local  | local names, params, search      | global app map                 |
| `RegisteredRoutes`  | manual `extends typeof router.routeMap` | global | paths, params, response payloads | cycle-free default handler map |

- Replace "no manual RegisteredRoutes declaration needed" with:
  "No manual RegisteredRoutes declaration is needed for named-route handlers,
  `ctx.reverse`, or prerender. Add it when using `href`, `ValidPaths`, or
  `PathResponse` globally."
- Change `Handler<"search", routes>` to `Handler<".search", routes>`.
- Change "don't import from `*.gen.ts`" to:
  "Do not import `router.named-routes.gen.ts` directly. Per-module `.gen.ts`
  imports are the opt-in local-route pattern for `useReverse(routes)` and
  explicit local handler typing."

### `skills/response-routes/SKILL.md`

Current problem:

- `PathResponse<"/api/health">` examples omit the route map requirement. With
  no `RegisteredRoutes` augmentation, `PathResponse` falls back to a permissive
  route map and cannot infer response payloads.

Suggested change:

- Under "PathResponse (global lookup by URL pattern)", add:

```ts
// router.tsx
export const router = createRouter({ document: Document }).routes(urlpatterns);

declare global {
  namespace Rango {
    interface RegisteredRoutes extends typeof router.routeMap {}
  }
}
```

- Then say:
  "PathResponse reads from `RegisteredRoutes` by default. For local/scoped
  response typing without global augmentation, use
  `RouteResponse<typeof patterns, "routeName">`."

### `skills/links/SKILL.md`

Current state:

- Mostly correct. It clearly says `useReverse(routes)` imports a per-module
  generated `routes` map and that `ctx.reverse()` is server-only.

Suggested change:

- Add one guardrail near the `useReverse(routes)` section:
  "Import per-module `routes`, not `router.named-routes.gen.ts`. The named-routes
  file contains the whole app manifest and is server-only data."

### `skills/hooks/SKILL.md`

Current state:

- The `useReverse(routes)` one-liner is directionally correct.

Suggested change:

- Cross-link to `/links` for generated-file setup, because per-module `.gen.ts`
  files are CLI opt-in and not Vite-watched.

### `skills/rango/SKILL.md`

Current problem:

- The CLI table is accurate at a high level, but it does not explain the three
  generated type surfaces. LLM readers can infer that all `.gen.ts` files are
  interchangeable.

Suggested change:

- Add a short note after the auto-detection table:
  "`router.named-routes.gen.ts` augments `GeneratedRouteMap` for global
  named-route typing. Per-module `*.gen.ts` exports local `routes` for
  `useReverse(routes)` and explicit local handler maps. Response payload
  inference uses `typeof router.routeMap` via `RegisteredRoutes`, not
  `router.named-routes.gen.ts`."

### `docs/manifests.md`

Current problems:

- The sample shows `declare module "@rangojs/router" { interface
GeneratedRouteMap { ... } }`, but the real generated file uses
  `declare global { namespace Rango { interface GeneratedRouteMap ... } }`.
- The "dual purpose" section should clarify that runtime data flattens
  `NamedRoutes` to string paths for route matching/reverse, while static types
  keep search schemas. It should not imply response payload metadata is present.

Suggested change:

- Update the sample to match generated output from `codegen.ts`.
- Add a note:
  "`NamedRoutes` stores path/search route metadata. Response payload metadata
  lives in the router builder type (`typeof router.routeMap`) and is not emitted
  into `router.named-routes.gen.ts`."

### `docs/design/consolidate-gen-files.md`

Current problems:

- The historical examples show `Handler<"index", routes>` and
  `scopedReverse<routes>()` using bare local names. Current local-map handler
  typing expects dot-prefixed local names (`Handler<".index", routes>`), and
  `useReverse(routes)` also uses dot-prefixed names.

Suggested change:

- Since this is a design/history doc, either mark the examples as historical or
  update the "existing pattern" wording to:
  `Handler<".index", routes>` and `ctx.reverse(".post", ...)`.

## Suggested Patch Order

1. Update `/typesafety` first. This is the central consumer-facing mental model.
2. Update `/response-routes` so `PathResponse` examples show the required
   `RegisteredRoutes` augmentation.
3. Add a one-line guardrail in `/links` and `/hooks`.
4. Update `/rango` CLI generated-file note.
5. Fix `docs/manifests.md` generated augmentation syntax.
6. Clean the historical examples in `docs/design/consolidate-gen-files.md`.

## Verification

After doc edits:

- Run `rg -n "Handler<\"[^\"]+\", routes" packages/rangojs-router/skills packages/rangojs-router/docs`
  and confirm examples with explicit local maps use dot-prefixed local names.
- Run `rg -n "declare module \"@rangojs/router\"|GeneratedRouteMap" packages/rangojs-router/docs packages/rangojs-router/skills`
  and confirm generated map docs use `declare global { namespace Rango }`.
- Run `rg -n "PathResponse<" packages/rangojs-router/skills packages/rangojs-router/docs`
  and confirm each global/default example mentions `RegisteredRoutes` or passes
  an explicit route map.
- Run `git diff --check`.
