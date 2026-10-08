# `@rangojs/openapi` — High-Level API Design

> Status: design draft. This lays out the public API surface before implementation.
> Nothing here changes `@rangojs/router`; this is a userland layer over its
> dynamic-routing primitives.

## Principle

A single **contract** is the source of truth. The contract is a flat list of
**operations** — one per HTTP verb + path — written in Rango's own DSL idiom:
destructure verb helpers, call them, return route items in an array. You describe
each operation once (its method, path, request/response schemas, and handler) and
the package projects that contract into everything else:

```
                          ┌─ api(builder)        ─→ coalesced path.json items  (the only Rango-coupled piece)
   operations  ───────────┼─ toOpenApi(contract) ─→ OpenAPI 3.1 doc            (pure function)
  (the contract,          ├─ createClient(types) ─→ typed fetch client         (type-only, no value import)
   one source of truth)   └─ runtime validation   ─→ body/query/response parse → problem+json
```

The shape mirrors the router exactly. Where Rango writes:

```ts
urls(({ path, middleware }) => [path.json("/cart", handler, { name: "cart" })]);
```

this package writes:

```ts
api(({ get, post, middleware }) => [
  get("/cart", { response, handler }),
  post("/cart", { body, response, handler }),
]);
```

Same destructured helpers, same flat array, same `middleware(...)` / `cache(...)`
wrappers. No method-chaining, no bespoke "resource" object — operations are the
unit, exactly as OpenAPI itself models an API as paths → operations.

Three rules the whole design follows:

1. **Core is frozen.** No changes to `@rangojs/router`. The package only imports
   stable public types/values (`ExtractParams`, `ResponseHandlerContext`,
   `RouterError`, `ProblemDetails`, the `path` handle).
2. **Types flow from the contract, never from Rango inference.** The package does
   not read `_responses`/`_routes`/`RouteResponse`/`ExtractRoutes`. All type
   safety derives from the operation specs via Standard Schema inference. Each verb
   helper is its own generic call, so `ctx.body`/`ctx.query`/`ctx.params` are typed
   inside the handler and the return is checked against `response` — proven under
   `tsc --strict` (see §8).
3. **Schemas are Standard Schema.** Zod / Valibot / ArkType / any
   `@standard-schema/spec` value — a runtime value that survives type erasure, is
   validator-agnostic, and doubles as runtime validation. It does **not** carry its
   own JSON-Schema conversion; the OpenAPI emitter owns that seam explicitly (§3).

Reverse and named routes work out of the box: `api(...)` emits ordinary named
`path.json` items, and Rango's route discovery **executes the entry** (it does not
parse source literals), so generated routes register in the route map and the
definitive `named-routes.gen.ts` exactly like hand-written ones.

---

## 1. The contract — flat verb operations

The unit is **one operation = one verb + path**. Verb helpers
(`get`/`post`/`put`/`patch`/`delete`) are destructured from the `api(...)` builder
alongside Rango's real grouping directives (`middleware`, `cache`). Each returns an
operation that is both a mountable route item and a typed contract entry.

```ts
import { api } from "@rangojs/openapi";
import { RouterError, createVar } from "@rangojs/router";
import { z } from "zod";
import { requireAuth, requireRole, cors } from "./mw";

const CartItem = z.object({
  itemId: z.string(),
  productId: z.string(),
  quantity: z.number().int(),
});
const CurrentUser = createVar<{ id: string; role: "user" | "admin" }>({
  cache: false,
});

export const shop = api(
  ({ get, post, delete: del, middleware }) => [
    // cross-cutting middleware — Rango's real directive, host-run for every operation below
    middleware([cors], () => [
      get("/catalog", {
        operationId: "listCatalog",
        query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
        response: z.object({ products: z.array(Product), total: z.number() }),
        cache: { ttl: 60, swr: 300 }, // per-operation cache (GET only)
        handler: (ctx) => ({ products: list(ctx.query.page), total: count() }),
      }),

      // the "/cart resource" is just a middleware group — pure DSL, no special construct
      middleware([requireAuth], () => [
        get("/cart", {
          operationId: "getCart",
          response: z.object({ items: z.array(CartItem) }),
          handler: (ctx) => ({ items: cartOf(ctx.get(CurrentUser)!.id) }),
        }),
        post("/cart", {
          operationId: "addToCart",
          body: z.object({
            productId: z.string(),
            quantity: z.number().int().positive().default(1),
          }),
          response: z.object({ items: z.array(CartItem), added: CartItem }),
          errors: [
            { status: 404, code: "PRODUCT_NOT_FOUND" },
            { status: 409, code: "OUT_OF_STOCK" },
          ],
          handler: (ctx) => {
            const { productId, quantity } = ctx.body; // typed + already validated
            if (!products.has(productId))
              throw new RouterError("PRODUCT_NOT_FOUND", "no such product", {
                status: 404,
              });
            if (!inStock(productId, quantity))
              throw new RouterError("OUT_OF_STOCK", "insufficient stock", {
                status: 409,
              });
            return {
              items: addToCart(productId, quantity),
              added: lastAdded(),
            };
          },
        }),
        del("/cart", {
          operationId: "clearCart",
          use: [requireRole("admin")], // per-operation guard
          response: z.object({ cleared: z.literal(true) }),
          handler: () => {
            clearCart();
            return { cleared: true as const };
          },
        }),
      ]),
    ]),
  ],
  {
    info: { title: "Shop API", version: "1.0.0" },
    ui: "scalar", // serves /openapi.json + /docs
  },
);
```

### Operation spec fields

| Field                                 | Type                          | Purpose                                                                                   |
| ------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `handler`                             | `(ctx) => Response-ish`       | the implementation; `ctx` is typed from the pattern + schemas                             |
| `body?`                               | Standard Schema               | request body; parsed + validated → `ctx.body`; emitted as `requestBody` (input shape)     |
| `query?`                              | Standard Schema               | query params; parsed + validated → `ctx.query`; emitted as query `parameters`             |
| `params?`                             | Standard Schema               | optional coercion/validation of path params (default: strings from the pattern)           |
| `response?`                           | Standard Schema               | 2xx body; return type is checked against it; emitted as the `200` response (output shape) |
| `errors?`                             | `{ status, code, schema? }[]` | declared non-2xx outcomes; emitted as per-status responses; narrows the client error type |
| `use?`                                | `Guard[]`                     | per-operation middleware, run inside the matched-verb branch (see §2)                     |
| `cache?`                              | `{ ttl, swr? }`               | per-operation cache; translated to a verb-gated Rango `cache()` (see §2)                  |
| `operationId?` / `summary?` / `tags?` | string / string / string[]    | OpenAPI doc fields (`operationId` defaults to verb + path slug)                           |
| `name?`                               | string                        | Rango route name for `reverse()` — **per path**, not per op (see below)                   |

### `operationId` vs route `name`

Two identities, deliberately separate:

- **`operationId`** is per **operation** — it names the OpenAPI operation and the
  typed client method (`api.addToCart(...)`). Unique across the contract.
- **`name`** is per **path** — Rango coalesces same-path operations into one
  `path.json`, which has exactly one route name for `reverse()` / `named-routes.gen.ts`.
  Set it once on any operation of that path (same-path ops must agree, else a build
  error); it defaults to a slug derived from the pattern.

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
`await ctx.request.json() as {…}` casts. `ctx.get(Var)` reads values set by
host-run middleware (real Rango `ContextVar`).

---

## 2. Rendering & coalescing — `api(builder, opts)`

`api(...)` is the one Rango-coupled piece. It runs the builder, collects the
operations (including those nested in `middleware(...)` / `cache(...)` groups), and
**coalesces operations by path** into ordinary Rango route items. Because Rango is
verb-agnostic — one handler answers every method on a path — every operation on a
given path becomes a single `path.json(pattern, multiplexHandler, { name }, use)`.

The generated multiplex handler, for each request:

1. Looks up the operation for `ctx.request.method`.
2. Synthesizes HTTP method semantics the verb-agnostic host doesn't:
   - **405** for an undeclared verb, with a correct `Allow` header listing the
     declared methods (RFC 7231).
   - **OPTIONS** → `204` with the same `Allow` header (CORS preflight).
   - **HEAD** → derived from `GET` unless `head` is declared.
3. Runs the operation's per-op `use` guards (auth, etc.) inside the matched branch.
4. If `body`/`query`/`params` schemas exist, parses and validates them, populating
   `ctx.body` / `ctx.query` / `ctx.params`; a failure throws `RouterError` →
   `application/problem+json`.
5. Calls the operation's `handler`.
6. If a `response` schema exists, optionally asserts the return shape.

```ts
function api<const TOps extends readonly AnyOperation[]>(
  builder: (helpers: ApiHelpers) => TOps | NestedItems<TOps>,
  opts?: ApiDocOptions,
): ApiModule<TOps>; // mountable UrlPatterns; `typeof` carries the contract for the client
```

`api(...)` returns an `ApiModule` you mount with Rango's `include`:

```ts
export const urlpatterns = urls(({ include, layout, path }) => [
  include("/api/v1", shop, { name: "v1" }), // /api/v1/cart, reverse("v1.addToCart")
  layout(MarketingLayout, () => [path("/", Home, { name: "home" })]),
]);
```

When `opts.info` is given, the module also mounts `/openapi.json` (a `path.json`
returning the precomputed doc — see §5) and, when `opts.ui` is set, a `/docs` RSC
page segment.

### Two middleware tiers

The verb-agnostic host (one handler per path) creates one real seam:

| Tier                        | Written as                     | Runs                                                                                                                                                                                 |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-cutting / path-shared | `middleware(fns, () => [ops])` | **Host-run** real Rango middleware — full pipeline: short-circuit by throwing/returning a `Response`, `ctx.set`/`ctx.get` `ContextVar`s, runs for every verb on the path             |
| Per-operation               | `op.use: [...]`                | **Package-run** guards inside the matched-verb branch (Rango cannot scope middleware to a single verb on a shared handler); receive `ApiContext`; `throw RouterError` → problem+json |

Per-op `cache` is likewise translated to a Rango `cache()` gated to that verb
(typically only `GET`), since one `path.json` serves all methods.

---

## 3. OpenAPI — `toOpenApi()`

`toOpenApi` is a **pure function of the contract** — no routing, no DOM.

```ts
function toOpenApi(
  contract: AnyOperation[] | ApiModule<any>,
  opts: {
    info: { title: string; version: string };
    servers?: { url: string }[];
    schemaToJsonSchema?: (schema: SS, io: "input" | "output") => JsonSchema; // see seam below
  },
): OpenApiDocument; // OpenAPI 3.1
```

It groups operations by path into one `PathItem` each, with one operation object
per verb:

- `requestBody` from `body`, `parameters` from `query` + path params;
- the `200` response from `response`;
- one response entry **per declared `errors` status**, each referencing a shared
  `application/problem+json` component (the RFC 9457 shape Rango already returns),
  refined by a `code` enum so consumers can read which codes a status carries;
- metadata (`summary`, `operationId`, `tags`, plus `description`/`example`/
  `deprecated`/`format` when declared) from first-class operation/schema fields.

### The conversion seam (stated honestly)

Standard Schema validates; it does **not** define JSON-Schema conversion. So
`toOpenApi` owns an explicit `schemaToJsonSchema` adapter:

- **Per-validator, pluggable.** Zod ships a built-in (`z.toJSONSchema`); Valibot /
  ArkType plug in their own, mirroring ts-rest's `schemaTransformers`.
- **Direction-aware.** `body`/`query`/`params` emit from the **input** side,
  `response` from the **output** side — a body with `.default()`/coercion documents
  the pre-validation shape, not the post-validation one.
- **Lossy by nature, not by us.** Refinements, transforms, branded types, recursive
  schemas don't fully survive any schema→JSON-Schema conversion (a JSON-Schema
  limitation, not a Zod one). Where fidelity matters, declare the OpenAPI-facing
  shape explicitly.
- **OpenAPI 3.1.** Some emitters top out at 3.0; `toOpenApi` runs a post-processing
  pass to land genuine 3.1 (a real differentiator over emitters stuck at 3.0.x).

---

## 4. Typed client — `createClient()` (type-only)

The contract-sourced successor to the `/api-client` skill. Flat, `operationId`-keyed
calls, no codegen — and **type-only**: the client never imports operation values, so
no handler closures or validator code leak into the client bundle.

```ts
import { createClient, ApiError } from "@rangojs/openapi";
import type { Shop } from "../shop.api"; //  export type Shop = typeof shop  — erased at build
import { routes } from "../shop.api.gen"; //  generated: { addToCart: "/cart", getCart: "/cart", ... }

const api = createClient<Shop>(routes, {
  baseUrl: import.meta.env.VITE_API_URL,
});

const cart = await api.getCart(); // typed: { items: CartItem[] }
const r = await api.addToCart({ body: { productId: "p1" } }); // body typed in; { items, added } out
await api.updateItem({ params: { itemId: "i1" }, body: { quantity: 2 } });
// @ts-expect-error — wrong body shape
await api.addToCart({ body: { nope: 1 } });
```

```ts
function createClient<TContract>(
  routes: Record<string, string>, // operationId → pattern; plain strings, leaks nothing
  opts?: { baseUrl?: string; fetch?: typeof fetch },
): Client<TContract>; // { [operationId]: (args) => Promise<Response-of-that-op> }
```

- **Runtime input is a string routes map** (operationId → pattern), generated
  alongside `named-routes.gen.ts`. The request/response **types** flow via the
  `TContract` type parameter (`typeof shop`, imported `type`-only). No operation
  value is read at runtime, so importing the client pulls in zero server code.
- **Cross-repo is first-class.** A separate frontend consumes the published
  `openapi.json` (§5) — or a handler-stripped `contract.d.ts` + the routes map —
  and never imports the backend module.
- On a non-2xx response it throws `ApiError`, typed as
  `ApiError<ProblemDetails & { code: <union of that op's declared codes> }>`, so
  `err.code` narrows against the operation's `errors`.

> A `dist/` bundle guard (extending the existing build walker) fails the build if a
> client chunk imports any operation `handler` symbol — the value-leak is otherwise
> silent.

---

## 5. Build-time generation (per surface)

`Prerender`/`Static` are RSC **segment** primitives — they do not wrap `path.json`
response routes. The build-time goal is met per surface instead:

| Surface                        | Mechanism                                                                                                   | Why it works                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/openapi.json` (data)         | `const DOC = toOpenApi(contract, opts)` at module-eval; handler returns the constant (optionally `cache()`) | the doc derives only from the contract → fully known at build; no per-request rebuild                  |
| `openapi.json` (file artifact) | package **Vite plugin / CLI** writes the file at build                                                      | for CI, codegen, publishing a checked-in spec, generating a cross-repo client                          |
| `/docs` (UI page)              | RSC `path(...)` page (Scalar/Swagger) → wrap in `Static` / `Prerender`                                      | it is a component segment — RSC directives (`loading`, `layout`) apply here, not to the JSON endpoints |

---

## 6. What it relies on — and what it doesn't

**Imports from `@rangojs/router` (all stable/public):** `ExtractParams` (type),
`ResponseHandlerContext` (type), the `path` handle (type), `RouterError` (value),
`ProblemDetails` (type), `createVar` (value, for typed middleware hand-off).

**Does NOT touch:** `_responses` / `_routes` phantoms, `RouteResponse`,
`ExtractRoutes`/`ExtractResponses`, or any internal inference. This is what makes
the package self-contained.

**Reverse / named routes:** free. Coalesced routes register at runtime and land in
the definitive `named-routes.gen.ts` (produced by execute-the-entry discovery).

---

## 7. Package module layout

| Module                            | Depends on                     | Unit-testable with    |
| --------------------------------- | ------------------------------ | --------------------- |
| verb helpers + contract generics  | Standard Schema                | `tsc` (type-level)    |
| `toOpenApi(contract)`             | a `schemaToJsonSchema` adapter | plain test, no router |
| `createClient<T>(routes)`         | `fetch`, `ProblemDetails`      | plain test, no DOM    |
| `api(builder)` (collect+coalesce) | Rango `path`, `RouterError`    | router e2e            |
| build emit (Vite plugin / CLI)    | `toOpenApi`                    | snapshot test         |

`toOpenApi` and `createClient` are pure/type-only with respect to the contract, so
the schema→OpenAPI and schema→client halves are provable in isolation; `api(...)` is
the thin adapter (collect operations, coalesce by path, emit `path.json` items).

---

## 8. The load-bearing generic (compile-verified)

Everything hinges on one inference shape: each verb helper is **its own generic
call**, so the operation's schemas are captured from the same argument the handler
literal sits in — the one configuration TypeScript reliably contextual-types. This
was verified under `tsc 5.9.3 --strict` (the proof is `src/types.ts` +
`src/types.test-d.ts`; `tsc --noEmit` is clean): `ctx.body` / `ctx.query` /
`ctx.params` infer, a typo on `ctx.body` errors, a wrong return is checked against
`response`, and the operationId-keyed client resolves — with no spurious errors.

```ts
import type { StandardSchemaV1 as SS } from "@standard-schema/spec";
import type { ExtractParams, ResponseHandlerContext } from "@rangojs/router";

type Infer<S> = S extends SS ? SS.InferOutput<S> : undefined;

interface OpSpec<TPattern extends string, OpId extends string, B, Q, R> {
  operationId?: OpId; // captured as a literal — see Verb's `const OpId`
  summary?: string;
  tags?: string[];
  name?: string;
  body?: B;
  query?: Q;
  params?: SS;
  response?: R;
  errors?: { status: number; code: string; schema?: SS }[];
  use?: Guard[];
  cache?: { ttl: number; swr?: number };
  handler: (
    ctx: ApiContext<TPattern, B, Q>,
  ) => Infer<R> | Response | Promise<Infer<R> | Response>;
}

interface ApiContext<
  TPattern extends string,
  B,
  Q,
> extends ResponseHandlerContext<ExtractParams<TPattern>> {
  params: ExtractParams<TPattern>;
  body: Infer<B>;
  query: Infer<Q>;
}

// each verb is its own generic call; B/Q/R inferred from the spec, and
// `const OpId` captures the literal operationId so the client keys flat by it
type Verb = <
  TPattern extends string,
  const OpId extends string = string,
  B extends SS | undefined = undefined,
  Q extends SS | undefined = undefined,
  R extends SS | undefined = undefined,
>(
  pattern: TPattern,
  spec: OpSpec<TPattern, OpId, B, Q, R>,
) => Operation<TPattern, OpId, B, Q, R>;
```

Notes proven during de-risking:

- **The flat verb call is the inferring shape.** A single nested
  `resource(pattern, { methods: {...} })` form does **not** infer (`ctx.body`
  collapses to `undefined`/`any`, the return goes unchecked) — the sibling-key
  contextual-typing trap. The flat `verb(pattern, spec)` call avoids it entirely.
- **Optional body.** When `body` is omitted, `ctx.body` is `undefined`; when
  present, it is exactly the schema's output type (no `| undefined` papercut).
- **Same-path operations** are independent calls (no type-level grouping needed);
  the client keys flat by `operationId`, so no tuple-by-path regrouping is required.

Phase-1 status: **done** — the verb generics and the operationId-keyed client are
proven in `src/types.ts` + `src/types.test-d.ts` (`tsc --noEmit` clean, all
`@ts-expect-error` negatives firing).

---

## 9. Phasing

1. **Prove the verb-helper generics** (`OpSpec` / `ApiContext` / the `Verb` type)
   against `api-shop` operations with `tsc`, including the multi-verb `/cart` path.
   De-risks the whole package on one file.
2. **`toOpenApi`** — pure emitter + the `schemaToJsonSchema` adapter + snapshot tests
   (per-path grouping, per-verb operations, per-status `errors`, problem+json
   component, 3.1 post-pass, input/output direction).
3. **`api(...)`** — the collect-and-coalesce adapter; e2e in dev + production,
   including 405-has-`Allow`, OPTIONS preflight, HEAD-from-GET, and per-op middleware.
4. **`createClient`** — type-only client (string routes map + `typeof` contract;
   supersedes the `/api-client` recipe for contract routes) + the bundle guard.
5. **Build emit** — Vite plugin / CLI for the on-disk `openapi.json` artifact; the
   `/docs` page as a prerenderable RSC route.

### Resolved decisions

- **Operation-centric, flat.** The contract is a flat list of `verb(pattern, spec)`
  operations, written in Rango's DSL idiom — not a method-keyed "resource" object.
  This matches OpenAPI's own paths→operations model, infers cleanly (§8), expresses
  shared concerns with Rango's real `middleware()`/`cache()` directives, and yields a
  flat `operationId`-keyed client. `api(...)` coalesces same-path operations into one
  verb-agnostic `path.json`.
- **`errors[]` is first-class (v1, not deferred).** Declared per-status codes are
  emitted as per-status OpenAPI responses and narrow the client's thrown error type.
  Arbitrary per-status response **bodies** can still expand later additively; the
  client's throw shape is reserved now so that expansion is non-breaking.
- **No `search` integration.** Query lives entirely in the contract; the multiplex
  handler validates it. We do **not** bridge to Rango's `search` descriptor — Rango
  stays a pure handler-mounting substrate. (Note: `ResponseHandlerContext` has no
  typed query today, so the contract's `query` adds a capability rather than
  duplicating one.)
- **Response inference from the contract.** The `response` schema is the type source;
  Rango's `_responses` phantom is never read.
- **Client is type-only.** `createClient` consumes request/response **types** plus a
  string routes map — never operation values — so no server code reaches the client
  and a separate frontend repo can consume it via `openapi.json` or a `.d.ts`.
- **Validation: unlocked, Zod advised.** Standard Schema so any validator works; docs
  recommend Zod as the default. The operation owns the choice. The OpenAPI conversion
  seam is explicit and per-validator (§3).

---

## 10. The general pattern — Rango as a DSL substrate

This package is **instance #1** of a broader pattern. A self-contained "app" owns its
domain complexity and emits **Rango DSL** as its output; Rango serves it without
understanding the domain. The seam between them is the **route item as an intermediate
representation (IR)**.

```
   app authoring surface              what Rango sees
   (operation schemas, UI tree,       (plain values it can route + render)
    plugin manifest, content types)
            │   compiles to                   │
            ▼                                  ▼
   ┌─────────────────────┐   route items   ┌──────────────────────────┐
   │  the layer / "app"   │ ──────────────▶ │  Rango: route, render,    │
   │  (owns complexity;   │                 │  reverse, manifest, cache,│
   │   derives OpenAPI,   │                 │  middleware, prerender    │
   │   client, docs…)     │                 │  (blind to your domain)   │
   └─────────────────────┘                 └──────────────────────────┘
```

The **one genuinely unique** property — not shared with standalone contract libraries
(ts-rest, tRPC, Zodios), which have no host router underneath — is this:

> **Discovery executes the entry** (not source parsing), so _generated_ route items
> are first-class. Coalesced operations inherit Rango's `reverse`, `named-routes.gen.ts`,
> manifest, prerender, cache, and middleware for free, with Rango unaware a layer
> produced them.

Two supporting properties are real but shared with the field: route items are plain
values, and the framework is blind to the domain (it sees only
`path.json(pattern, handler, { name })`).

The substrate contract: **the layer owes valid route items; Rango provides everything
from routing down.** The "contract is the sole source of truth / only public types
imported / core frozen" rules are what _keep the seam a seam_ — they prevent the
Eden-style cross-package breakage that comes from reaching into a host's internals.
Keep this package's seam clean and the pattern is extractable later as a thin general
"mountable app" primitive — but do **not** abstract that prematurely. Prove it once
here; let the general primitive fall out.
