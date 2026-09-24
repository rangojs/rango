# Route Definition Rules

Constraints enforced at definition time by `urls()`, `layout()`, `path()`, and
other route helpers. Violations throw immediately when the route tree is built:
nesting and naming violations throw an `Error` whose message starts with
`Invariant:` (from `invariant()` in `src/errors.ts`), and calling any helper
outside an active `urls()` builder throws a `DslContextError`
("`<helper>() must be called inside urls()`").

Guard locations below are relative to `src/`: `path()` guards live in
`urls/path-helper.ts`; the other helpers live in
`route-definition/dsl-helpers.ts`.

## Nesting Rules

### path()

| Rule                                        | Example                                                   | Guard location                        |
| ------------------------------------------- | --------------------------------------------------------- | ------------------------------------- |
| Cannot be inside `parallel()`               | `parallel({ "@slot": path(...) })`                        | `urls/path-helper.ts`                 |
| Cannot be nested inside another `path()`    | `path("/a", A, () => [path("/b", B)])`                    | `urls/path-helper.ts` (ancestor walk) |
| Ancestor walk catches intermediate wrappers | `path("/a", A, () => [layout(L, () => [path("/b", B)])])` | `urls/path-helper.ts` (ancestor walk) |
| Same through cache boundaries               | `path("/a", A, () => [cache(c, () => [path("/b", B)])])`  | `urls/path-helper.ts` (ancestor walk) |

### layout()

| Rule                                                 | Example                                                  | Guard location                    |
| ---------------------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| Cannot be inside `parallel()`                        | `layout(L)` inside parallel callback                     | `route-definition/dsl-helpers.ts` |
| Orphan layout cannot contain other layouts           | `layout(A, () => [layout(B)])` where A has no routes     | `route-definition/dsl-helpers.ts` |
| Orphan layout at non-root level needs parent         | Orphan layout floating without route/layout/cache parent | `route-definition/dsl-helpers.ts` |
| Orphan layout parent must be route, layout, or cache | Orphan layout inside parallel or intercept               | `route-definition/dsl-helpers.ts` |

### parallel()

| Rule                                         | Example                             | Guard location                    |
| -------------------------------------------- | ----------------------------------- | --------------------------------- |
| Cannot be nested inside another `parallel()` | `parallel({ "@a": parallel(...) })` | `route-definition/dsl-helpers.ts` |
| Needs a parent entry                         | `parallel()` at root level          | `route-definition/dsl-helpers.ts` |

### intercept()

| Rule                                                                                                          | Example                                                    | Guard location                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Cannot be inside `parallel()`                                                                                 | `parallel({ "@a": intercept(...) })`                       | `route-definition/dsl-helpers.ts`                                                                  |
| Needs a parent entry                                                                                          | `intercept()` at root level                                | `route-definition/dsl-helpers.ts`                                                                  |
| `use()` and the handler's `.use` hold only `middleware`, `loader`, `loading`, `layout`, `route`, `transition` | `intercept(s, r, H, () => [revalidate(fn)])`               | `route-definition/resolve-handler-use.ts` (`validateInterceptUseItems`, called from `intercept()`) |
| A nested `layout()` is the modal chrome only: no `use()` items of its own                                     | `intercept(s, r, H, () => [layout(C, () => [loader(L)])])` | `route-definition/resolve-handler-use.ts`                                                          |

Each rejected item gets a pointer to where it goes instead:

- `revalidate()`: on the intercept's loader, `loader(Def, () => [revalidate(fn)])`.
- `errorBoundary()` / `notFoundBoundary()`: on the layout or path that
  declares the intercept (or an ancestor). Errors and `notFound()` from the
  intercept's handler (since #878) and from its loaders resolve there, as the
  modal slot's content; the intercepted target route's boundaries are not
  consulted. When the declaring layout has no routes of its own (an orphan),
  the lookup continues at the layout that holds it and that layout's
  ancestors (see "How orphan layouts work").
- `cache()`: on the target route (an intercept navigation gets its own
  `intercept:` cache key under the target route's scope), or `"use cache"` in
  the handler. A `cache()` called in the scope is rejected even when it is not
  returned.

`intercept()`'s temporary parent points every field a rejected helper writes
to at a throwaway, so a helper called but not returned from `use()` never
lands on the enclosing layout.

### `when` (intercept config)

The match-time selector is the `when` field of the `intercept()` config object
(4th argument), not a standalone DSL helper. It is a single predicate or an
array of predicates (AND logic); omit it to always activate.

| Rule                                             | Example                                                     | Guard location                    |
| ------------------------------------------------ | ----------------------------------------------------------- | --------------------------------- |
| Only valid on `intercept()` (no standalone form) | `intercept(slot, route, Comp, { when: ({ from }) => ... })` | `route-definition/dsl-helpers.ts` |

### Route names

| Rule                                        | Example                                    | Guard location                                           |
| ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| Must be unique across the entire route tree | Two `path()` calls with `{ name: "home" }` | `urls/path-helper.ts`, `route-definition/dsl-helpers.ts` |

## Orphan Layout Behavior

An **orphan layout** is a layout with no route children (directly or through
nested `cache()`, `middleware()`, wrapper-form `transition()` blocks, or
includes). Orphan layouts are composable wrappers that attach to
their parent's `layout[]` array.

### What orphan layouts CAN have as children

- `middleware()` -- middleware applied at render time via segment resolution
- `loading()` -- loading skeleton for Suspense boundary
- `loader()` -- data loader for the layout segment
- `errorBoundary()` -- error boundary wrapping the layout
- `notFoundBoundary()` -- not-found boundary wrapping the layout
- `cache()` (orphan, without children) -- cache config
- `parallel()` -- parallel slots

### What orphan layouts CANNOT have as children

- Other `layout()` calls (nested orphan layout chains are broken at render time)

### How orphan layouts work

1. During definition, `hasRoutesInItem()` determines if a layout is orphan. It
   recurses through every wrapper item that carries `uses` — `cache`, `layout`,
   `middleware` and wrapper-form `transition` — so
   `layout(Shell, () => [transition(cfg, () => [path(...)])])` is NOT an orphan
   (scar tissue: before the `transition` case existed, that shape was pushed
   onto the parent's `layout[]` and Shell wrapped every sibling route)
2. Orphan layouts get `parent = null` and are pushed to `parent.layout[]`.
   `orphanOwner` records that parent (`attachOrphanSibling`), and only the
   boundary walkers in `router/error-handling.ts` follow it: an error lookup
   that starts at the orphan (its own loaders, an intercept it declares)
   continues at the owner and the owner's ancestors. Before issue #898 that
   walk stopped at the orphan, so an ancestor's `errorBoundary()` never
   handled those errors. `parent` itself stays null: `matchError`'s
   matched-id stack (`router/match-api.ts`) starts at the entry that holds
   the boundary, which can be an orphan, and must stop there
3. At runtime, `resolveOrphanLayout()` creates segments for each orphan layout
4. `collectRouteMiddleware()` recursively processes orphan layouts for middleware
5. The segment system renders orphan layout components as wrappers around route content

### Sibling orphan layouts vs nested

```typescript
// VALID: sibling orphan layouts (flat)
layout(RootLayout, () => [
  layout(AuthWrapper, () => [middleware(authMw)]),
  layout(ThemeWrapper, () => [middleware(themeMw)]),
  path("/", HomePage, { name: "home" }),
]);

// INVALID: nested orphan layouts (throws at definition time)
layout(RootLayout, () => [
  layout(AuthWrapper, () => [
    layout(ThemeWrapper, () => [middleware(themeMw)]), // THROWS
  ]),
  path("/", HomePage, { name: "home" }),
]);
```

## Orphan Cache Behavior

An **orphan cache** (without children callback) replaces `ctx.parent`, so
subsequent siblings become children of the cache entry.

```typescript
layout(RootLayout, () => [
  cache({ ttl: 300 }), // replaces ctx.parent
  path("/", HomePage), // parent is now the cache, not RootLayout
  path("/about", AboutPage), // same: parent is cache
]);
```

A cache **with** children callback but no routes among its children is treated
like an orphan layout and pushed to `parent.layout[]`.

Inside a `loader()` use callback, `cache()` is not a structural entry: it sets
that loader's own cache config (`loader(Def, () => [cache({ ttl: 60 })])`) and
does not change `ctx.parent`. A `cache()` **with** children is rejected there.

Among a `path()`'s children, `cache()` is not a structural entry either: both
forms set the route entry's own `cache` config and leave `ctx.parent` on the
route, and the wrapper form's children attach to the route as if listed after
it. The route then carries its own cache scope with itself as the boundary
(`buildEntriesAndCacheScope` in `router/route-snapshot.ts`), so the route
segment and its own layouts and parallels are the cached unit. Before issue
#912 it created an orphan cache entry here. That entry was never an ancestor
of the route, so no scope was built, and a `layout()` declared after it nested
under the entry, where `resolveOrphanLayout()` never rendered it.

## include() Behavior

`include()` items are treated as containing routes by `hasRoutesInItem()`. This
prevents the parent layout from being misclassified as orphan when `include()`
is the only child, which would break the middleware chain.

```typescript
// VALID: layout middleware applies to included routes
layout(AuthLayout, () => [
  middleware(authMw),
  include("/blog", blogPatterns, { name: "blog" }),
]);

// VALID: middleware inside included patterns (stacks with parent middleware)
const blogPatterns = urls(({ path, layout, middleware }) => [
  layout(BlogLayout, () => [
    middleware(blogMw), // applies to all blog routes
    path("/", BlogIndex, { name: "index" }),
    path("/:postId", BlogPost, { name: "post" }),
  ]),
]);
```

Included patterns use the full `urls()` builder, so they support `layout()`,
`middleware()`, `cache()`, nested `include()`, and all other helpers. Middleware
chains stack: parent layout middleware runs first, then middleware from within
the included patterns.

### Middleware wrapping

`middleware()` supports two modes:

- **Sibling mode** — `middleware(fn)` or `middleware([fn1, fn2])` attaches
  middleware to the parent entry.
- **Wrapping mode** — `middleware(fn, () => [...])` or
  `middleware([fn1, fn2], () => [...])` creates a transparent layout that
  scopes middleware to the children callback only.

```text
// Wrapping: authMw only applies to /admin and /admin/settings
middleware(authMw, () => [
  path("/admin", AdminPage, { name: "admin" }),
  path("/admin/settings", SettingsPage, { name: "settings" }),
]),
path("/public", PublicPage, { name: "public" }), // no authMw

// Multiple middleware: use array form
middleware([authMw, loggingMw], () => [
  path("/admin", AdminPage, { name: "admin" }),
])
```

The variadic form `middleware(fn1, fn2)` is not supported. Use
`middleware([fn1, fn2])` to pass multiple middleware.

### Name scoping

The `name` option determines child route visibility:

- **`{ name: "blog" }`** — children are prefixed (`blog.index`, `blog.post`).
  Visible in generated route types, globally reversible.
- **`{ name: "" }`** — children merge into the parent namespace with no prefix.
  Equivalent to defining those routes inline. Both global `ctx.reverse("child")`
  and dot-local `ctx.reverse(".child")` work (routes are at root scope).
- **Omitted** — children get a private `$prefix_N` scope. Hidden from the
  generated route map and global reverse. Only dot-local reverse
  (`ctx.reverse(".child")`) works from handlers inside the mounted module.

Without a name, `include()` is a composition mechanism for URL mounting
without polluting the global route namespace. To make child names available
globally, always pass an explicit `name` (even `""` for flat merging).

**`{ name: "" }` is flattening, not isolation.** Flattened routes behave as if
defined inline at the include site — dot-local reverse (`.name`) can reach any
sibling route at root scope, including routes from other `{ name: "" }` mounts.
If you need module-level isolation, omit the `name` option or use a namespace.

## TypeScript Coverage

Some rules are enforced at the type level via discriminated union types
(`RouteUseItem`, `ParallelUseItem`, etc.) — each helper returns an item carrying
a `type` literal discriminant, and a callback's return type only admits the union
members valid at that position (the items carry no nominal brand). TypeScript
only checks the **direct child** of a callback — nested violations (e.g., `path`
inside `layout` inside `path`) are NOT caught because the direct child
(`LayoutItem`) is a valid member of the union.

### Caught by TypeScript (direct child violations)

- `path()` (RouteItem) is not in `RouteUseItem` — direct path-in-path caught
- `path()` is not in `ParallelUseItem` — cannot be inside parallel
- `when` is the `intercept()` config field (`InterceptConfig`), not a use-item — it cannot appear in any use callback
- `parallel()` is not in `ParallelUseItem` — cannot nest
- `intercept()` is not in `ParallelUseItem` — cannot be inside parallel
- `revalidate()` is not in `InterceptUseItem` — direct revalidate-in-intercept caught
- `errorBoundary()` / `notFoundBoundary()` are not in `InterceptUseItem` — direct boundary-in-intercept caught
- `cache()` is not in `InterceptUseItem` — direct cache-in-intercept caught

### Runtime-only guards (TS cannot catch)

- `path()` inside `layout()` inside `path()` — direct child is `LayoutItem` (valid)
- `path()` inside `cache()` inside `path()` — direct child is `CacheItem` (valid)
- Orphan layout containing another orphan layout — both are `LayoutItem` (valid)
- `layout()` inside `parallel()` — `LayoutItem` is not in `ParallelUseItem` at
  the type level, but the runtime guard provides the error message
- `revalidate()`, `errorBoundary()`, `notFoundBoundary()` or `cache()` from a
  handler's `.use` mounted via `intercept()` — `.use` is typed
  `HandlerUseItem`, which is mount-agnostic
- A `layout()` with its own `use()` items inside `intercept()` — `LayoutItem`
  is a valid `InterceptUseItem`

Runtime guards use ancestor walks and context checks to catch these nested
violations at route tree build time.
