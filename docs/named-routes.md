# Named Routes

Rango is a named-route router first.

Paths define where a route lives. Names define how the app refers to it.

That distinction is the main design idea:

- A path is local authoring detail
- A route name is the stable application reference
- `include()` lets modules keep local paths while exporting a namespaced route API

Rango is also structurally composable.

Routes, loaders, middleware, handles, caching, prerendering, and static generation can live in separate files or packages and still attach back into one visible route tree.

## Recommended Model

Use names for anything that matters outside the definition site.

```tsx
import { createRouter, urls } from "@rangojs/router";

const blogPatterns = urls(({ path }) => [
  path("/", BlogIndexPage, { name: "index" }),
  path("/:slug", BlogPostPage, { name: "post" }),
]);

const urlpatterns = urls(({ path, include }) => [
  path("/", HomePage, { name: "home" }),
  include("/blog", blogPatterns, { name: "blog" }),
]);

const router = createRouter({ document: Document }).routes(urlpatterns);

router.reverse("home"); // "/"
router.reverse("blog.index"); // "/blog"
router.reverse("blog.post", { slug: "hello-world" }); // "/blog/hello-world"
```

This gives you:

- stable route references during path refactors
- module composition without raw path coupling
- local naming inside a module and global naming at the app boundary

## Structural Composability

Many routing systems force a tradeoff:

- keep everything inline so the route tree is readable
- or extract behavior into modules and lose the view of the structure

Rango is trying to avoid that tradeoff.

You can keep the route tree explicit while attaching external capabilities where they belong.

```tsx
const shopPatterns = urls(({ path, loader, middleware, revalidate, cache }) => [
  path("/product/:slug", ProductPage, { name: "product" }, () => [
    middleware(productMiddleware),
    loader(ProductLoader),
    revalidate(productRevalidate),
    cache({ ttl: 300 }),
  ]),
]);
```

In practice, this means:

- routes can be defined in reusable modules and mounted with `include()`
- route behavior can be imported from external files or packages
- prerendering and static generation can be attached without hiding the app tree

## Why Names Matter

If a route is linked to from multiple places, a path string is an implementation detail.

Names are better because they:

- survive path changes
- work naturally with `reverse()`
- make `include("/prefix", patterns, { name: "namespace" })` valuable
- let reusable modules expose a route API instead of a path convention

## Route Styles

Rango supports multiple handler typing styles because they cover different authoring flows.

### Named Routes

Best default for app routes.

```tsx
path("/product/:slug", ProductPage, { name: "product" });

const ProductPage: Handler<"product"> = (ctx) => {
  return <h1>{ctx.params.slug}</h1>;
};
```

### Local Named Routes

Best for reusable included modules.

```tsx
import type { Handler } from "@rangojs/router";
import type { ScopedRouteMap } from "@rangojs/router/__internal";

type BlogRoutes = ScopedRouteMap<"blog">;

const BlogPostPage: Handler<".post", BlogRoutes> = (ctx) => {
  return <a href={ctx.reverse(".index")}>Back</a>;
};
```

Use this when a module defines local route names like `index` and `post`, and the app mounts them via `include(..., { name: "blog" })`.

### Path Literals

Useful when starting inline, extracting unnamed routes, or keeping a handler local.

```tsx
const BlogPostPage: Handler<"/blog/:slug"> = (ctx) => {
  return <h1>{ctx.params.slug}</h1>;
};
```

This is important support for the authoring workflow, but it is not the main abstraction.

### Explicit Params

Escape hatch for advanced or decoupled cases.

```tsx
const ProductPage: Handler<{ slug: string; tab?: string }> = (ctx) => {
  return <h1>{ctx.params.slug}</h1>;
};
```

## Rule of Thumb

- Name routes by default
- Use local names inside reusable modules
- Use path-literal typing for unnamed or local-only handlers
- Use explicit params only when route-derived typing is not a good fit
