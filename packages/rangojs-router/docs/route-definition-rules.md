# Route Definition Rules

Constraints enforced at definition time by `urls()`, `layout()`, `path()`, and
other route helpers. Violations throw an `Invariant` error immediately when
the route tree is built.

## Nesting Rules

### path() (href)

| Rule | Example | Guard location |
|------|---------|----------------|
| Cannot be inside `parallel()` | `parallel({ "@slot": path(...) })` | `urls.ts` |
| Cannot be nested inside another `path()` | `path("/a", A, () => [path("/b", B)])` | `urls.ts` (ancestor walk) |
| Ancestor walk catches intermediate wrappers | `path("/a", A, () => [layout(L, () => [path("/b", B)])])` | `urls.ts` (ancestor walk) |
| Same through cache boundaries | `path("/a", A, () => [cache(c, () => [path("/b", B)])])` | `urls.ts` (ancestor walk) |

### layout()

| Rule | Example | Guard location |
|------|---------|----------------|
| Cannot be inside `parallel()` | `layout(L)` inside parallel callback | `route-definition.ts` |
| Orphan layout cannot contain other layouts | `layout(A, () => [layout(B)])` where A has no routes | `route-definition.ts` |
| Orphan layout at non-root level needs parent | Orphan layout floating without route/layout/cache parent | `route-definition.ts` |
| Orphan layout parent must be route, layout, or cache | Orphan layout inside parallel or intercept | `route-definition.ts` |

### parallel()

| Rule | Example | Guard location |
|------|---------|----------------|
| Cannot be nested inside another `parallel()` | `parallel({ "@a": parallel(...) })` | `route-definition.ts` |
| Needs a parent entry | `parallel()` at root level | `route-definition.ts` |

### intercept()

| Rule | Example | Guard location |
|------|---------|----------------|
| Cannot be inside `parallel()` | `parallel({ "@a": intercept(...) })` | `route-definition.ts` |
| Needs a parent entry | `intercept()` at root level | `route-definition.ts` |

### when()

| Rule | Example | Guard location |
|------|---------|----------------|
| Can only be used inside `intercept()` callback | `path("/a", A, () => [when(...)])` | `route-definition.ts` |

### Route names

| Rule | Example | Guard location |
|------|---------|----------------|
| Must be unique across the entire route tree | Two `path()` calls with `{ name: "home" }` | `urls.ts`, `route-definition.ts` |

## Orphan Layout Behavior

An **orphan layout** is a layout with no route children (directly or through
nested caches/includes). Orphan layouts are composable wrappers that attach to
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

1. During definition, `hasRoutesInItem()` determines if a layout is orphan
2. Orphan layouts get `parent = null` and are pushed to `parent.layout[]`
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
])

// INVALID: nested orphan layouts (throws at definition time)
layout(RootLayout, () => [
  layout(AuthWrapper, () => [
    layout(ThemeWrapper, () => [middleware(themeMw)]),  // THROWS
  ]),
  path("/", HomePage, { name: "home" }),
])
```

## Orphan Cache Behavior

An **orphan cache** (without children callback) replaces `ctx.parent`, so
subsequent siblings become children of the cache entry.

```typescript
layout(RootLayout, () => [
  cache({ ttl: 300 }),          // replaces ctx.parent
  path("/", HomePage),          // parent is now the cache, not RootLayout
  path("/about", AboutPage),    // same: parent is cache
])
```

A cache **with** children callback but no routes among its children is treated
like an orphan layout and pushed to `parent.layout[]`.

## include() Behavior

`include()` items are treated as containing routes by `hasRoutesInItem()`. This
prevents the parent layout from being misclassified as orphan when `include()`
is the only child, which would break the middleware chain.

```typescript
// VALID: layout middleware applies to included routes
layout(AuthLayout, () => [
  middleware(authMw),
  include("/blog", blogPatterns, { name: "blog" }),
])

// VALID: middleware inside included patterns (stacks with parent middleware)
const blogPatterns = urls(({ path, layout, middleware }) => [
  layout(BlogLayout, () => [
    middleware(blogMw),  // applies to all blog routes
    path("/", BlogIndex, { name: "index" }),
    path("/:postId", BlogPost, { name: "post" }),
  ]),
])
```

Included patterns use the full `urls()` builder, so they support `layout()`,
`middleware()`, `cache()`, nested `include()`, and all other helpers. Middleware
chains stack: parent layout middleware runs first, then middleware from within
the included patterns.

## TypeScript Coverage

Some rules are also enforced at the type level:

- `path()` is not in `ParallelUseItem` (cannot be inside parallel)
- `when()` is not in `RouteUseItem` or `LayoutUseItem` (only in intercept)
- `parallel()` is not in `ParallelUseItem` (cannot nest)
- `intercept()` is not in `ParallelUseItem` (cannot be inside parallel)

Runtime guards exist as a safety net for cases where TypeScript types are
bypassed (e.g., dynamic route construction, `as any` casts).
