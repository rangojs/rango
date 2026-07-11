# Handle and Action Hooks

## Handle Hooks

### useHandle()

Access accumulated handle data from route segments:

```tsx
"use client";
import { useHandle, Breadcrumbs } from "@rangojs/router/client";

function BreadcrumbNav() {
  const crumbs = useHandle(Breadcrumbs);
  // Array of { label, href } accumulated from layouts/routes

  return (
    <nav>
      {crumbs.map((c, i) => (
        <span key={i}>
          <a href={c.href}>{c.label}</a>
          {i < crumbs.length - 1 && " > "}
        </span>
      ))}
    </nav>
  );
}

// With selector
const lastCrumb = useHandle(Breadcrumbs, (data) => data.at(-1));
```

Handles can be passed as props from server to client components:

```tsx
// Server component
path("/dashboard", (ctx) => {
  const push = ctx.use(Breadcrumbs);
  push({ label: "Dashboard", href: "/dashboard" });
  return <DashboardNav handle={Breadcrumbs} />;
});
```

```tsx
// Client component — typeof infers the full Handle<T> type
"use client";
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

RSC serialization strips the `collect` function via `toJSON()`. On the client,
`useHandle()` recovers it from the module-level registry (populated when
`createHandle()` runs during module initialization).

## Action Hooks

For the full server-action guide (defining actions, `useActionState`,
`useOptimistic`, validation, revalidation, error handling, file uploads),
see `/server-actions`. `useAction()` below is a Rango-specific hook for
tracking actions called outside a `<form action={...}>` flow.

### useAction()

Track state of server action invocations:

```tsx
"use client";
import { useAction } from "@rangojs/router/client";
import { addToCart } from "../actions/cart";

function AddToCartButton({ productId }: { productId: string }) {
  const { state, error, result } = useAction(addToCart);

  // state: 'idle' | 'loading' | 'streaming'
  // actionId: string | null
  // payload: unknown | null (input data)
  // error: Error | null
  // result: unknown | null (return value)

  return (
    <form action={addToCart}>
      <input type="hidden" name="productId" value={productId} />
      <button disabled={state === "loading"}>
        {state === "loading" ? "Adding..." : "Add to Cart"}
      </button>
      {error && <p className="error">{error.message}</p>}
    </form>
  );
}

// Match by string suffix (convenient but may be ambiguous)
const isLoading = useAction("addToCart", (s) => s.state === "loading");
```
