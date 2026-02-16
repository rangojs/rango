# Remove Client RouteMap - Replace with `useMount()` + Typed `href()`

## Problem

Every RSC response sends the **full** `getGlobalRouteMap()` to the client. For 10k+ route apps this:
1. Creates a huge payload on every navigation
2. Leaks internal route names/patterns to the client
3. Client-side `useHref()` named resolution is fundamentally hard to do right with partial maps

## Solution: Remove client route map entirely

**Server** keeps `ctx.reverse("post", { slug })` - named route resolution with full map.
**Client** uses `href('/post/my-slug', mount)` - typed paths with mount-point awareness. Zero route map.

```tsx
import { href, useMount } from "@rangojs/router/client";

function BlogNav({ slug }) {
  const mount = useMount(); // "/articles" (from include URL prefix)
  return (
    <>
      <Link to={href("/", mount)}>Blog Home</Link>
      <Link to={href(`/${slug}`, mount)}>Post</Link>
    </>
  );
}
```

Without mount (root-level navigation):
```tsx
<Link to={href("/shop/cart")}>Cart</Link>
```

No type safety needed:
```tsx
<a href="/whatever">Link</a>
<Link to="/whatever">Link</Link>
```

## Why This Works

| Concern | How it's solved |
|---------|----------------|
| Payload size | Zero route data sent to client. `useMount()` is one string in React context |
| Leaks internals | Only the current module's mount path is exposed |
| Composability | `include("/articles", Blog)` → `useMount()` returns "/articles". Change mount → client code doesn't break |
| Hydration | No route map to mismatch. Mount path is part of React tree |
| Type safety | Compile-time validation of paths against route patterns |
| SPA navigation | No route map needed. Mount path is in React context, survives navigations |

## API Design

### Server (unchanged)
```tsx
// ctx.reverse() still uses named routes with full map
path("/:slug", (ctx) => {
  const url = ctx.reverse("shop.cart"); // named resolution, server-only
  return <BlogPost cartUrl={url} />;
}, { name: "post" });
```

### Client (new)
```tsx
import { href, useMount } from "@rangojs/router/client";

// href(path, mount?) - type-safe at compile time, string concat at runtime
function href(path: string, mount?: string): string {
  return mount ? mount + path : path;
}

// useMount() - returns the current include's URL prefix
function useMount(): string {
  return useContext(MountContext);
}
```

---

## Implementation Steps

### Phase 1: Add `useMount()` + client `href()`

#### 1a. New: `MountContext`

**File:** `packages/rangojs-router/src/browser/react/mount-context.ts` (or co-locate in existing file)

```tsx
"use client";
import { createContext } from "react";
export const MountContext = createContext<string>("/");
```

#### 1b. New: `useMount()` hook

**File:** `packages/rangojs-router/src/browser/react/use-mount.ts`

```tsx
"use client";
import { useContext } from "react";
import { MountContext } from "./mount-context.js";

export function useMount(): string {
  return useContext(MountContext);
}
```

#### 1c. New: Client `href()` function

**File:** `packages/rangojs-router/src/browser/href.ts`

```ts
// Runtime: trivial string concat
// Type safety: compile-time validation (types TBD based on route pattern inference)
export function href(path: string, mount?: string): string {
  return mount ? mount + path : path;
}
```

#### 1d. Wrap include layouts with `MountContext.Provider`

During segment rendering, when a layout comes from an include, wrap its subtree with the mount path. The include's URL prefix is already known in the entry data.

**File:** `packages/rangojs-router/src/segment-system.tsx`

When rendering a layout segment from an include, wrap:
```tsx
<MountContext.Provider value={entry.urlPrefix}>
  {children}
</MountContext.Provider>
```

For nested includes, each level wraps its own provider. `useMount()` returns the nearest one:
```
include("/articles", ...)          → useMount() = "/articles"
  include("/comments", ...)        → useMount() = "/articles/comments"
```

#### 1e. Export from client entry

**File:** `packages/rangojs-router/src/client.tsx`

Add exports:
```ts
export { useMount } from "./browser/react/use-mount.js";
export { href } from "./browser/href.js";
```

### Phase 2: Remove client routeMap infrastructure

#### 2a. Remove `routeMap` from RSC payload metadata

**File:** `packages/rangojs-router/src/rsc/handler.ts`

Remove all ~15 `routeMap: getGlobalRouteMap()` from metadata objects.

**File:** `packages/rangojs-router/src/rsc/types.ts`

Remove `routeMap?: Record<string, string>` from metadata type.

#### 2b. Remove `HrefProvider` from SSR module

**File:** `packages/rangojs-router/src/ssr/index.tsx` (lines 265-271)

Remove:
```tsx
invariant(resolved.metadata?.routeMap, "SSR payload must include routeMap in metadata");
content = (
  <HrefProvider routeMap={resolved.metadata.routeMap} routeName={resolved.metadata.routeName}>
    {content}
  </HrefProvider>
);
```

#### 2c. Remove `HrefProvider` from NavigationProvider

**File:** `packages/rangojs-router/src/browser/react/NavigationProvider.tsx` (lines 253-271)

Remove the `hrefContextValue` memo and `HrefProvider` wrapping.

#### 2d. Remove `useHref()` hook

**File:** `packages/rangojs-router/src/browser/react/use-href.tsx`

Remove or deprecate `useHref()`. Keep file for `HrefProvider` if still needed server-side, or remove entirely.

#### 2e. Remove `HrefContext`

**File:** `packages/rangojs-router/src/href-context.ts`

Remove if no longer used anywhere.

#### 2f. Remove `routeMap` from render pipeline

**File:** `packages/rangojs-router/src/segment-system.tsx` - Remove `routeMap` and `routeName` from `RenderSegmentsOptions`
**File:** `packages/rangojs-router/src/router/match-context.ts` - Remove `routeMap` field from `MatchContext`
**File:** `packages/rangojs-router/src/types.ts` - Remove `routeMap` from `MatchResult`
**File:** `packages/rangojs-router/src/router/match-result.ts` - Remove `routeMap` from result construction
**File:** `packages/rangojs-router/src/browser/types.ts` - Remove `routeMap` from client payload types

#### 2g. Clean up exports

**File:** `packages/rangojs-router/src/client.tsx` - Remove `useHref`, `HrefProvider`, `HrefContext` exports
**File:** `packages/rangojs-router/src/client.rsc.tsx` - Remove `useHref`, `HrefProvider`, `HrefContext` re-exports

### Phase 3: Tests

#### 3a. Unit tests for `href()`

**File:** `packages/rangojs-router/src/__tests__/client-href.test.ts`

- `href("/foo")` returns `"/foo"` (no mount)
- `href("/foo", "/articles")` returns `"/articles/foo"` (with mount)
- `href("/", "/articles")` returns `"/articles/"` (root path with mount)
- `href("/foo", "/")` returns `"/foo"` (root mount)
- Edge cases: trailing slashes, empty strings

#### 3b. Unit tests for `useMount()`

**File:** `packages/rangojs-router/src/__tests__/use-mount.test.tsx`

- Returns `"/"` when no provider (default context)
- Returns correct mount path when wrapped in `MountContext.Provider`
- Nested providers: inner overrides outer (`useMount()` returns nearest)

#### 3c. Update `href-types.test.ts`

**File:** `packages/rangojs-router/src/__tests__/href-types.test.ts`

- Remove or update type tests that reference `ReverseFunction`, `ScopedReverseFunction` if those types are removed
- Add type tests for the new client `href()` signature if typed paths are added

#### 3d. Update E2E `href.test.ts`

**File:** `packages/rangojs-router/e2e/href.test.ts`

- Keep server-side `ctx.reverse` tests (unchanged)
- Replace client-side `useHref` tests with equivalent `href()` + `useMount()` tests
- Update test-app components that use `useHref` to use the new API

#### 3e. New E2E tests for `useMount()` with includes

**File:** `packages/rangojs-router/e2e/href.test.ts` (extend existing, or new `mount.test.ts`)

- `useMount()` returns `"/"` at root level
- `useMount()` returns correct prefix inside `include("/articles", ...)`
- Nested includes: `useMount()` returns composed path (e.g. `"/articles/comments"`)
- `href()` + `useMount()` produces correct links for navigation
- Links work after SPA navigation (mount context survives navigations)
- Test in both dev and build modes

#### 3f. Verify no routeMap in RSC payload

**File:** `packages/rangojs-router/e2e/href.test.ts` (or `bundle-analysis.test.ts`)

- Intercept RSC network response, assert `routeMap` key is absent from metadata
- Verify payload size reduction (no route patterns leaked)

#### 3g. Hydration check

**File:** `packages/rangojs-router/e2e/href.test.ts`

- Navigate, verify no hydration mismatch warnings in console (`expectNoPageError`)
- SSR-rendered href values match client-side values after hydration

### Phase 4: Migrate all apps and fixture apps

#### 4a. `examples/vite-rsc-demo/` (2 files)

- `src/layouts/RootLayout.tsx` — already uses path-based `href("/")`, `href("/blog")` etc. Verify import source, may already be compatible or needs import switch.
- `src/handlers/kanban/CardDetail.tsx` — uses `useHref()` → `href("kanban.index")`. Migrate to `ctx.reverse("kanban.index")` on server, or path-based `href("/kanban", mount)` on client.

#### 4b. `examples/cloudflare-basic/` (3 files)

- `src/components/NavLayout.tsx` — uses `useHref()` → `href("home")`, `href("about")`. Migrate to path-based `href()` + `useMount()`.
- `src/router.tsx` — uses `type AppRoutes = typeof router.routeMap` + module augmentation `RegisteredRoutes`. Remove `routeMap` type usage, update type registration.
- `src/pages/blog.tsx` — uses exported `href("home")`, `href("blogPost", { slug })` on server side. Server `href` is unchanged, just verify import path.

#### 4c. `examples/cloudflare-basic-nonce/` (2 files)

- `src/components/Document.tsx` — uses `useHref()` → `href("home")`, `href("about")`. Migrate to path-based `href()` + `useMount()`.
- `src/router.tsx` — uses `type AppRoutes = typeof router.routeMap` + `export const href = router.reverse`. Remove `routeMap` type, keep server `href` export.

#### 4d. `e2e/test-app/` (4 files)

- `src/router.tsx` — uses `type AppRoutes = typeof router.routeMap`. Update type registration.
- `src/components/HrefTestClient.tsx` — uses `useHref()` for client-side resolution (`href("index")`, `href("detail", { id })`, `href("blog.index")`, `href("/about")`). Migrate to new client `href()` + `useMount()`. This is the primary test component — migrate carefully.
- `src/urls/href.tsx` — server-side `ctx.reverse()` calls. Unchanged.
- `src/types/href-types.check.ts` — type checking file. Update to match new types.

#### 4e. `e2e/e2e-basic/` (2 files)

- `src/router.tsx` — uses `type AppRoutes = typeof router.routeMap`. Update type registration.
- `src/components/UseHrefDemo.tsx` — uses `useHref()` → `href("/about")`, `href("shop.cart")`, `href("blog.post", { slug })`. Migrate to new client `href()` + `useMount()`.

#### Migration checklist per app

For each app above:
1. Replace `useHref()` imports with `href, useMount` from `@rangojs/router/client`
2. Replace `href("routeName")` calls with path-based `href("/path", mount)` or keep as server-side `ctx.reverse("routeName")`
3. Remove `type AppRoutes = typeof router.routeMap` + `RegisteredRoutes` augmentation
4. Remove any `HrefProvider` / `HrefContext` imports
5. Verify the app builds and runs

### Phase 5: Clean up `virtual:rangojs-route-manifest` references

Search for and remove any remaining references.

---

## Server-side `ctx.reverse()` - NO CHANGES

These files are **unchanged** - server keeps full route map:
- `packages/rangojs-router/src/route-map-builder.ts` - `getGlobalRouteMap()` still used server-side
- `packages/rangojs-router/src/router/handler-context.ts` - `ctx.reverse()` still resolves named routes
- `packages/rangojs-router/src/router.ts` - still passes routeMap to handler context

---

## Key Investigation Needed

### How to get mount path into segments

The include's URL prefix needs to be available when rendering layout segments. Need to verify:
- Is `urlPrefix` available on `EntryData` or `ResolvedSegment`?
- Does `renderSegments()` know which segments come from includes?
- Where exactly to inject `MountContext.Provider` in the segment tree

### Type system for client `href()`

**Current system:** Server `ReverseFunction<TRoutes>` validates route *names* (`"blog.post"`) and params (`{ slug: string }`) at compile time. The route map type `{ "blog.post": "/blog/:slug" }` is built via phantom types on `UrlPatterns._routes` and `TypedIncludeItem.__routes/__urlPrefix/__namePrefix`, composed through `PrefixPatterns` and `PrefixRoutes` type transforms.

**New client `href()` needs path-based types, not name-based.** The question is: how do we type `href("/blog/:slug", mount)` when the paths come from `include()`?

**Prior art:** The old `rsc-router` package (on main, now removed) had a type-safe client `href()` in `packages/rsc-router/src/href-client.ts`. It used `PatternToPath<T>` to convert route patterns to template literal types, validating *resolved paths* (not route names) at compile time. Key types:
- `PatternToPath<"/blog/:slug">` → `` `/blog/${string}` ``
- `ValidPaths<TRoutes>` → union of all `PatternToPath` results with optional `?`/`#` suffixes
- `href(path: ValidPaths): string` — identity function, compile-time only

That implementation validated *absolute* paths against all routes. The new version needs to work with *mount-relative* paths.

**Approach — start untyped, add types incrementally:**
1. Phase 1: `href(path: string, mount?: string): string` — no compile-time validation
2. Future: Reuse `PatternToPath` from the old implementation, but scope it. When `useMount()` is typed (e.g. via generic on the include), `href()` only accepts paths matching the include's local patterns.

**What this looks like with includes:**

```tsx
// Given: include("/articles", blogPatterns) where blogPatterns has { index: "/", post: "/:slug" }
// The composed routes are: { "blog.index": "/articles", "blog.post": "/articles/:slug" }

// Server (unchanged): ctx.reverse("blog.post", { slug: "hello" })

// Client (new, untyped initially):
const mount = useMount(); // "/articles"
href("/", mount)          // "/articles/"  — blog index
href(`/${slug}`, mount)   // "/articles/hello" — blog post

// Client (future typed version using PatternToPath from old rsc-router):
// Local patterns for blogPatterns: { index: "/", post: "/:slug" }
// PatternToPath<"/"> = "/"
// PatternToPath<"/:slug"> = `/${string}`
// ValidLocalPaths = "/" | `/${string}`
// href() inside this include only accepts these local patterns
```

**Key insight:** Client `href()` paths are *relative to the mount point*, not absolute. So the type system only needs the local route patterns (`"/"`, `"/:slug"`), not the fully composed ones. This makes typing simpler — a component inside an include only sees its own routes.

---

## Files Summary

| File | Change |
|------|--------|
| `src/browser/react/mount-context.ts` | **NEW** - MountContext |
| `src/browser/react/use-mount.ts` | **NEW** - useMount() hook |
| `src/browser/href.ts` | **NEW** - client href() function |
| `src/segment-system.tsx` | Add MountContext.Provider wrapping for include layouts |
| `src/client.tsx` | Export useMount, href; remove useHref, HrefProvider, HrefContext |
| `src/client.rsc.tsx` | Remove useHref, HrefProvider, HrefContext re-exports |
| `src/rsc/handler.ts` | Remove ~15 `routeMap: getGlobalRouteMap()` from metadata |
| `src/rsc/types.ts` | Remove routeMap from metadata type |
| `src/ssr/index.tsx` | Remove HrefProvider wrapping + invariant |
| `src/browser/react/NavigationProvider.tsx` | Remove HrefProvider wrapping + routeMap handling |
| `src/browser/react/use-href.tsx` | Remove/deprecate |
| `src/href-context.ts` | Remove |
| `src/segment-system.tsx` | Remove routeMap/routeName from RenderSegmentsOptions |
| `src/router/match-context.ts` | Remove routeMap field |
| `src/types.ts` | Remove routeMap from MatchResult |
| `src/router/match-result.ts` | Remove routeMap from result |
| `src/browser/types.ts` | Remove routeMap from payload types |

All paths above relative to `packages/rangojs-router/`.

### Migration targets (Phase 4)

| App | Files | Primary change |
|-----|-------|----------------|
| `examples/vite-rsc-demo/` | 2 | `useHref()` → path-based `href()` |
| `examples/cloudflare-basic/` | 3 | `useHref()` → `href()` + `useMount()`, remove `routeMap` type |
| `examples/cloudflare-basic-nonce/` | 2 | `useHref()` → `href()` + `useMount()`, remove `routeMap` type |
| `e2e/test-app/` | 4 | `useHref()` → `href()` + `useMount()`, update type checks |
| `e2e/e2e-basic/` | 2 | `useHref()` → `href()` + `useMount()`, remove `routeMap` type |
| **Total** | **13 files** | |

## Verification Checkpoints

1. **After Phase 1** — Run existing E2E + unit tests (additive, nothing removed, all should pass)
2. **After Phase 2** — Run tests; href-related E2E tests will fail until Phase 3/4 updates them
3. **After Phase 3** — New unit tests and updated E2E tests pass in both dev and build modes
4. **After Phase 4** — All migrated apps build and run; E2E tests pass for each fixture app
5. **After Phase 5** — Final full test run, grep codebase for stale references
