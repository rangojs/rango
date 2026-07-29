---
name: shell-manifest
description: Shell manifest pattern — replayed handles as cache metadata that live loaders read, e.g. a prerendered product list with batched live prices. Use when a cached/prerendered shell needs to feed IDs or metadata to a live loader for freshly-fetched data.
argument-hint:
---

# Shell Manifest — cache metadata for live loaders

Use this when a cached or prerendered shell has dynamic holes, and the live
data layer needs to know **what the shell actually contains** — which
products, which slots, which keys. The frozen render describes itself
through a handle; loaders (always live) read that description and fetch
exactly the dynamic data the shell needs, in one batch.

Canonical case: a prerendered product list where prices must stay live.

## The problem this solves

Any cached-shell-plus-live-holes design has a coordination gap: how does the
live layer know what the holes need?

- **Per-hole fetching** (each `<Price>` component fetching for itself) is the
  N+1 default — N visible products, N queries.
- **A loader that re-queries the list** ("current top products") drifts from
  a stale shell — right prices attached to wrong products.

The shell manifest closes the gap with a consistency guarantee: the loader
reads the ids the shell _actually rendered_, replayed from the same stored
artifact, so the holes can never desync from the shell and the query is
batched.

## The mechanism (three features composed)

1. **Handles record data at render time.** The handler pushes to a handle
   (`ctx.use(Handle)`) while it renders — at build time for `Prerender`, on
   the cache miss for `cache()`. (Loader bodies can push handles too — see
   `/loader` — but a loader push is request-time and is NOT part of the
   replayed artifact; a manifest handle must be pushed by the code that gets
   frozen with the shell.)
2. **Replay on every hit.** Handle data is stored with the Flight payload
   and replayed into the handle store on cache/prerender hits — handler code
   does not re-run, but its pushes do.
3. **Loaders read after the render barrier.** A DSL loader can
   `await ctx.rendered()` (waits for all non-loader segments to settle —
   fresh render or replay alike), then `ctx.get(Handle)` returns the
   **collected** handle data. (`ctx.use(Handle)` in a loader is the WRITE —
   it returns the push function; reads live on `ctx.get`.)

Loaders are live by default, so the read happens on every request even when
the shell is a hit.

## Canonical example: prerendered list, live prices

```tsx
// handles/rendered-products.ts
import { createHandle } from "@rangojs/router";

// TData = string (one push per product id), collected to a flat string[]
export const RenderedProducts = createHandle<string, string[]>((segments) =>
  segments.flat(),
);
```

```tsx
// routes/products.tsx — the list is baked at build time; prices are not
import { Prerender } from "@rangojs/router";
import { RenderedProducts } from "../handles/rendered-products";
import { Price } from "../components/price";

export const ProductList = Prerender(
  async () => [{ category: "espresso" }, { category: "filter" }],
  async (ctx) => {
    const products = await db.productsByCategory(ctx.params.category);
    const track = ctx.use(RenderedProducts);
    for (const p of products) track(p.id);
    return (
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} <Price id={p.id} />
          </li>
        ))}
      </ul>
    );
  },
);
```

```ts
// loaders/prices.ts — one batched query for exactly the rendered products
import { createLoader } from "@rangojs/router";
import { RenderedProducts } from "../handles/rendered-products";

export const PriceLoader = createLoader(async (ctx) => {
  "use server";
  await ctx.rendered();
  const ids = ctx.get(RenderedProducts);
  return db.pricesFor(ids); // Map<string, number> keyed by product id
});
```

```tsx
// urls.tsx — wire the route and register the loader
path("/products/:category", ProductList, { name: "products" }, () => [
  loader(PriceLoader),
]);
```

```tsx
// components/price.tsx — live hole in the frozen shell
"use client";
import { useLoader } from "@rangojs/router/client";
import { PriceLoader } from "../loaders/prices";

export function Price({ id }: { id: string }) {
  const { data } = useLoader(PriceLoader);
  return <span>{formatPrice(data[id])}</span>;
}
```

Request flow on a hit: stored payload replays (handler never runs) → handle
data lands in the store → render barrier resolves → `PriceLoader` reads the
replayed ids → one query → prices stream into `<Price>` components.

## Works with runtime cache() too

`Prerender` is build-time caching; the replay mechanism is identical for the
runtime segment cache. Wrap the route in `cache()` instead and the handler
pushes on the miss, replays on every hit:

```tsx
cache({ ttl: 600, tags: ["products"] }, () => [
  path("/products/:category", ProductList, { name: "products" }, () => [
    loader(PriceLoader),
  ]),
]);
```

## Contract and gotchas

- **The manifest is exactly as fresh as the shell.** Replayed handle data is
  frozen with the payload. To change _which_ products render, invalidate the
  shell (`updateTag("products")`, TTL expiry, rebuild) — never treat the
  loader as the refresh path for the list itself. This is the point:
  shell and holes cannot desync because they share one artifact.
- **No request-scoped data in a manifest handle.** The handle data is baked
  into a shared artifact — the same cross-user rule as any cached content.
  Ids, slugs, slot names, variant keys: yes. Anything derived from
  `cookies()`/`headers()`: no.
- **`ctx.rendered()` is experimental and DSL-loaders-only.** It throws in
  fetchable/standalone loader calls that run outside a route render, in
  handler-invoked loaders (a handler already awaiting the loader via
  `ctx.use()` is a detected deadlock), and in loaders registered with
  `{ ssr: false }` (the document render awaits the loader before
  the barrier — a cycle by construction; see `/loader`).
- **The reading loader serializes after the shell.** `await ctx.rendered()`
  deliberately gives up loader/render parallelism — on a miss the loader
  waits for segment resolution; on a hit (the common case for a cached
  shell) replay is immediate and the wait is negligible. A
  `debugPerformance` waterfall shows this loader after the render bar; for
  this pattern that is the contract, not a regression.
- **`ctx.get(handle)` before `await ctx.rendered()` throws** in a loader,
  with an error saying to await the barrier first. (`ctx.use(Handle)` — the
  push — is legal for the whole loader body, no barrier required.)
- **Deferred handle values are resolved before storage** (resolve-by-default),
  so the manifest read always sees plain values, never promises.

## Testing

`runLoader` seeds the barrier and the collected handle value directly —
matched by handle reference (the same seeding style as loader deps):

```ts
import { runLoader } from "@rangojs/router/testing";

const prices = await runLoader(PriceLoader, {
  rendered: true,
  handles: [[RenderedProducts, ["widget-a", "widget-b"]]],
  env: { DB: fakeDb },
});
```

This tests the loader's post-barrier logic. The real
push → store → replay → barrier wiring is covered at the e2e tier (dev +
production), like every cache-path behavior.

## Related

- `/prerender` — `Prerender`/`Passthrough`, build flow, passthrough fallback
- `/caching` — segment `cache()`, stores, tags
- `/loader` — loader context, `ctx.rendered()`, streaming
- `/hooks` — `useHandle` for reading handle data in client components
- `/rango` → "Passing data down the tree" — this pattern is the frozen→live
  counterpart of that ladder
