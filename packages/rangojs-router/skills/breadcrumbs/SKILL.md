---
name: breadcrumbs
description: Built-in Breadcrumbs handle for accumulating breadcrumb navigation across route segments
argument-hint: "[setup]"
---

# Breadcrumbs

Built-in handle for accumulating breadcrumb items across route segments.
Each layout/route pushes items via `ctx.use(Breadcrumbs)`, and they are
collected in parent-to-child order with automatic deduplication by `href`.

## BreadcrumbItem Type

```typescript
interface BreadcrumbItem {
  label: string; // Display text
  href: string; // URL the breadcrumb links to
  content?: ReactNode | Promise<ReactNode>; // Optional extra content (sync or async)
}
```

## Pushing Breadcrumbs (Server)

Import `Breadcrumbs` from `@rangojs/router` in RSC/server context:

```typescript
import { urls, Breadcrumbs } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";

export const urlpatterns = urls(({ path, layout }) => [
  // Root layout pushes "Home"
  layout((ctx) => {
    const breadcrumb = ctx.use(Breadcrumbs);
    breadcrumb({ label: "Home", href: "/" });
    return <RootLayout />;
  }, () => [
    path("/", HomePage, { name: "home" }),

    // Nested layout pushes "Blog"
    layout((ctx) => {
      const breadcrumb = ctx.use(Breadcrumbs);
      breadcrumb({ label: "Blog", href: "/blog" });
      return <BlogLayout />;
    }, () => [
      path("/blog", BlogIndex, { name: "blog.index" }),

      // Route handler pushes post title
      path("/blog/:slug", (ctx) => {
        const breadcrumb = ctx.use(Breadcrumbs);
        breadcrumb({ label: ctx.params.slug, href: `/blog/${ctx.params.slug}` });
        return <BlogPost slug={ctx.params.slug} />;
      }, { name: "blog.post" }),
    ]),
  ]),
]);
```

On `/blog/my-post`, breadcrumbs accumulate: `Home > Blog > my-post`.

## Async Content

The `content` field supports `Promise<ReactNode>` for streaming:

```typescript
path("/product/:id", async (ctx) => {
  const breadcrumb = ctx.use(Breadcrumbs);
  const productPromise = fetchProduct(ctx.params.id);

  breadcrumb({
    label: "Product",
    href: `/product/${ctx.params.id}`,
    content: productPromise.then((p) => <span>({p.category})</span>),
  });

  const product = await productPromise;
  return <ProductPage product={product} />;
}, { name: "product" })
```

Async content is a `Promise<ReactNode>`. Resolve it in your component
with React's `use()` hook wrapped in `<Suspense>`.

### Deferred content (decide now, resolve from a deep component)

When the handler should DECIDE to push a crumb (it holds `ctx`, so the decision
must land before the handles stream seals) but the value is produced far away — by
a deep async component, not the handler — call `.defer()` on the push function.
`ctx.use(Handle)` returns the push function; `.defer(options)` reserves the crumb's
slot synchronously and returns a **resolver that is push-equal** — you call it
later, anywhere in the render, with the same argument you'd have passed to the
push (a value, a `Promise`, or a thunk). The only added behavior is a timeout, so a
forgotten resolve can't hang the render (and the HTTP response): resolve-by-default
awaits the reserved slot before any consumer reads it, and the timeout guarantees it
settles to `else` instead of blocking forever.

Reserve the slot in the handler, then resolve it from a nested async component
that closes over the resolver — no extra wiring (the resolver is a plain closure,
not outlet context):

```tsx
import { Breadcrumbs } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { Suspense } from "react";

function DocsLayout(ctx) {
  const breadcrumb = ctx.use(Breadcrumbs);
  // Decide now (the slot is reserved before the stream seals); resolve later.
  const resolveCrumb = breadcrumb.defer({ timeoutMs: 5000, else: null });

  // Deep, async, far from the handler — closes over the resolver, never touches ctx.
  // Same call shape as breadcrumb({ ... }), just deferred:
  async function LiveCrumb() {
    const n = await countOpenIssues();
    resolveCrumb({ label: "Docs", href: "/docs", content: <span>{n}</span> });
    return null;
  }

  return (
    <>
      <Suspense>
        <LiveCrumb />
      </Suspense>
      <Outlet />
    </>
  );
}
```

If the resolver is never called, the slot auto-resolves to `else` after
`timeoutMs` (default 10s) and warns in dev — graceful degradation instead of a
hung request. `timeoutMs: 0` or `Infinity` disable the timeout intentionally; any
other non-finite or negative value falls back to the default rather than silently
disabling the safety net.

**Consumer note (resolve-by-default):** a deferred crumb is RESOLVED before any
consumer sees it — `useHandle(Breadcrumbs)` returns the resolved item, never a
`Promise`, so you read it like any sync crumb (no `use()`, no thenable narrowing).
On a full/SSR load the value is resolved server-side; on a soft navigation the
breadcrumbs HOLD the previous resolved value until the deferred value lands, then
swap in — no blank, no pending entry. If the slot times out to `else: null`/
undefined, the entry is simply dropped. Use `.defer()` only when even
`label`/`href` are unknown at handler time — if you know them and only the
`content` is async, push a concrete item with a `Promise` `content` field instead
(the `content` field is a nested promise you resolve with `use()` in your
component; no `.defer()` needed).

## Consuming Breadcrumbs (Client)

Use `useHandle(Breadcrumbs)` in a client component to read the accumulated items:

```tsx
"use client";
import { useHandle, Breadcrumbs, Link } from "@rangojs/router/client";

function BreadcrumbNav() {
  const breadcrumbs = useHandle(Breadcrumbs);

  if (!breadcrumbs.length) return null;

  return (
    <nav aria-label="Breadcrumb">
      <ol>
        {breadcrumbs.map((crumb, i) => (
          <li key={crumb.href}>
            {i === breadcrumbs.length - 1 ? (
              <span aria-current="page">{crumb.label}</span>
            ) : (
              <Link to={crumb.href}>{crumb.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
```

### With Selector

Re-render only when the selected value changes:

```tsx
// Only the last breadcrumb
const current = useHandle(Breadcrumbs, (data) => data.at(-1));

// Breadcrumb count
const count = useHandle(Breadcrumbs, (data) => data.length);
```

## Deduplication

The built-in collect function deduplicates by `href`. If multiple segments
push the same `href`, the last one wins. This prevents duplicates when
navigating between sibling routes that share a common breadcrumb.

## Passing as Props

Breadcrumbs handle can be passed from server to client components:

```tsx
// Server component
path("/dashboard", (ctx) => {
  const breadcrumb = ctx.use(Breadcrumbs);
  breadcrumb({ label: "Dashboard", href: "/dashboard" });
  return <DashboardNav handle={Breadcrumbs} />;
});
```

```tsx
// Client component
"use client";
import { useHandle, Breadcrumbs } from "@rangojs/router/client";

function DashboardNav({ handle }: { handle: typeof Breadcrumbs }) {
  const crumbs = useHandle(handle);
  return (
    <nav>
      {crumbs.map((c) => (
        <a href={c.href}>{c.label}</a>
      ))}
    </nav>
  );
}
```

## Complete Example

```typescript
// urls.tsx
import { urls, Breadcrumbs, Meta } from "@rangojs/router";
import { Outlet, MetaTags } from "@rangojs/router/client";
import { BreadcrumbNav } from "./components/BreadcrumbNav";

function RootLayout() {
  return (
    <html lang="en">
      <head><MetaTags /></head>
      <body>
        <BreadcrumbNav />
        <main><Outlet /></main>
      </body>
    </html>
  );
}

export const urlpatterns = urls(({ path, layout }) => [
  layout((ctx) => {
    ctx.use(Breadcrumbs)({ label: "Home", href: "/" });
    ctx.use(Meta)({ title: "My App" });
    return <RootLayout />;
  }, () => [
    path("/", () => <h1>Welcome</h1>, { name: "home" }),

    layout((ctx) => {
      ctx.use(Breadcrumbs)({ label: "Shop", href: "/shop" });
      return <Outlet />;
    }, () => [
      path("/shop", () => <h1>Shop</h1>, { name: "shop" }),
      path("/shop/:slug", (ctx) => {
        ctx.use(Breadcrumbs)({
          label: ctx.params.slug,
          href: `/shop/${ctx.params.slug}`,
        });
        return <h1>Product: {ctx.params.slug}</h1>;
      }, { name: "shop.product" }),
    ]),
  ]),
]);
```

Navigating to `/shop/widget` produces: `Home / Shop / widget`

## Custom Handles

Create your own handle with `createHandle()`:

```typescript
import { createHandle } from "@rangojs/router";

// Custom collect: last value wins.
export const PageTitle = createHandle<string, string>(
  (segments) => segments.flat().at(-1) ?? "Default Title",
);

// No collect: the DEFAULT is the identity (lossless) — `collect` receives the
// per-segment data (TData[][], one array per segment that pushed, in segment
// order) and passes it through as-is. `useHandle(Warnings)` is `string[][]`, so a
// consumer can tell which/how-many segments contributed.
export const Warnings = createHandle<string>();

// Want a single flat list instead? Opt in:
export const FlatWarnings = createHandle<string, string[]>((segments) =>
  segments.flat(),
);
```

A handle whose module is never imported (so `createHandle()` never ran to register
its collect) falls back to this same identity default and **warns in dev** — a
handle with a custom collect that failed to register would otherwise return the
wrong shape silently, and the runtime can't tell it from one that wanted the default.

The Vite `exposeInternalIds` plugin auto-injects a stable `$$id` based on
file path and export name. No manual naming required for project-local code.

### Handles in 3rd-party packages

The `exposeInternalIds` plugin skips `node_modules/`, so handles defined in
published packages won't get auto-injected IDs. Pass a manual tag as the
second argument to `createHandle()`:

```typescript
import { createHandle } from "@rangojs/router";

// With a collect function (reducer): collect is first arg, tag is second
export const Breadcrumbs = createHandle<BreadcrumbItem, BreadcrumbItem[]>(
  collectBreadcrumbs,
  "__my_package_breadcrumbs__",
);

// Without a collect function: pass undefined, then the tag
export const Warnings = createHandle<string>(
  undefined,
  "__my_package_warnings__",
);
```

The tag must be globally unique and stable across builds. Without it,
`createHandle` throws in development mode.
