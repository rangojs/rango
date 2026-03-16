---
name: breadcrumbs
description: Built-in Breadcrumbs handle for accumulating breadcrumb navigation across route segments
argument-hint: [setup]
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

// Client component
("use client");
import { useHandle, type Breadcrumbs } from "@rangojs/router/client";

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
