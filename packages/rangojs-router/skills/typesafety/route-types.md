# Route Types

## Route Definition with Type-Safe Names

```typescript
// urls.tsx
import { urls } from "@rangojs/router";

export const urlpatterns = urls(({ path, layout }) => [
  path("/", HomePage, { name: "home" }),
  path("/products", ProductsPage, { name: "products" }),
  path("/product/:slug", ProductPage, { name: "product" }),
  path("/cart", CartPage, { name: "cart" }),
  path("/checkout/:step?", CheckoutPage, { name: "checkout" }),
]);

// Route names are inferred from the { name } option
```

## Type-Safe href()

### Server: ctx.reverse with route names

In route handlers, `ctx.reverse()` uses two namespaces:

- **`.name`** — local route, resolved within the current `include()` scope
- **`name`** — global route, from the named-routes definition

```typescript
import type { Handler } from "@rangojs/router";

export const ProductHandler: Handler<"shop.product"> = (ctx) => {
  ctx.reverse(".cart"); // Local: /shop/cart
  ctx.reverse(".product", { slug: "widget" }); // Local: /shop/product/widget
  ctx.reverse("blog.post", { slug: "1" }); // Global: /blog/1
};
```

For type-safe local names, generate a route types file with `npx rango generate urls/shop.tsx`
and pass it as the second generic to `Handler` or `Prerender`:

```typescript
import type { Handler } from "@rangojs/router";
import type { routes } from "./shop.gen.js";

export const ProductHandler: Handler<"shop.product", routes> = (ctx) => {
  ctx.reverse(".cart"); // Type-safe local name
  ctx.reverse(".product", { slug: "widget" }); // Type-safe local with params
  ctx.reverse("blog.post", { slug: "hi" }); // Type-safe global name
};
```

### Client: href + useHref

On the client, `href()` validates paths against registered route patterns at compile time:

```typescript
"use client";
import { href, useHref, Link } from "@rangojs/router/client";

// href() validates absolute paths via PatternToPath types
href("/about");                        // Valid path
href("/blog/hello");                   // Matches /blog/:slug

// useHref() auto-prefixes with include() mount
function ShopNav() {
  const href = useHref();
  return <Link to={href("/cart")}>Cart</Link>; // "/shop/cart"
}
```

`href()` and the `Rango.Path` type read from `RegisteredRoutes` when you augment
it, otherwise from the auto-generated `GeneratedRouteMap` — so `rango generate`
alone type-checks `href()` paths with no manual augmentation. The augmentation
below is only needed for **`Rango.PathResponse`** (response-payload inference), which
`GeneratedRouteMap` cannot provide:

```typescript
// The alias is required: an interface heritage clause cannot take a `typeof`
// type query directly (TS1109).
type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface RegisteredRoutes extends AppRoutes {}
  }
}
```

For wrapper helpers, type the path parameter as `Rango.Path`. It is ambient (no
import) and shares `href()`'s compile-time path checking, so a wrapper stays in
sync with your routes automatically:

```typescript
import { href } from "@rangojs/router/client";

export const appHref = (path: Rango.Path): string => href(path);
```

For response-route payloads, `Rango.PathResponse<T>` is the ambient lookup. It
accepts a route _pattern_ **or** a concrete path, so it also serves as the return
type of a typed `fetch` wrapper. It only resolves once `RegisteredRoutes` carries
response metadata:

```typescript
import { href } from "@rangojs/router/client";

type Product = Rango.PathResponse<"/api/products/:id">; // by pattern
type Same = Rango.PathResponse<"/api/products/42">; // by concrete path

// Response inferred from the concrete path passed in:
async function get<T extends Rango.Path>(
  path: T,
): Promise<Rango.PathResponse<T>> {
  return fetch(href(path)).then((r) => r.json());
}
const product = await get("/api/products/42"); // Product (bare value)
```

Pattern keys (`/:id`) match exactly; a concrete path under a _nested_ dynamic
route can match several patterns and union their responses.

`Rango.PathResponse` describes the JSON **wire** shape, not the handler's raw
return. A `path.json()` handler returning `{ createdAt: Date }` resolves here to
`{ createdAt: string }` (bare value), matching what `r.json()` yields. This
is applied via the ambient `Rango.JsonSerialize<T>` transform (`Date -> string`,
honors `toJSON()`, drops functions/`undefined`, `bigint -> never`). A separate
`Rango.FlightSerialize<T>` models the higher-fidelity RSC Flight boundary
(loaders / RSC props, where `Date` is preserved) — do **not** use it for
`path.json()`.

### Overriding serialization globally

For your own types, the zero-config way to control the JSON wire shape is a
`toJSON()` method — `Rango.JsonSerialize` honors it, and it matches the runtime
exactly (`JSON.stringify` calls `toJSON()`):

```typescript
class Money {
  constructor(private cents: number) {}
  toJSON(): number {
    return this.cents;
  }
}
// Rango.JsonSerialize<Money> is number; Rango.PathResponse reflects it.
```

To override a transform for types you **don't** own (or for the Flight boundary,
which has no `toJSON()`), augment its override slot. Because `Rango.JsonSerialize`
/ `Rango.FlightSerialize` are type _aliases_ (TS can't merge those), you provide a
single member that is your **complete** transform, delegating to the built-in for
the cases you don't change:

```typescript
declare global {
  namespace Rango {
    interface JsonSerializeOverride<T> {
      app: T extends Decimal ? string : Rango.JsonSerializeBuiltin<T>;
    }
    interface FlightSerializeOverride<T> {
      app: T extends Money ? number : Rango.FlightSerializeBuiltin<T>;
    }
  }
}
// Rango.JsonSerialize<Decimal> -> string; Rango.FlightSerialize<Money> -> number;
// everything else stays on the built-in, recursively (nested fields too).
```

Rules: provide **exactly one** member (the slot is read as
`Override<T>[keyof Override<T>]`, so multiple members union and conflict).
Overrides win over `toJSON()` and apply at every nesting level. Caveat for JSON:
the `path.json()` runtime is plain `JSON.stringify`, which only honors `toJSON()`,
so a `JsonSerializeOverride` that disagrees with what the runtime emits will lie —
prefer `toJSON()` for your own types and use the slot only for types you can't
modify.

See `/links` for full URL generation guide.

## Stable identity: `path#export`

Loaders, handles, cached functions (`functionId`), and server actions
(`actionId`) all share one identity scheme: `{modulePath}#{exportName}`,
injected at build by the `exposeInternalIds` and `exposeActionId` Vite plugins.
This is also the identity React server actions carry across the Flight boundary,
which is why a `revalidate()` predicate sees an action as a `path#export` string:

```typescript
revalidate(
  ({ actionId }) => actionId === "src/actions/cart.ts#addToCart" || undefined,
);
```

`actionId` is the only stable reference React exposes across the Flight boundary,
so it stays as the floor and escape hatch. The hand-written-string surface
(`actionId?.includes("cart.ts#")`) is brittle: a renamed action or moved file
silently stops matching with no compile error. Prefer **`ctx.isAction()`** in a
revalidate predicate — it resolves the action's id from an imported reference, so
a rename is a type error in one place instead of silent drift:

```ts
import { addToCart, removeFromCart } from "./actions/cart";
import * as CartActions from "./actions/cart";

revalidate((ctx) => ctx.isAction(addToCart) || undefined); // one action
revalidate((ctx) => ctx.isAction(addToCart, removeFromCart) || undefined); // several
revalidate((ctx) => ctx.isAction(CartActions) || undefined); // any action in the module
```

`ctx.isAction()` (only available on the revalidate predicate's context) returns a
raw boolean — combine with `|| undefined` for the "revalidate on match, else
defer" intent. It resolves the reference the same way the router derives
`actionId` (`$id` in production, `$$id` in dev), so matching
works in both modes. `actionId` stays available for advanced cases.
