# `@rangojs/openapi` — High-Level API Design

> Status: design draft. This lays out the public API surface before implementation.
> Nothing here changes `@rangojs/router`; this is a userland layer over its
> dynamic-routing primitives.

## Principle

A single **contract** is the source of truth. You describe each endpoint once —
its path, methods, request/response schemas, and handler — and the package
projects that contract into everything else:

```
                         ┌─ renderRoutes(path, resources) ─→ path.json items  (the only Rango-coupled piece)
   resources  ───────────┼─ toOpenApi(resources, info)    ─→ OpenAPI 3.1 doc  (pure function)
  (the contract,         ├─ createClient(resources, opts) ─→ typed fetch client (pure function)
   one source of truth)  └─ runtime validation             ─→ body/response parse → problem+json
```

Three rules the whole design follows:

1. **Core is frozen.** No changes to `@rangojs/router`. The package only imports
   stable public types/values (`ExtractParams`, `ResponseHandlerContext`,
   `RouterError`, `ProblemDetails`, the `path` handle).
2. **Types flow from the contract, never from Rango inference.** The package does
   not read `_responses`/`_routes`/`RouteResponse`/`ExtractRoutes`. All type
   safety derives from `typeof resources` via Standard Schema inference.
3. **Schemas are Standard Schema.** Zod / Valibot / ArkType / any
   `@standard-schema/spec` value. This survives type erasure (a runtime value),
   is validator-agnostic, converts to JSON Schema for OpenAPI, and doubles as
   runtime validation.

Reverse and named routes work out of the box: `renderRoutes` emits ordinary named
`path.json` items, and Rango's route discovery **executes the entry** (it does not
parse source literals), so generated routes register in the route map and the
definitive `named-routes.gen.ts` exactly like hand-written ones.

---

## 1. The contract — `resource()`

The unit is **one path = one method-keyed resource**. Because Rango routing is
verb-agnostic (one handler answers every method on a path), per-method is the
faithful shape — and the method keys supply the HTTP verbs OpenAPI needs.

```ts
import { resource } from "@rangojs/openapi";
import { RouterError } from "@rangojs/router";
import { z } from "zod";

const CartItem = z.object({
  itemId: z.string(),
  productId: z.string(),
  quantity: z.number().int(),
});

export const cart = resource("/cart", {
  name: "cart", // reused as the Rango route name + OpenAPI operationId base
  summary: "Cart operations",
  methods: {
    get: {
      response: z.object({ items: z.array(CartItem) }),
      handler: (ctx) => ({ items: cartStore }), // return checked against `response`
    },
    post: {
      body: z.object({
        productId: z.string(),
        quantity: z.number().int().positive().optional(),
      }),
      response: z.object({ items: z.array(CartItem), added: CartItem }),
      handler: (ctx) => {
        const { productId, quantity } = ctx.body; // typed from `body` + already validated
        if (!products.has(productId))
          throw new RouterError("NOT_FOUND", "no such product", {
            status: 404,
          });
        // ...
        return { items: cartStore, added };
      },
    },
    delete: {
      response: z.object({ cleared: z.literal(true) }),
      handler: () => {
        cartStore = [];
        return { cleared: true as const };
      },
    },
  },
});
```

### Method spec fields

| Field                       | Type                    | Purpose                                                                         |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `handler`                   | `(ctx) => Response-ish` | the implementation; `ctx` is typed from the pattern + schemas                   |
| `body?`                     | Standard Schema         | request body; parsed + validated → `ctx.body`; emitted as `requestBody`         |
| `query?`                    | Standard Schema         | query params; parsed + validated → `ctx.query`; emitted as query `parameters`   |
| `params?`                   | Standard Schema         | optional coercion/validation of path params (default: strings from the pattern) |
| `response?`                 | Standard Schema         | 2xx body; return type is checked against it; emitted as the `200` response      |
| `summary?` / `operationId?` | string                  | OpenAPI doc fields (operationId defaults to `name` + method)                    |

### The typed handler context

```ts
interface ApiContext<
  TPattern extends string,
  TBody,
  TQuery,
> extends ResponseHandlerContext<ExtractParams<TPattern>> {
  params: ExtractParams<TPattern>; // from the pattern (":productId" → { productId: string })
  body: InferOutput<TBody>; // parsed + validated; `undefined` when no `body` schema
  query: InferOutput<TQuery>; // parsed + validated; `undefined` when no `query` schema
  // plus the standard ResponseHandlerContext surface: request, reverse, header, get, ...
}
```

`ctx.params` comes from the pattern via Rango's public `ExtractParams`. `ctx.body`
and `ctx.query` are inferred from their schemas — no more
`await ctx.request.json() as {…}` casts.

---

## 2. Rendering — `renderRoutes(path, resources)`

Inside `urls()`, project the contract into ordinary Rango route items.

```ts
import { urls } from "@rangojs/router";
import { renderRoutes, openApiRoute } from "@rangojs/openapi";
import { cart, product, catalog } from "../shop.api";

const resources = [catalog, product, cart];

export const apiShopPatterns = urls(({ path }) => [
  renderRoutes(path, resources), // nested array — urls() flattens (.flat(3))
  openApiRoute(path, resources, {
    info: { title: "Shop API", version: "1.0.0" },
  }),
]);
```

`renderRoutes` builds one `path.json(pattern, multiplexHandler, { name })` per
resource. The generated multiplex handler:

1. Looks up the spec for `ctx.request.method`; returns **405** if undeclared.
2. If `body`/`query` schemas exist, parses and validates them, populating
   `ctx.body` / `ctx.query`; a validation failure throws `RouterError` →
   `application/problem+json`.
3. Calls the method's `handler`.
4. If a `response` schema exists, optionally asserts the return shape.

Signature:

```ts
function renderRoutes(
  path: PathHelpers["path"],
  resources: AnyResource[],
): RouteItem[];
```

Note: `renderRoutes(...)` can be a bare array element (no spread) — `urls()`
flattens to depth 3 at runtime. The package never relies on the spread for typing,
because its types come from the contract, not from `typeof apiShopPatterns`.

---

## 3. OpenAPI — `toOpenApi()` and `openApiRoute()`

`toOpenApi` is a **pure function of the contract** — no Rango, no routing, no DOM.

```ts
function toOpenApi(
  resources: AnyResource[],
  opts: {
    info: { title: string; version: string };
    servers?: { url: string }[];
  },
): OpenApiDocument; // OpenAPI 3.1
```

It emits, per resource: one path, one operation per declared method (request body
from `body`, query/path `parameters`, the `200` response from `response`), plus a
shared `application/problem+json` error component attached to every operation
(the uniform RFC 9457 shape Rango already returns).

`openApiRoute` is the thin Rango binding that serves it:

```ts
function openApiRoute(
  path: PathHelpers["path"],
  resources: AnyResource[],
  opts: {
    info: { title: string; version: string };
    servers?: { url: string }[];
    jsonPath?: string; // default "/openapi.json"
    ui?: "scalar" | "swagger" | false; // default "scalar"
    docsPath?: string; // default "/docs"
  },
): RouteItem[];
```

It returns:

- `path.json(jsonPath, () => DOC)` where `DOC = toOpenApi(resources, opts)` is
  computed once at module-eval (build-static — see §5);
- when `ui` is set, a `path(...)` docs page route (an RSC segment — see §5).

---

## 4. Typed client — `createClient()`

The contract-sourced successor to the `/api-client` skill. Per-method typed calls,
no codegen, no reliance on `RouteResponse`.

```ts
import { createClient, ApiError } from "@rangojs/openapi";
import { resources } from "../shop.api";

const api = createClient(resources, { baseUrl: import.meta.env.VITE_API_URL });

const cart = await api.cart.get(); // typed: { items: CartItem[] }
const r = await api.cart.post({ body: { productId: "p1" } }); // body typed in; { items, added } out
await api.product.get({ params: { productId: "p1" } }); // params required + typed from the pattern
// @ts-expect-error — wrong body shape
await api.cart.post({ body: { nope: 1 } });
```

```ts
function createClient<TResources extends readonly AnyResource[]>(
  resources: TResources,
  opts?: { baseUrl?: string; fetch?: typeof fetch },
): Client<TResources>; // { [name]: { [method]: (args) => Promise<Response-of-that-method> } }
```

On a non-2xx response it throws `ApiError` carrying the typed `ProblemDetails`.

---

## 5. Build-time generation (per surface)

`Prerender`/`Static` are RSC **segment** primitives — they do not wrap `path.json`
response routes. The build-time goal is met per surface instead:

| Surface                        | Mechanism                                                                                              | Why it works                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/openapi.json` (data)         | `const DOC = toOpenApi(resources)` at module-eval; handler returns the constant (optionally `cache()`) | the doc derives only from the contract → fully known at build; no per-request rebuild; avoids the build-discovery `__unresolved_reverse` footgun |
| `openapi.json` (file artifact) | package **Vite plugin / CLI** writes the file at build                                                 | for CI, codegen, publishing a checked-in spec                                                                                                    |
| `/docs` (UI page)              | author as an RSC `path(...)` page → wrap in `Static` / `Prerender`                                     | it is a component segment — exactly what those primitives bake                                                                                   |

---

## 6. What it relies on — and what it doesn't

**Imports from `@rangojs/router` (all stable/public):** `ExtractParams` (type),
`ResponseHandlerContext` (type), the `path` handle (type), `RouterError` (value),
`ProblemDetails` (type).

**Does NOT touch:** `_responses` / `_routes` phantoms, `RouteResponse`,
`ExtractRoutes`/`ExtractResponses`, or any internal inference. This is what makes
the package self-contained and keeps the spread-vs-flatten asymmetry irrelevant.

**Reverse / named routes:** free. Generated routes register at runtime and land in
the definitive `named-routes.gen.ts` (produced by execute-the-entry discovery).

---

## 7. Package module layout

Each module consumes only `resources` (except `renderRoutes`, the one Rango binding):

| Module                           | Depends on                  | Unit-testable with    |
| -------------------------------- | --------------------------- | --------------------- |
| `resource()` + contract generics | Standard Schema             | `tsc` (type-level)    |
| `toOpenApi(resources)`           | nothing                     | plain test, no router |
| `createClient(resources)`        | `fetch`, `ProblemDetails`   | plain test, no DOM    |
| `renderRoutes(path, resources)`  | Rango `path`, `RouterError` | router e2e            |
| `openApiRoute(path, …)`          | `path`, `toOpenApi`         | router e2e            |
| build emit (Vite plugin / CLI)   | `toOpenApi`                 | snapshot test         |

`toOpenApi` and `createClient` are pure functions of the contract, so the
schema→OpenAPI and schema→client halves are provable in isolation; `renderRoutes`
is a thin (~30-line) adapter.

---

## 8. The load-bearing generic (to compile-verify first)

Everything hinges on one inference chain: `resource<TConfig>(...)` capturing the
per-method schemas so `ctx.body` is typed inside each handler, returns are checked
against `response`, and `createClient` exposes per-method typed calls. Sketch:

```ts
import type { StandardSchemaV1 as SS } from "@standard-schema/spec";
import type { ExtractParams, ResponseHandlerContext } from "@rangojs/router";

type Infer<S> = S extends SS ? SS.InferOutput<S> : undefined;
type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

interface MethodSpec<TPattern extends string> {
  summary?: string;
  body?: SS;
  query?: SS;
  params?: SS;
  response?: SS;
  handler: (
    ctx: ApiContext<TPattern, this["body"], this["query"]>,
  ) =>
    | Infer<this["response"]>
    | Response
    | Promise<Infer<this["response"]> | Response>;
}

interface ApiContext<
  TPattern extends string,
  TBody,
  TQuery,
> extends ResponseHandlerContext<ExtractParams<TPattern>> {
  params: ExtractParams<TPattern>;
  body: Infer<TBody>;
  query: Infer<TQuery>;
}
```

(The `this`-type reference above is illustrative; the real signature threads the
per-method schema types through generics so each handler's `ctx.body` and return
are checked. Proving this against the test-app `api-shop` resources — including the
multi-method `cart` — is the first implementation step, exactly as `/api-client`
was compile-verified.)

---

## 9. Phasing

1. **Prove the contract generics** (`resource` / `ApiContext` / `createClient`
   types) against `api-shop` resources with `tsc`. De-risks the whole package on
   one file.
2. **`toOpenApi`** — pure emitter + snapshot tests (paths, per-method operations,
   problem+json component).
3. **`renderRoutes` + `openApiRoute`** — the Rango adapter; e2e in dev + production.
4. **`createClient`** — contract-sourced typed client (supersedes the `/api-client`
   recipe for contract routes).
5. **Build emit** — Vite plugin / CLI for the on-disk `openapi.json` artifact; the
   `/docs` page as a prerenderable RSC route.

### Resolved decisions

- **No `search` integration.** Query lives entirely in the contract; the rendered
  multiplex handler validates it. We do **not** bridge to Rango's `search`
  descriptor. Rango stays a pure handler-mounting substrate — it mounts one handler
  per path and the package's handler dispatches `get`/`post`/`put` per the resource
  definition. Rango never sees query/body schemas.
- **Response inference from the contract.** The `response` schema in the resource is
  the type source. Rango's `_responses` phantom is never read.
- **Validation: unlocked, Zod advised.** Standard Schema so any validator works;
  docs recommend Zod as the default. The resource owns the choice.
- **Per-status responses (deferred, not blocking).** `response` = 2xx; a
  `responses: { [status]: Schema }` form and an `errors: [{ status, code }]`
  enumeration can land later — errors are already uniformly documented via the
  shared problem+json component.

---

## 10. The general pattern — Rango as a DSL substrate

This package is **instance #1** of a broader pattern, not a one-off. A
self-contained "app" owns its own domain complexity and emits **Rango DSL** as its
output; Rango serves it without understanding the domain — it knows only routing
and rendering. The seam between them is the **route item as an intermediate
representation (IR)**.

```
   app authoring surface              what Rango sees
   (schemas, UI tree, plugin          (plain values it can route + render)
    manifest, CMS content types)
            │   compiles to                   │
            ▼                                  ▼
   ┌─────────────────────┐   route items   ┌──────────────────────────┐
   │  the layer / "app"   │ ──────────────▶ │  Rango: route, render,    │
   │  (owns complexity;   │                 │  reverse, manifest, cache,│
   │   derives OpenAPI,   │                 │  middleware, prerender    │
   │   client, docs, UI…) │                 │  (blind to your domain)   │
   └─────────────────────┘                 └──────────────────────────┘
```

Three Rango properties make this work (and they are load-bearing):

1. **Route items are plain values** — any layer can emit them programmatically; the
   IR is data, not framework magic.
2. **Discovery executes the entry** (not source parsing) — so _generated_ routes are
   first-class: names, reverse, manifest, prerender, middleware, caching all work,
   with Rango unaware a layer produced them.
3. **The framework is blind to the domain** — Rango sees only
   `path.json(pattern, handler, { name })`; it knows nothing of "schema,"
   "contract," "plugin," or "content type," so the layer can encode arbitrary
   complexity above the IR.

The substrate contract: **the layer owes valid route items; Rango provides
everything from routing down.** Neither reaches into the other. The same shape
applies to a CMS (content types → routes + pages + admin UI), a plugin system (each
plugin emits a DSL slice the host mounts), a UI/app builder, or a CRUD/forms
generator — each is "an app that happens to render Rango's DSL."

**Discipline:** the "contract is the sole source of truth / only public types
imported / core frozen" rules are what _keep the seam a seam_. If a layer reaches
into Rango internals — or Rango grows to understand schemas — the substrate property
breaks. So this package is the **reference implementation**: keep its seam clean and
the pattern is extractable later as a thin general "mountable app" primitive — but
do **not** abstract that prematurely. Prove it once here; let the general primitive
fall out.
