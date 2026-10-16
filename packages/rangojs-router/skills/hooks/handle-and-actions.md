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

Writers: handlers AND loader bodies — `ctx.use(Handle)` returns the push
function in each (middleware has no handle APIs). Loader pushes follow a delivery race (settle before
the handler barrier → in the SSR'd document; later → applied client-side), and
`loader(Def, { ssr: false })` makes them deterministic in the
document. On a `ppr` shell HIT, a loader without `ssr: false` never ran during
the capture, so its pushes always apply client-side; with `ssr: false` they
bake into the shell. See `/loader` → "Writing Handles from Loaders". `useHandle`
re-renders on every handle update, late loader pushes included.

### When handle values change (by design)

Handle values are reactive and arrive on their own channel, by design. A value
belongs to the segment that pushed it and reaches `useHandle` when that push
settles. The page never waits for a handle, and a handle never shows the next
page's values over the page being left:

| Case                                                                                                                                       | What `useHandle` returns                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document load                                                                                                                              | The values the HTML was rendered from. `push(promise)` and `.defer()` are awaited during SSR, so the document ships the resolved value. On a `ppr` shell HIT that holds for the handlers' and the `ssr: false` loaders' pushes, which the shell baked; a live-lane loader's push arrives right after hydration (see `/ppr`). |
| Navigation to a page that commits at once (a cold click that mounts new segments)                                                          | The destination's values, in the page's commit; the page's effects read them                                                                                                                                                                                                                                                 |
| Navigation to a page React holds in a transition (`transition()`, same-route search change, fully prefetched click, a handler that awaits) | The page being left keeps its values; the destination's land in the commit right after the page, in the same task, before paint                                                                                                                                                                                              |
| `push(promise)` or `.defer()` on a client navigation                                                                                       | The previous value, then the new one when the promise resolves, possibly well after the page                                                                                                                                                                                                                                 |

You never see a pending value, a blank, or the destination's title over the old
page. A crumb whose `content` is a promise read with `use()` in `<Suspense>`
never holds the page either; only that boundary waits for it.

**What this means for effects.** An effect keyed only on the URL
(`usePathname()`) can run before the destination's values arrive and read the
previous page's value. That is the contract, not a bug. When a reader must tie a
handle value to a page (an analytics `page_view`), put the page's path in the
handle value and key the effect on the value, deduped by path:

```ts
// handles/page-view.ts
import { createHandle } from "@rangojs/router";

export interface PageView {
  path: string;
  title?: string;
}

// Collect the item, not the array of segment arrays.
export const PageView = createHandle<PageView, PageView | undefined>(
  (segments) => segments.flat().at(-1),
);
```

```tsx
// urls: a root slot that re-runs on every navigation
parallel(
  {
    "@pageView": (ctx) => {
      ctx.use(PageView)({ path: ctx.pathname + ctx.url.search });
      return null;
    },
  },
  () => [revalidate(true)],
);
```

```tsx
"use client";
import { useEffect, useRef } from "react";
import { useHandle } from "@rangojs/router/client";
import { PageView } from "./handles/page-view";

export function PageViews() {
  const pv = useHandle(PageView);
  // Seeded with the landing path: the first page_view is sent elsewhere (a
  // bootstrap script). Start from `null` to send it from here instead. The
  // component also renders on the server, where there is no `window`.
  const last = useRef(
    typeof window === "undefined"
      ? null
      : window.location.pathname + window.location.search,
  );
  useEffect(() => {
    if (!pv || pv.path === last.current) return;
    last.current = pv.path;
    gtag("event", "page_view", { page_path: pv.path, page_title: pv.title });
  }, [pv]);
  return null;
}
```

The effect fires once per page, because the value carries its own path: the
previous page's value has the previous path and is skipped, and the destination's
fires when it arrives. Trade-offs:

- Dedupe is by path. Include `ctx.url.search` in `path` if search-only
  navigations count; a same-URL refresh or an action's revalidation re-delivers
  an equal value and sends nothing. Under dev StrictMode the mount effect runs
  twice; the path check covers it.
- Select or collect the item, not an array: `useHandle` keeps its reference
  while the value is equal one level deep, and an array of objects is rebuilt on
  every delivery (an action's included). With the default collector, use
  `useHandle(PageView, (s) => s.at(-1)?.at(-1))`.
- Async values arrive later. With `push(promise)` the page_view fires when the
  promise resolves, with the resolved value; read the title from the value, not
  from `document.title`.
- A page that pushes nothing under its own `PageView` keeps the previous value
  and fires nothing for itself; the root slot above stamps the path on every
  navigation so every route counts.
- Back/Forward fires (the entry's path differs from the current one).

A server component that pushes after an `await` throws `LateHandlePushError`:
reserve the slot in the handler with `ctx.use(Handle).defer()` and resolve it
from the component (`/breadcrumbs`, "Deferred content").

On a document load `useHandle` hydrates with the handle data its HTML was
rendered from, wherever the reader sits; late loader pushes reach every reader
once the document has finished streaming and every boundary has hydrated (see
`SKILL.md`, "Hydration").

Handles can be passed as props from server to client components:

```tsx
// Server component (route handler)
path(
  "/dashboard",
  (ctx) => {
    const push = ctx.use(Breadcrumbs);
    push({ label: "Dashboard", href: "/dashboard" });
    return <DashboardNav handle={Breadcrumbs} />;
  },
  { name: "dashboard" },
);
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
        <a key={c.href} href={c.href}>
          {c.label}
        </a>
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

Track the lifecycle of a server action, wherever on the page it was invoked.
If the same action fires several times, the hook reports the latest call: the
last one to start. When it returns before an earlier call, the hook shows its
result, and the earlier call changes nothing when it settles, a result or an
error alike (that call's own promise still resolves or rejects for its caller).
`useNavigation()` stays `loading` while the earlier call runs.

```tsx
"use client";
import { useAction } from "@rangojs/router/client";
import { addToCart } from "../actions/cart"; // addToCart(productId: string)

function AddToCartButton({ productId }: { productId: string }) {
  const { state, error, result } = useAction(addToCart);

  // state: 'idle' | 'loading' | 'streaming'
  // actionId: string | null
  // payload: unknown[] | FormData | null (the call's arguments)
  // error: unknown | null (whatever the action threw)
  // result: unknown | null (return value)
  // revalidationError: unknown | null (a loader that threw while it reran
  //   after the action; the action succeeded and the loader threw at its
  //   read: /client-urls -> "A loader that fails on its rerun")

  return (
    // .bind keeps the form progressively enhanced; useAction still matches it
    <form action={addToCart.bind(null, productId)}>
      <button disabled={state === "loading"}>
        {state === "loading" ? "Adding..." : "Add to Cart"}
      </button>
      {error instanceof Error && <p className="error">{error.message}</p>}
    </form>
  );
}

// With a selector (re-renders only when the selected value changes)
const isLoading = useAction(addToCart, (s) => s.state === "loading");

// Match by export name (suffix match on "#addToCart"; ambiguous if two
// "use server" files export the same name)
const isAdding = useAction("addToCart", (s) => s.state === "loading");
```

Pass an action imported directly into the client component, or its export
name as a string. An action received as a prop from a server component has
lost the metadata `useAction` needs and throws; use the string form there.
