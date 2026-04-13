---
name: handler-use
description: Attach default loaders, middleware, parallels, and other use items directly to handlers via handler.use, and compose them with explicit use() at mount sites
argument-hint: "[handler]"
---

# Handler-Attached `.use`

A handler function (or branded `Static`/`Prerender`/`Passthrough` definition) can carry its own defaults via a `.use` callback that returns an array of `use` items (loader, middleware, parallel, intercept, layout, loading, etc.). The mount-site DSL (`path()`, `layout()`, `parallel()`, `intercept()`) merges those defaults with any explicit `use()` callback supplied at the registration site.

This lets handlers be **self-contained, reusable units** — a page brings its own loader, a layout brings its own middleware, a parallel slot brings its own data + skeleton — without forcing every caller to wire the same items at every mount site.

Canonical implementation reference:
[src/route-definition/resolve-handler-use.ts](../../src/route-definition/resolve-handler-use.ts)

## Defining a handler with `.use`

Attach `.use` to the function (or to the branded definition for `Static()`/`Prerender()`/`Passthrough()`):

```typescript
import {
  loader,
  middleware,
  loading,
  createLoader,
  type Handler,
} from "@rangojs/router";

export const ProductLoader = createLoader(async (ctx) =>
  fetchProduct(ctx.params.slug),
);

const ProductPage: Handler<"/product/:slug"> = async (ctx) => {
  const product = await ctx.use(ProductLoader);
  return <ProductView product={product} />;
};

ProductPage.use = () => [
  loader(ProductLoader),
  loading(<ProductSkeleton />),
  middleware(async (ctx, next) => {
    await next();
    ctx.header("Cache-Control", "private, max-age=60");
  }),
];
```

Now `ProductPage` carries its loader, loading state, and response-header middleware regardless of where it is mounted.

## Allowed items per mount site

`handler.use()` is the same callback shape regardless of where the handler runs, but the runtime validates that the items it returns are valid for the mount site. Driven by `MOUNT_SITE_ALLOWED_TYPES` in [resolve-handler-use.ts](../../src/route-definition/resolve-handler-use.ts):

| Mount site                                        | Allowed item types                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `path()` / `route()`                              | `layout`, `parallel`, `intercept`, `middleware`, `revalidate`, `loader`, `loading`, `errorBoundary`, `notFoundBoundary`, `cache`, `transition` |
| `layout()`                                        | All of the above, plus `route`, `include`                                                                                                      |
| `parallel()` (per slot)                           | `revalidate`, `loader`, `loading`, `errorBoundary`, `notFoundBoundary`, `transition`                                                           |
| `intercept()`                                     | `middleware`, `revalidate`, `loader`, `loading`, `errorBoundary`, `notFoundBoundary`, `layout`, `route`, `when`, `transition`                  |
| Response routes (`path.json()`, `path.text()`, …) | `middleware`, `cache`                                                                                                                          |

If `handler.use()` returns a disallowed item for a mount site, registration throws:

```
handler.use() returned middleware() which is not valid inside parallel().
Allowed types: revalidate, loader, loading, errorBoundary, notFoundBoundary, transition.
```

The narrowest contract is `parallel()` — slots cannot bring their own middleware or layout; only data, loading, error/notFound boundaries, revalidation, and transitions.

## Composition with explicit `use()`

Every mount site that takes a `use` callback merges in this order:

1. **`handler.use()` items first** — the handler's defaults.
2. **Explicit `use()` items second** — overrides specified at the mount site.

Items of the same kind from the explicit `use()` follow the existing override rules of that item type. The most important ones for composition:

- **`loading()`** — last definition wins, so explicit `loading()` replaces the handler's default.
- **`parallel({ "@slot": … })`** — the last `parallel()` call wins per slot name. Other slots from earlier calls are preserved (see `skills/parallel`).
- **`loader()`, `middleware()`, etc.** — accumulate; both the handler's and the explicit ones run.

Skip the boilerplate: if neither `handler.use` nor explicit `use()` is provided, no merge happens.

```typescript
// Handler brings a loader + a (placeholder) loading; explicit use replaces loading.
const SidebarSlot: Handler = async (ctx) => {
  const data = await ctx.use(SidebarLoader);
  return <Sidebar data={data} />;
};
SidebarSlot.use = () => [
  loader(SidebarLoader),
  loading(<DefaultSidebarSkeleton />),
];

parallel({ "@sidebar": SidebarSlot }, () => [
  // Replaces the default skeleton; SidebarLoader from handler.use still runs.
  loading(<SiteSpecificSidebarSkeleton />),
]);
```

## Composable parallel slots (the main pay-off)

The parallel slot site is where `handler.use` shines. A slot handler that owns its data/loading lets a layout declare **just** the slot names — every loader, skeleton, and revalidation contract travels with the slot itself.

### Without `handler.use` (every caller wires it up)

```typescript
layout(<DashboardLayout />, () => [
  parallel({ "@cart": CartSummary }, () => [
    loader(CartLoader),
    loading(<CartSkeleton />),
    revalidate(revalidateCartData),
  ]),
  parallel({ "@notifs": NotificationPanel }, () => [
    loader(NotificationsLoader),
    loading(<NotifsSkeleton />),
    revalidate(revalidateNotifs),
  ]),
  path("/dashboard", DashboardIndex, { name: "dashboard.index" }),
]);
```

Every layout that wants `@cart` must repeat the same loader/loading/revalidate triplet.

### With `handler.use` (slot owns its dependencies)

```typescript
const CartSummary: Handler = async (ctx) => {
  const cart = await ctx.use(CartLoader);
  return <CartSummaryView cart={cart} />;
};
CartSummary.use = () => [
  loader(CartLoader),
  loading(<CartSkeleton />),
  revalidate(revalidateCartData),
];

const NotificationPanel: Handler = async (ctx) => {
  const items = await ctx.use(NotificationsLoader);
  return <NotificationsView items={items} />;
};
NotificationPanel.use = () => [
  loader(NotificationsLoader),
  loading(<NotifsSkeleton />),
  revalidate(revalidateNotifs),
];

// Mount sites become declarative — no per-call data wiring.
layout(<DashboardLayout />, () => [
  parallel({ "@cart": CartSummary, "@notifs": NotificationPanel }),
  path("/dashboard", DashboardIndex, { name: "dashboard.index" }),
]);

layout(<AccountLayout />, () => [
  // Same slot, same defaults, zero re-wiring.
  parallel({ "@cart": CartSummary }),
  path("/account", AccountIndex, { name: "account.index" }),
]);
```

Each slot handler is now a portable, self-contained unit. Different layouts can use the same slot without copying data plumbing.

### Streaming behavior is per-slot

A slot's `loading()` (whether from `handler.use` or explicit) makes that slot an independent streaming unit — its loader does not block the parent layout. Two slot handlers with their own loading skeletons stream independently.

```typescript
parallel({
  "@cart": CartSummary, // handler.use loading() → streams independently
  "@cartBadge": CartBadge, // no loading() anywhere → awaited before paint
});
```

### Mount-site overrides are broadcast to every slot in the call

`parallel({...slots}, () => [...use])` runs the explicit `use()` callback **once per slot**, with the same items applied to each slot's entry ([dsl-helpers.ts](../../src/route-definition/dsl-helpers.ts)). That works fine for items that accumulate (loaders, revalidate). It is a sharp edge for `loading()` and any other single-assignment item, because the same mount-site value lands on every slot.

```typescript
parallel({ "@cart": CartSummary, "@notifs": Notifs }, () => [
  // This loading skeleton is set on BOTH @cart AND @notifs, replacing
  // each slot's handler.use loading() default. There is no syntax for
  // "this loading is for @cart only" inside one parallel() call.
  loading(<GenericSkeleton />),
]);
```

If you want per-slot loading overrides, mount each slot in its own `parallel()` call:

```typescript
// @cart gets a custom skeleton; @notifs keeps its handler.use loading().
parallel({ "@cart": CartSummary }, () => [loading(<CartSkeleton />)]);
parallel({ "@notifs": Notifs });
```

The same applies to `loading(false)` (opting back out of streaming): if you put it in a multi-slot `parallel()` call, every slot loses its skeleton. Split the call to scope the opt-out.

For items that accumulate (`loader`, `middleware`, `revalidate`, `errorBoundary`, `notFoundBoundary`), the broadcast behavior is usually what you want — the explicit items run for every slot in addition to each slot's own `handler.use` items.

### Replacing a whole slot from a parent's `handler.use`

A handler can publish a default `parallel({...})` set via its `.use`, and the mount site can replace any individual slot by re-declaring it. Last `parallel()` per slot name wins (see `skills/parallel` § Slot Override Semantics).

```typescript
const ProductPage: Handler<"/product/:slug"> = (ctx) => (
  <article>
    <ProductHero slug={ctx.params.slug} />
    <ParallelOutlet name="@related" />
    <ParallelOutlet name="@reviews" />
  </article>
);
ProductPage.use = () => [
  parallel({
    "@related": DefaultRelatedProducts,
    "@reviews": DefaultReviews,
  }),
];

path("/product/:slug", ProductPage, { name: "product" }, () => [
  // Override @related only; @reviews keeps the default from handler.use.
  parallel({ "@related": SiteSpecificRelated }),
]);
```

## Other mount sites

### Pages (`path()`)

Page handlers can carry middleware, loaders, error boundaries, parallel slots, etc. — anything from the `path` row of the table above.

```typescript
const CheckoutPage: Handler<"/checkout"> = async (ctx) => { /* … */ };
CheckoutPage.use = () => [
  middleware(requireAuth),
  loader(CartLoader),
  errorBoundary(<CheckoutError />),
  notFoundBoundary(<CheckoutNotFound />),
];
```

### Layouts (`layout()`)

Layout handlers can carry middleware that runs for every child route, plus default parallels, includes, etc.

```typescript
const AdminLayout: Handler = (ctx) => {
  const user = ctx.get(CurrentUser);
  return <Admin user={user} />;
};
AdminLayout.use = () => [
  middleware(requireAdmin),
  parallel({ "@adminNotifs": AdminNotifsSlot }),
];
```

### Intercepts (`intercept()`)

Intercept handlers can carry their own middleware chain, loaders, and even nested layouts/routes for the modal shell.

```typescript
const QuickViewModal: Handler = async (ctx) => {
  const product = await ctx.use(ProductLoader);
  return <QuickView product={product} />;
};
QuickViewModal.use = () => [
  loader(ProductLoader),
  loading(<QuickViewSkeleton />),
  layout(<ModalChrome />),
];
```

## `loading()` is a special case — and breaks the multi-slot composition

Most `use` items accumulate when merged: `handler.use` `middleware()` runs _and_ explicit `middleware()` runs; both `loader()` registrations apply. `loading()` is different in two ways that interact badly with parallel slots.

**1. `loading()` is a single assignment, not compositional metadata.** Each call sets `entry.loading` directly, and the last call wins ([dsl-helpers.ts `loadingFn`](../../src/route-definition/dsl-helpers.ts)). With the merge order (`handler.use` first, explicit second), an explicit `loading()` at the mount site cleanly replaces the handler's default skeleton. So far so good.

**2. The mount-site `parallel(..., () => [...])` callback is broadcast to every slot.** As described above, `parallel()` runs the explicit `use()` callback once per slot, with the same items applied to each slot's entry. Combined with single-assignment `loading()`, this means a single `loading()` in a multi-slot `parallel()` overwrites every slot's `handler.use` loading default.

The "slot owns its own skeleton" composition story therefore **only holds when each slot lives in its own `parallel()` call**. Multi-slot calls share the explicit `loading()`.

```typescript
const Cart: Handler = async (ctx) => { /* … */ };
Cart.use = () => [loader(CartLoader), loading(<CartSkeleton />)];

const Notifs: Handler = async (ctx) => { /* … */ };
Notifs.use = () => [loader(NotifsLoader), loading(<NotifsSkeleton />)];

// ❌ Broken — both slots end up with <GenericSkeleton />, the explicit
// loading() is broadcast to @cart AND @notifs, replacing each handler.use
// default. There is no syntax to scope loading() to one slot here.
parallel({ "@cart": Cart, "@notifs": Notifs }, () => [
  loading(<GenericSkeleton />),
]);

// ✅ Each slot keeps its own handler.use loading.
parallel({ "@cart": Cart, "@notifs": Notifs });

// ✅ Per-slot override — split into separate parallel() calls.
parallel({ "@cart": Cart }, () => [loading(<CustomCartSkeleton />)]);
parallel({ "@notifs": Notifs });
```

The same applies to `loading(false)` (opting back out of streaming): in a multi-slot call, every slot loses its skeleton.

**Other gotchas that fall out of this:**

- Any `loading()` (regardless of source) makes the segment a streaming unit. A handler that includes `loading()` in its `.use` opts every mount site into streaming by default. There is no way to "remove" it at the mount site — only to replace it, or to pass `loading(false)` (`loading: false` handling in [match-middleware/segment-resolution.ts](../../src/router/match-middleware/segment-resolution.ts)).
- Items that accumulate (`loader`, `middleware`, `revalidate`, `errorBoundary`, `notFoundBoundary`) compose across the broadcast cleanly — explicit items run on every slot in addition to each slot's `handler.use` items.

Rules of thumb:

- Only put `loading()` in `handler.use` if every mount site really should stream by default; otherwise leave it off and let each mount site opt in.
- If you need per-slot loading overrides at a mount site, split into one `parallel()` call per slot.

## Edge cases & gotchas

- **ReactNode handlers cannot have `.use`.** A bare JSX element passed as a handler (e.g., `path("/about", <About />)`) has no function to attach properties to. Pass a function or branded definition instead.
- **Branded handlers** — `Static()`, `Prerender()`, and `Passthrough()` are positional constructors (not object-arg). Construct first, then attach `.use` to the returned definition:

  ```typescript
  const ProductPage = Prerender(async (ctx) => {
    const product = await fetchProduct(ctx.params.slug);
    return <ProductView product={product} />;
  });
  ProductPage.use = () => [loader(ProductLoader)];
  ```

- **Items can be flat or nested arrays.** `handler.use()` results are flattened with `.flat(3)` before validation, so factory helpers that return arrays inline work the same as in regular `use()` callbacks.
- **Validation runs at registration / first match**, not at handler definition. A handler doesn't know its mount site at definition time — the same handler used in a `path()` and an `intercept()` is validated against each mount's allowed-types set when registered.
- **No silent shadowing.** If a disallowed item slips through (e.g., a layout factory returning `cache()` from a slot's `handler.use`), the runtime throws with the offending type and mount site named.

## Cross-references

- `skills/route` — `path()` mount site basics
- `skills/layout` — `layout()` mount site basics
- `skills/parallel` — parallel slot semantics, slot override rules, streaming behavior
- `skills/intercept` — intercept mount site basics
- `skills/loader` — defining `createLoader` and reading via `ctx.use()`
- `skills/middleware` — middleware semantics and ordering
