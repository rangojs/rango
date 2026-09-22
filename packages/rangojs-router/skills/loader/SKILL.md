---
name: loader
description: Define data loaders with createLoader and register them on routes with loader(). Use when a route needs per-request data that stays fresh and streams while the page renders, a client component reads server data with useLoader, a loader should re-run after specific actions (revalidate), be cached (cache), be callable from the client (fetchable loaders), throw notFound()/redirect(), write page meta/breadcrumbs handles, or must be settled in the SSR'd document (ssr:false).
argument-hint: "[loader]"
---

# Data Loaders with loader()

A loader is a server function created with `createLoader()` and registered on a
route segment with `loader()`. It runs fresh on every request, streams its
result to the client, and client components read it with `useLoader()`. This
skill covers defining, registering, consuming, revalidating, caching, and
client-fetching loaders.

For mutations (writes triggered by forms or buttons), use server actions
instead — see `/server-actions`. Loaders re-resolve after an action runs, so
the typical flow is _action mutates → loader re-reads → UI updates_.

## Not this skill if…

- You want to mutate state — mutations are `"use server"` actions: see
  `/server-actions`. Loaders read per-request live data.
- You want to cache a function's return value — loaders are fresh every request
  by default; caching one function is `"use cache"`: see `/use-cache`.

## Creating a Loader

```typescript
import { createLoader } from "@rangojs/router";

export const ProductLoader = createLoader(async (ctx) => {
  const product = await ctx.env.DB.prepare(
    "SELECT * FROM products WHERE slug = ?",
  )
    .bind(ctx.params.slug)
    .first();

  return { product };
});
```

Loader bodies already run only on the server — never add a `"use server"`
directive inside the callback. `"use server"` means "expose this function to
the client as a callable server reference", not "server only": the directive
would hoist the body into a registered server reference that anyone can invoke
through the action endpoint with caller-supplied arguments. The Vite plugin
rejects it at transform time (`createLoader() body at <file>:<line> carries a
"use server" directive`). For a build-time guarantee that a module never
reaches the client graph, use `import "server-only"` instead.

### Supported export patterns

All of the following are equivalent and fully supported by the Vite transform:

```typescript
// Direct export (most common)
export const ProductLoader = createLoader(handler);

// Separate declaration + named export
const ProductLoader = createLoader(handler);
export { ProductLoader };

// Aliased export
const InternalLoader = createLoader(handler);
export { InternalLoader as ProductLoader };

// Aliased import
import { createLoader as cl } from "@rangojs/router";
export const ProductLoader = cl(handler);
```

The `export const` form and the `const + export { }` form both work for
client stubs, ID injection, and loader manifest tracking.

## Using Loaders in Routes

```typescript
import { urls } from "@rangojs/router";
import { ProductLoader } from "./loaders/product";

export const urlpatterns = urls(({ path, loader }) => [
  path("/product/:slug", ProductPage, { name: "product" }, () => [
    loader(ProductLoader),
  ]),
]);
```

## Consuming Loader Data

Register loaders with `loader()` in the DSL and consume them in client
components with `useLoader()`. This is the recommended pattern — it keeps
data fetching on the server and consumption on the client, with a clean
separation that works correctly with `cache()`.

```typescript
"use client";
import { useLoader } from "@rangojs/router/client";
import { ProductLoader } from "./loaders/product";

function ProductDetails() {
  const { data } = useLoader(ProductLoader);
  return <div>{data.product.description}</div>;
}
```

```typescript
// Route definition — loader() registration required
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader),
]);
```

> **Client refresh `key` vs. server `cache({ key })` vs. `revalidate()`.** Three
> different "what refreshes" knobs that are easy to confuse:
>
> - `useLoader(Loader, { key })` / `useFetchLoader(Loader, { key })` — a
>   **client** refresh identity. It groups which mounted reads of one loader
>   refresh together when one calls `load()`. It never touches the server
>   request. For refreshing **different** loaders together, tag them with
>   `{ refreshGroup }` (one name or several) and call `useRefreshLoaders()(name)`
>   (plain GET only). See the hooks skill ("Scoping refetch with a `key`" and
>   "Refreshing multiple loaders together").
> - `cache({ key })` — a **server** cache identity (storage hit/miss/ttl/swr).
> - `revalidate()` — which **server** segments/loaders recompute during
>   navigation and action refreshes.

DSL loaders are the **live data layer**: they resolve fresh on every request,
even when the route is inside a `cache()` boundary, so `cache()` gives you
cached UI + fresh data by default. See "Loaders: The Live Data Layer" below.

### Cache safety

DSL loaders can safely read `createVar({ cache: false })` variables
because they are always resolved fresh. The read guard is bypassed for
loader functions — they never produce stale data.

### ctx.use(Loader) — escape hatch

For cases where you need loader data in the server handler itself (e.g.,
to set ctx variables or make routing decisions), use `ctx.use(Loader)`:

```typescript
// Product is a context-variable token: export const Product = createVar<ProductData>();
path("/product/:slug", async (ctx) => {
  const { product } = await ctx.use(ProductLoader);
  ctx.set(Product, product); // make available to children
  return <ProductPage />;
}, { name: "product" }, () => [
  loader(ProductLoader), // still register for client consumption
])
```

When you register with `loader()` in the DSL, `ctx.use()` returns the
same memoized result — loaders never run twice per request.

**Limitations of ctx.use(Loader):**

- The handler output depends on the loader data. If the route is inside
  `cache()`, the handler is cached with the loader result baked in —
  defeating the live data guarantee.
- The same holds under a PPR shell capture (`/ppr`): handler consumption is
  the BAKED lane — the loader executes at capture (identity reads permitted)
  and the rendered value is a capture-time copy; `useLoader` client-side is
  the live lane. One rule across `cache()`, `"use cache"`, and PPR: the
  consumption-lane rule (`/rango` → Invariants).
- Non-cacheable variable reads (`createVar({ cache: false })`) inside the
  handler still throw, even if the data came from a loader.
- Prefer DSL `loader()` + client `useLoader()` for data that depends on
  non-cacheable context variables.

**Never use `useLoader()` in server components** — it is a client-only API.

### Summary

| Pattern                | API                 | Cache-safe | Recommended |
| ---------------------- | ------------------- | ---------- | ----------- |
| DSL + client component | `useLoader(Loader)` | Yes        | Yes         |
| Handler escape hatch   | `ctx.use(Loader)`   | No         | When needed |

## Loader Context

Loaders receive a request-scoped context that shares its read surface with
route handlers (`params`, `request`, `url`, `env`, `get`, `use`, `reverse`).
It has no handler-only writers: there is no `ctx.set`, `ctx.headers`, or
`ctx.setLocationState` (a loader can stream after the response has started,
so response-shaping belongs in middleware or the handler).

### Full field surface

| Field              | Type                            | Notes                                                                                                                                                                                          |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `params`           | `TParams`                       | Merged route + explicit loader params; overridable by fetchable `load({ params })`.                                                                                                            |
| `routeParams`      | `Record<string, string>`        | Server-trusted route params from URL pattern matching; cannot be overridden.                                                                                                                   |
| `request`          | `Request`                       | The incoming `Request` (headers, method, body, `signal` for abort).                                                                                                                            |
| `url`              | `URL`                           | Request URL with internal `_rsc*` transport params stripped. Use this for application logic.                                                                                                   |
| `originalUrl`      | `URL`                           | Request URL with every param intact, including `_rsc*`. Only for debugging or custom cache keying.                                                                                             |
| `pathname`         | `string`                        | URL pathname (shortcut for `ctx.url.pathname`).                                                                                                                                                |
| `searchParams`     | `URLSearchParams`               | Shortcut for `ctx.url.searchParams`.                                                                                                                                                           |
| `search`           | `ResolveSearchSchema<TSearch>`  | Typed query params when a search schema is declared on the route; `{}` otherwise.                                                                                                              |
| `env`              | `any`                           | Bindings from `createRouter<TEnv>()` (DB, KV, secrets, etc.). `createLoader` types it as `any`; annotate or cast at the use site.                                                              |
| `waitUntil`        | `(fn: () => Promise<void>)`     | Run work after the response is sent. Takes a function, not a promise. Delegates to Cloudflare's `waitUntil`; fire-and-forget with error logging elsewhere.                                     |
| `executionContext` | `ExecutionContext \| undefined` | Raw Cloudflare `ExecutionContext` for libraries that need it; `undefined` off Cloudflare. Prefer `waitUntil`.                                                                                  |
| `get`              | `(key \| ContextVar \| handle)` | Reads middleware variables/context-vars — or READS a handle's collected data, after `await ctx.rendered()`.                                                                                    |
| `use`              | `(loader \| handle) => T`       | Access another loader's data (Promise), or WRITE a handle: `ctx.use(Meta)({ title })` returns the push function — handler parity. Reads moved to `get`.                                        |
| `rendered`         | `() => Promise<void>`           | **Experimental.** DSL loaders only — waits for all non-loader segments (including `loading()` streaming handlers) to settle before reading handle data. Not with `ssr: false` (cycle; throws). |
| `method`           | `string`                        | HTTP method. `"GET"` for SSR loader runs; reflects real method for fetchable loaders.                                                                                                          |
| `body`             | `TBody \| undefined`            | Parsed request body for fetchable POST/PUT/PATCH/DELETE calls.                                                                                                                                 |
| `formData`         | `FormData \| undefined`         | Present when a fetchable loader is invoked via form submission.                                                                                                                                |
| `reverse`          | `ScopedReverseFunction`         | Generate type-checked URLs from route names (same scoped semantics as route handlers).                                                                                                         |

### Example

```typescript
export const ProductLoader = createLoader(async (ctx) => {
  // URL params (may include client-provided overrides for fetchable loaders)
  const { slug } = ctx.params;

  // Server-trusted route params (from URL pattern matching, cannot be overridden)
  const { slug: trustedSlug } = ctx.routeParams;

  // Query params
  const variant = ctx.url.searchParams.get("variant");

  // Platform bindings (DB, KV, etc.) — plain bindings from createRouter<TEnv>()
  const db = ctx.env.DB;

  // Request headers
  const auth = ctx.request.headers.get("Authorization");

  // Variables set by middleware (from Rango.Vars augmentation)
  const user = ctx.get("user");

  // Type-checked URLs for payloads. `.name` resolves within the current
  // include() scope; a bare `name` resolves globally. See /route and
  // /typesafety for scope rules and route-name autocomplete.
  const detailUrl = ctx.reverse(".detail", { slug });

  return {
    product: await fetchProduct(slug),
    links: { self: detailUrl },
  };
});
```

See `/route` for the full handler-context contract (shared with loaders) and
`/typesafety` for route-name typing that powers `ctx.reverse` autocomplete.

### params vs routeParams

- `ctx.params` — merged route params + explicit loader params. For fetchable
  loaders called with `load(Loader, { params: { ... } })`, explicit params
  override route-matched params.
- `ctx.routeParams` — server-trusted route params from URL pattern matching.
  Cannot be overridden by client-provided params.

Use `ctx.routeParams` when you need trusted route identity for authorization
or resource scoping:

```typescript
export const OrderLoader = createLoader(async (ctx) => {
  // Use routeParams for auth checks — client cannot spoof the URL-matched ID
  const { orderId } = ctx.routeParams;
  const user = ctx.get("user");

  const order = await db.orders.get(orderId);
  if (order.userId !== user.id)
    throw new Response("Forbidden", { status: 403 });

  return { order };
});
```

## Loader with Children

Add caching or revalidation to specific loaders:

```typescript
import * as CartActions from "./actions/cart";

path("/product/:slug", ProductPage, { name: "product" }, () => [
  // Cached loader
  loader(ProductLoader, () => [cache({ ttl: 300 })]),

  // Loader with revalidation control
  loader(RelatedProductsLoader, () => [
    revalidate(() => false), // Never revalidate
  ]),

  // Loader that revalidates after cart actions (defer otherwise — keeps the
  // permissive loader defaults for navigation and other actions intact)
  loader(CartLoader, () => [
    revalidate((ctx) => ctx.isAction(CartActions) || undefined),
  ]),
]);
```

### `revalidate()` return shapes

> **Scope: `revalidate()` is a partial-render concern, not a cache concern.**
> It decides whether a segment (here, a loader) re-runs and streams to the
> client on a navigation or action — never whether a cached value is stale. The
> cache decides hit/miss/ttl/swr independently and never reads `revalidate()`.
> Caching a loader is a separate, opt-in step (`loader(Fn, () => [cache({...})])`).
> See `/cache-guide` → "Two axes" and `/rango` → "The shape of rango".

A `revalidate(fn)` callback returns one of three kinds of value. The chain
processes revalidators in order; each call's return controls how the
chain continues:

```typescript
// 1) Hard decision — short-circuits the chain, used as the final answer.
revalidate(() => true);
revalidate(({ actionId }) => actionId?.includes("Cart") ?? false);

// 2) Soft decision — updates the running suggestion for downstream
//    revalidators on the same segment, chain continues.
revalidate(({ defaultShouldRevalidate }) => ({
  defaultShouldRevalidate: !defaultShouldRevalidate,
}));

// 3) Defer (no opinion) — leaves the running suggestion unchanged and
//    continues to the next revalidator. Implicit return / null /
//    undefined are all equivalent and consumer-friendly.
revalidate(({ actionId }) => {
  if (actionId?.includes("Cart")) return true; // hard for this branch only
  // implicit return — let downstream revalidators or the segment default decide
});
revalidate(() => undefined); // explicit defer
revalidate(() => null); // explicit defer
```

If every revalidator on a segment defers, the segment default is used
(`defaultShouldRevalidate`, see the table below).

The callback must be **synchronous**. A returned Promise is ignored (dev
warning) and the running suggestion is kept, so move async work into a loader.
A callback that throws is logged and treated as a defer; a thrown `Response`
(e.g. `throw redirect(...)`) propagates as control flow.

Segment defaults when no revalidator decides (from
`src/router/revalidation.ts`). A segment the client does not hold yet always
renders.

| Segment                                                              | After an action (POST) | Navigation                          |
| -------------------------------------------------------------------- | ---------------------- | ----------------------------------- |
| Route (`path()`)                                                     | `true`                 | `true` when params or search change |
| Owned by the route (loaders, layouts, parallels inside the `path()`) | `true`                 | `true` when params or search change |
| Loader above the route (e.g. on a parent `layout()`)                 | `true`                 | `false`                             |
| Layout or parallel above the route                                   | `false`                | `false`                             |

#### `|| undefined` (defer) vs `?? false` (hard) — pick deliberately

A boolean return — including `false` — is a **hard** decision: it short-circuits
the chain and overrides the segment default. `undefined` **defers** to the
running suggestion / segment default. They are not interchangeable:

```typescript
// Defer: "revalidate on match, otherwise let the default/downstream decide."
revalidate(({ actionId }) => actionId?.includes("Cart") || undefined);

// Hard: "revalidate ONLY on match, suppress everything else."
revalidate(({ actionId }) => actionId?.includes("Cart") ?? false);
```

This matters most for loaders, whose defaults are permissive: every loader
revalidates on **any** action (`POST`), and a route-owned loader also
revalidates on **param/search changes** during navigation. So `?? false` on a
loader silently suppresses both — the loader will not refetch when you navigate
to a different `:id`. Use
`|| undefined` when you want to _add_ a revalidation signal on top of the
sensible defaults, and reserve `?? false` for the rare case where you genuinely
want the loader to refetch on nothing but your matched action.

When **composing multiple revalidators** on one segment (see below), defer is
mandatory: the first hard `?? false` ends the chain and the later contracts
never run.

#### Matching actions: `ctx.isAction()`

To revalidate after specific server actions, match them by **reference** with
`ctx.isAction()` rather than hand-written `actionId` substrings. A rename or
moved file then becomes a type error instead of silently failing to match:

```typescript
import { addToCart, removeFromCart } from "../actions/cart";
import * as CartActions from "../actions/cart";

loader(CartLoader, () => [
  revalidate((ctx) => ctx.isAction(addToCart) || undefined), // one action
]);
revalidate((ctx) => ctx.isAction(addToCart, removeFromCart) || undefined); // several
revalidate((ctx) => ctx.isAction(CartActions) || undefined); // any action in the module
revalidate((ctx) => ctx.isAction({ addToCart, removeFromCart }) || undefined); // object form
revalidate((ctx) => ctx.isAction({ Cart: CartActions }) || undefined); // grouped namespaces
revalidate((ctx) => ctx.isAction() || undefined); // no args: any action at all
```

`isAction()` is a method on the revalidate predicate's **context argument** —
there is no standalone `isAction` import; you always reach it through the callback
parameter (`revalidate((ctx) => ctx.isAction(...))`). It returns a raw boolean, so
pair it with `|| undefined` for the usual "revalidate on match, else defer"
intent. It returns `false` on plain navigation and on non-matches; called with no
arguments it answers "is this request an action?". It resolves the reference with
the same `$id ?? $$id` precedence the router uses to derive `actionId`, so it
matches in both dev and production. The raw `actionId` string stays available on
the same context as an escape hatch, alongside `actionResult`, `formData`,
`actionUrl`, `currentParams`/`nextParams`, `currentUrl`/`nextUrl`,
`fromRouteName`/`toRouteName`, and the full handler `context`.

### Revalidation Contracts for Loader Dependencies

If a loader reads `ctx.get()` data produced by an outer handler/layout, share
the same named revalidation contract across producer and consumer segments.

```typescript
// revalidation-contracts.ts
import type { Revalidate } from "@rangojs/router";
import * as AccountActions from "./actions/account";

// Match by reference with ctx.isAction() (rename-safe), and defer (|| undefined)
// so these contracts compose — a hard `false` would short-circuit the rest.
export const revalidateAccountScope: Revalidate = (ctx) =>
  ctx.isAction(AccountActions) || undefined;

// urls.tsx
layout(AccountLayout, () => [
  revalidate(revalidateAccountScope), // producer reruns
  path("/account/orders", OrdersPage, { name: "account.orders" }, () => [
    loader(OrdersLoader, () => [
      revalidate(revalidateAccountScope), // consumer reruns
    ]),
  ]),
]);
```

For segments that depend on multiple upstream domains, compose multiple
contracts on both sides.

To keep loader route trees concise, export helper wrappers:

```typescript
import { revalidate } from "@rangojs/router";

export const revalidateAccount = () => [revalidate(revalidateAccountScope)];

layout(AccountLayout, () => [
  revalidateAccount(),
  path("/account/orders", OrdersPage, { name: "account.orders" }, () => [
    loader(OrdersLoader, () => [revalidateAccount()]),
  ]),
]);
```

## Loaders: The Live Data Layer

Loaders resolve fresh on every request, even when the route's UI segments are
served from cache. Route-level `cache()` caches rendered segments but never
loader data: loaders are excluded when the segments are stored and re-resolved
when they are served. Caching a loader's own data is a separate opt-in (see
"Opting a Loader into Caching").

Pre-rendering follows the same rule: at build time loaders are skipped entirely
(there is no real request context), and at runtime the worker resolves them
fresh against the live database.

### Parallel and streaming — latency overlaps first paint

Loaders do not block the page. As the render pass begins — the pass that route
middleware wraps, so loaders run right after middleware, not in a later
phase — every matched loader is kicked off **concurrently** (their promises start in the
same tick), and each result is **streamed** to the client as its own RSC Flight
chunk rather than awaited up front. Pair a loader with `loading()` (or a
client `<Suspense>`) and the shell paints immediately while the data streams in.

This is why **"cached UI still pays full data latency" is the wrong intuition**:
on a `cache()` hit the UI segments stream instantly from cache while the live
loaders resolve fresh **in parallel** — data latency _overlaps_ first paint
instead of being added on top of it. (Without a `loading()` / `<Suspense>`
boundary a parallel loader blocks its parent, so add one to keep the overlap.)

If you come from a framework where the loader is a blocking step that runs
before the response is built, this is the shift to internalize: here the
response starts streaming first and loader data fills in. (The one deliberate
exception is per-loader: `loader(Def, { ssr: false })` awaits that
loader before first flush on document renders — see "`ssr: false`"
below.)

### See it: `debugPerformance`

Turn on the per-request performance timeline early — it is the fastest way to
confirm loaders overlap rather than serialize, and to find the real bottleneck
locally instead of guessing:

```typescript
const router = createRouter({ document: Document, debugPerformance: true });
```

Or enable it per-request from middleware (e.g. only when `?debug` is present) by
calling `ctx.debugPerformance()` **before** `await next()`:

```typescript
router.use(async (ctx, next) => {
  if (ctx.searchParams.has("debug")) ctx.debugPerformance();
  return next();
});
```

Each metered request then prints a shared-axis waterfall to the server console
(and adds the timings to the `Server-Timing` response header):

```
[RSC Perf] GET /product/widget (24.53ms)
start      dur  span                          timeline
 0.08ms  3.20ms  route-matching               |#####...................................|
 3.30ms 20.10ms  render:total:product         |....############################........|
 3.40ms  8.70ms  ssr:render-html              |.....##############.....................|
 3.42ms 11.90ms  loader:…#ProductLoader       |.....###################................|
 3.45ms 11.40ms  loader:…#ReviewsLoader       |.....##################.................|
 0.00ms 24.53ms  handler:total                |########################################|
```

How to read it:

- **Humans:** scan the `#` bars on the shared axis. Bars that start at the same
  offset and run side by side are executing **in parallel** — loaders should
  overlap `ssr:render-html` / `render:total`, not sit alone to the right of
  everything. A lone `loader:*` bar past the render bar is serialized latency to
  chase. `handler:total` is the whole request; `render:total` is the render pass
  (labelled `render:total:<routeName>` when the matched route has a name).
- **LLMs / programmatic:** read each row as `{ start, dur, label }`. A loader
  overlaps paint when its `[start, start+dur]` interval intersects
  `render:total` / `ssr:render-html`. Flag a regression when a `loader:*`
  interval is **disjoint from and starts after** `render:total`, or when its
  `dur` approaches `handler:total` — that loader is on the critical path instead
  of overlapping it. Two `loader:*` rows with near-equal `start` confirm
  parallel execution.

### Opting a Loader into Caching

To cache a specific loader's data, attach a `cache()` child:

```typescript
loader(ProductLoader, () => [cache({ ttl: 300 })]),
```

The loader's data is cached independently from the route's segment cache,
using the same `SegmentCacheStore` (app-level or per-loader override).

Values are serialized through RSC Flight, so loaders can return ReactNode,
Promises, null, and any RSC-serializable type — all round-trip correctly
through the cache.

### Cache Key

The default cache key is `loader:{loaderId}:{host}{pathname}:{sortedParams}`
(the host keeps multi-tenant hosts from sharing entries). This can be customized
at two levels:

```typescript
import { cookies } from "@rangojs/router";

// Full override — key function replaces the default entirely
loader(ProductLoader, () => [
  cache({
    ttl: 300,
    key: (ctx) => `product:${ctx.params.slug}:${cookies().get("locale")?.value ?? "en"}`,
  }),
]),

// Store-level keyGenerator — modifies the default key (e.g., adds a region prefix)
// Set in the store configuration, applies to all entries in that store
```

Resolution priority (same as route-level `cache()`):

1. `key(ctx)` from cache options — full override
2. `store.keyGenerator(ctx, defaultKey)` — store-level modification
3. Default key — `loader:{loaderId}:{host}{pathname}:{sortedParams}`

A `key` function (or store `keyGenerator`) that throws is **not** caught: the
loader fails as if its body threw. There is no silent fallback to the default
key, because a personalised key collapsing onto the broad default would share
one user's data with everyone.

### Tags for Invalidation

```typescript
// Static tags
loader(ProductLoader, () => [
  cache({ ttl: 300, tags: ["products", "catalog"] }),
]),

// Dynamic tags
loader(ProductLoader, () => [
  cache({
    ttl: 300,
    tags: (ctx) => [`product:${ctx.params.slug}`, "products"],
  }),
]),
```

### Stale-While-Revalidate

```typescript
loader(ProductLoader, () => [
  cache({ ttl: 60, swr: 300 }),
]),
```

During the SWR window (60-360s), stale data is returned immediately while
fresh data is fetched in the background via `waitUntil`. After the SWR window
expires (360s+), the entry is treated as a cache miss.

### Conditional Caching

Skip the cache at runtime based on request properties:

```typescript
loader(ProductLoader, () => [
  cache({
    ttl: 300,
    condition: (ctx) => !ctx.request.headers.has("authorization"),
  }),
]),
```

When `condition` returns false, the loader runs fresh and the cache is bypassed
entirely (no read, no write).

### Per-Loader Store Override

```typescript
import { MemorySegmentCacheStore } from "@rangojs/router/cache";

const hotStore = new MemorySegmentCacheStore({ defaults: { ttl: 10 } });

loader(PricingLoader, () => [
  cache({ store: hotStore }),
]),
```

Without an explicit store, the loader uses the app-level store from the router
config (`createRouter({ cache: { store } })`). Without any store, `cache()` on
a loader is inert and the loader runs fresh.

## Multiple Loaders

Routes can have multiple loaders that run in parallel:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader),
  loader(RelatedProductsLoader),
  loader(ReviewsLoader),
]);
```

## Layout Loaders

Loaders on layouts are shared by all child routes:

```typescript
layout(<ShopLayout />, () => [
  // These loaders are available to all shop routes
  loader(CartLoader),
  loader(CategoriesLoader),

  path("/shop", ShopIndex, { name: "index" }),
  path("/shop/product/:slug", ProductPage, { name: "product" }),
])
```

## Passing Loaders as Props

Loaders can be passed as props from server to client components. A loader
definition is a plain `{ __brand, $$id }` object (the function itself stays in the
server registry), so it serializes as-is.

```typescript
// Server component (route handler)
import { SlowLoader } from "../loaders";

path("/dashboard", () => <DashboardContent loader={SlowLoader} />, { name: "dashboard" }, () => [
  loader(SlowLoader),
  loading(<DashboardSkeleton />),
])

// Client component — use typeof for type-safe props
"use client";
import { useLoader } from "@rangojs/router/client";
import type { SlowLoader } from "../loaders";

function DashboardContent({ loader }: { loader: typeof SlowLoader }) {
  const { data } = useLoader(loader);
  return <div>{data.message}</div>;
}
```

Use `typeof MyLoader` for the prop type — it infers the full generic automatically.

## Streaming with Suspense

Loaders stream data. Use Suspense for loading states:

```typescript
// In route definition
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader),
  loading(<ProductSkeleton />),  // Shows while loader streams
])

// Or in component
function ProductPage() {
  return (
    <Suspense fallback={<ProductSkeleton />}>
      <ProductDetails />
    </Suspense>
  );
}
```

## Loader Authority: notFound() and redirect()

A loader may **throw** `notFound()` and `redirect()` — data-dependent
authority lives with the data, so every consumer of the loader inherits the
signal instead of re-checking existence at each read site:

```typescript
import { createLoader, notFound, redirect } from "@rangojs/router";

export const ProductLoader = createLoader(async (ctx) => {
  const moved = LEGACY_SLUGS[ctx.params.slug];
  if (moved) throw redirect(`/shop/product/${moved}`);

  // Existence check BEFORE the expensive fetch: a near-instant rejection
  // usually wins the race to first flush (see the semantics below).
  if (!(await exists(ctx.params.slug))) notFound(`No "${ctx.params.slug}"`);

  return getProduct(ctx.params.slug);
});
```

Semantics by lane:

| Signal       | Document load                                                                                                                                                                                                                                               | Client navigation                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `notFound()` | Not-found UI resolves server-side (nearest `notFoundBoundary` → router option → default) and rides the envelope; the 404 STATUS is **opportunistic** — real only if the rejection beats Response construction. `ssr: false` (below) makes it deterministic. | 404 UI swaps in, URL preserved, payload stays 200 |
| `redirect()` | 200 document, then a client-side replace to the target — **no document-lane 302 from loaders**; pre-stream redirect authority belongs to middleware                                                                                                         | Redirect envelope navigates to the target         |

With `loader(Def, { ssr: false })` the result is settled BEFORE the document
flushes, so both signals are resolved server-side while the tree is built:
`redirect()` replaces the whole page with the redirect carrier (still a 200
document, the client replaces to the target on hydration) and `notFound()`
renders the not-found UI at the owning segment with a real 404. No read site
runs, so a `useLoader` in a layout above every Suspense boundary is safe.

Session/auth gates belong in middleware (they are request-shaped, not
data-shaped, and middleware CAN emit a real pre-stream 302). Data-dependent
"this slug moved / does not exist" belongs in the loader.

## Writing Handles from Loaders (meta, breadcrumbs)

Loader bodies can WRITE handles with handler parity — `ctx.use(Handle)`
returns the push function, legal for the whole body, streaming loaders
included. This is how data-derived page titles and breadcrumb trails live
where the data lives:

```typescript
import { Meta, Breadcrumbs } from "./handles";

export const ProductLoader = createLoader(async (ctx) => {
  const product = await getProduct(ctx.params.slug);

  ctx.use(Meta)({ title: `${product.name} — Shop` });
  const pushCrumb = ctx.use(Breadcrumbs);
  pushCrumb({ label: "Shop", href: "/shop" });
  pushCrumb({ label: product.name, href: `/shop/product/${product.slug}` });

  return product;
});
```

Delivery is async **by the race model**: pushes that settle before the handler
barrier ride the SSR handle snapshot (in the SSR'd document — `<MetaTags />`,
`useHandle` reads); later pushes stream to the client and apply post-hydration
on document loads (`metadata.handlesLate`) or progressively on navigations.
A push before your slow fetch usually beats the barrier; a push derived from
the fetched data usually does not. When it MUST be in the document, use
`ssr: false` below.

Reads are the other direction and gated: `ctx.get(handle)` throws unless the
loader first does `await ctx.rendered()` (DSL-registered loaders only —
handler-invoked loaders cannot use `rendered()`, and a handler already
awaiting the loader via `ctx.use()` makes it a detected deadlock).

## `ssr: false` — Guarantee a Loader in the Document

Streaming means nothing a slow loader produces is _guaranteed_ in the SSR'd
HTML: its section SSRs as the fallback, a late handle push applies
post-hydration, a late `notFound()` loses the status race. When the loader
feeds something that must exist in the document — `<head>` meta via a handle,
or a real 404 status — pass delivery options between the definition and the
use callback:

```typescript
path("/product/:slug", ProductPage, { name: "product" }, () => [
  loader(ProductLoader, { ssr: false }, () => [cache({ ttl: 60 })]),
  loader(RelatedLoader),   // untouched: still streams behind its boundary
]),
```

The knob mirrors `loading(fallback, { ssr: false })` — SSR delivery is off
for this loader, so nothing of it is left to stream in the document:
document renders await this loader before first flush — data is settled
(`useLoader` reads it synchronously, no fallback paints), handle pushes beat
the barrier snapshot, and a thrown `notFound()` deterministically precedes
Response construction (real 404, no warm-up race). Client navigations stream
exactly as before. Scoped per LOADER: the flagged loader awaits only itself;
siblings keep streaming.

Delivery is in-place, not merely in-document. React's Fizz outlines any
COMPLETED Suspense boundary over ~500 bytes to an end-of-stream
`<div hidden>` + `$RC()` reveal once the shell saturates its 12800-byte
`progressiveChunkSize` budget — the bytes are in the HTML, but not at their
document position, and a consumer that doesn't execute scripts never sees
them revealed. When the matched chain has a flagged loader, the document
render raises the budget to `MAX_SAFE_INTEGER` automatically, so the awaited
content renders where it belongs. Pin the budget yourself (in either
direction) with `rango({ progressiveChunkSize })` in the Vite config — an
explicit value disables the auto-raise. Boundaries hoisting stylesheets
still outline; their reveal must wait for the CSS.

The costs and constraints:

- Every document load pays the flagged loader's latency before first byte.
  That is the point — but keep flagged loaders fast, and flag loaders, not
  routes.
- A flagged loader must not `await ctx.rendered()` / `ctx.get(handle)` — the
  document render awaits the loader before the render barrier resolves, so
  that wait is a cycle by construction; it throws a deadlock error naming the
  fix.
- PPR capture is the BAKE lane for flagged loaders (`/ppr`): the capture
  render awaits them too, and the settled result — handle pushes included —
  freezes into the stored shell. Unflagged loaders stay masked as live
  holes. The `progressiveChunkSize` auto-raise is live-document only;
  captured shells outline per the explicit option or React's default.

Also available in `clientUrls()` route groups (`/client-urls`), where the
loader-heavy shape makes it most useful.

## Fetchable Loaders

By default, loaders only run as part of a render (document, navigation, or
post-action revalidation); the `_rsc_loader` endpoint rejects them. Pass `true`
as the second argument to `createLoader` to make a loader **fetchable** —
callable from the client via `useFetchLoader()` and `load()`:

```typescript
import { createLoader } from "@rangojs/router";

export const SearchLoader = createLoader(async (ctx) => {
  const query = ctx.params.query ?? "";
  const results = await ctx.env.DB.prepare(
    "SELECT * FROM products WHERE name LIKE ?",
  )
    .bind(`%${query}%`)
    .all();

  return { results: results.results ?? [] };
}, true); // true = fetchable
```

`true` attaches an EMPTY middleware list, and the fetch lane never runs route
`middleware()` (see `/middleware` → "Request flow"). A fetchable loader that
reads a var set by route middleware (`ctx.get(CurrentUser)`) therefore sees
`undefined` on `useFetchLoader()` / `load()` / `useRefreshLoaders()` unless it
passes that middleware itself: `createLoader(fn, { middleware: [loadSession,
requireAuth] })` (next section).

> **No registration needed — and no worker-entry import.** A fetchable loader
> does not have to be registered with `loader()` in the route DSL, and it does
> not have to be imported by any server module. Importing it into the client
> component that calls `useFetchLoader()` / `load()` is enough. Rango discovers
> every `createLoader(fn, true)` at build time and registers it for the
> `_rsc_loader` endpoint, so a loader reachable only through a client component
> still resolves in production — on both the generated entry and a hand-written
> worker entry (e.g. a Cloudflare `worker.rsc.tsx`). You do **not** need to
> force-import the loader in your worker entry to make it resolve.

### Fetchable Loader with Middleware

Pass an options object instead of `true` to attach per-loader middleware (any
options object makes the loader fetchable). This middleware runs only on
`_rsc_loader` fetch requests (client-side `load()` / `useFetchLoader()` /
`useRefreshLoaders()` calls), not when the loader runs as part of a render:

```typescript
import { createLoader } from "@rangojs/router";
import { authMiddleware } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";

export const ProtectedLoader = createLoader(
  async (ctx) => {
    const user = ctx.get("user");
    return { orders: await db.orders.list(user.id) };
  },
  { middleware: [authMiddleware, rateLimitMiddleware] },
);
```

The middleware uses the same `MiddlewareFn` signature as route/app middleware,
so you can reuse existing middleware functions directly.

A `redirect()` thrown by per-loader middleware becomes a real 3xx on the fetch
lane, so the browser's `fetch` follows it and `useFetchLoader()` receives the
login page's HTML instead of loader data. Reserve redirects for document and
navigation requests; on the fetch lane return a 401 (or a structured error
payload) and let the caller decide.

Fetchable loaders support both GET and POST (PUT, PATCH, DELETE) from the client.
The `load()` function auto-detects the body type:

- **JSON body** (`body: { ... }`) — sent as `application/json`, available as `ctx.body`
- **FormData body** (`body: formData`) — sent as `multipart/form-data`, available as `ctx.formData`

### Mutation Context

When a fetchable loader receives a POST/PUT/PATCH/DELETE request, the context
includes additional fields depending on the body type:

```typescript
export const MutationLoader = createLoader(async (ctx) => {
  // JSON body — available as ctx.body (parsed object)
  const data = ctx.body as { name: string; email: string };

  // FormData body — available as ctx.formData
  const file = ctx.formData?.get("file") as File | null;
  const name = ctx.formData?.get("name") as string | null;

  // Route params are always available
  const { slug } = ctx.params;

  return { success: true };
}, true);
```

A fetchable-loader POST is not a server action: the router does not run a
revalidation render afterwards and the client does not invalidate its caches.
Other loaders on the page keep their current data until you refresh them
(`load()`, `useRefreshLoaders()`, `router.refresh()`), and cached history or
prefetch entries stay valid unless you call `invalidateClientCache()`. For
writes that should refresh the page, prefer a server action (`/server-actions`).

### File Upload Example

```typescript
// loaders/upload.ts
import { createLoader } from "@rangojs/router";

export const FileUploadLoader = createLoader(async (ctx) => {
  const file = ctx.formData?.get("file") as File | null;
  if (file && file.size > 0) {
    // Save to R2, D1, etc.
    await ctx.env.BUCKET.put(file.name, file.stream());
    return {
      uploadedFile: { name: file.name, size: file.size, type: file.type },
    };
  }
  return { uploadedFile: null };
}, true);
```

Client usage — see `/hooks useFetchLoader` for the full client-side pattern.

> **Refetch sharing**: when the loader is registered on the route via
> `loader()`, a plain `load()` call (no `params`, no `body`) broadcasts
> the new value to every component reading the same loader id —
> `useLoader` reads in layouts, pages, and parallel slots all converge.
> Calls with `params` or a non-GET method stay local to the call site.
> See `/hooks` → "Shared refetch behavior" for the full contract.

## Complete Example

```typescript
// loaders/shop.ts
import { createLoader, notFound } from "@rangojs/router";

export const ProductLoader = createLoader(async (ctx) => {
  const product = await ctx.env.DB
    .prepare("SELECT * FROM products WHERE slug = ?")
    .bind(ctx.params.slug)
    .first();

  if (!product) {
    notFound("Product not found");
  }

  return { product };
});

export const CartLoader = createLoader(async (ctx) => {
  const user = ctx.get("user");
  if (!user) return { cart: null };

  const cart = await ctx.env.KV.get(`cart:${user.id}`, "json");
  return { cart };
});

// urls.tsx — register loaders in the DSL
import { urls } from "@rangojs/router";
import * as CartActions from "./actions/cart";
import { CartLoader, ProductLoader } from "./loaders/shop";

export const urlpatterns = urls(({ path, layout, loader, loading, cache, revalidate }) => [
  layout(<ShopLayout />, () => [
    loader(CartLoader, () => [
      revalidate((ctx) => ctx.isAction(CartActions) || undefined),
    ]),

    path("/shop/product/:slug", ProductPage, { name: "product" }, () => [
      loader(ProductLoader, () => [cache({ ttl: 60 })]),
      loading(<ProductSkeleton />),
    ]),
  ]),
]);

// components/ProductDetails.tsx — consume in client component
"use client";
import { useLoader } from "@rangojs/router/client";
import { ProductLoader, CartLoader } from "./loaders/shop";

function ProductDetails() {
  const { data: { product } } = useLoader(ProductLoader);
  const { data: { cart } } = useLoader(CartLoader);

  return (
    <div>
      <h1>{product.name}</h1>
      <AddToCartButton
        productId={product.id}
        inCart={cart?.items.includes(product.id)}
      />
    </div>
  );
}
```
