# Outlet Components

### Outlet / ParallelOutlet

Render child content in layouts. `<Outlet />` renders the matched child
segment; `<ParallelOutlet name="@slot" />` renders a named `parallel()` slot.
Both apply the segment's `loading()` fallback as a Suspense boundary:

```tsx
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function DashboardLayout() {
  return (
    <div className="dashboard">
      <aside>
        <ParallelOutlet name="@sidebar" />
      </aside>
      <main>
        <Outlet />
      </main>
      <ParallelOutlet name="@notifications" />
    </div>
  );
}
```

`<Outlet name="@sidebar" />` is equivalent to `<ParallelOutlet name="@sidebar" />`;
`ParallelOutlet` requires the name and reads clearer at the call site. See
`/layout` and `/parallel` for the server side.

### useOutlet()

Access outlet content and its client-route presentation state programmatically:

```ts
interface OutletState {
  readonly content: ReactNode;
  readonly pending: boolean;
}
```

```tsx
"use client";
import { useOutlet } from "@rangojs/router/client";

function ConditionalLayout() {
  const { content, pending } = useOutlet();

  return content ? (
    <div className="with-content" aria-busy={pending}>
      {content}
    </div>
  ) : (
    <div className="empty">No content</div>
  );
}
```

Migrating from the older API where `useOutlet()` returned the node directly:
destructure `content` and render it where you rendered the hook result.

`pending` is narrow. After hydration, a `clientUrls()` layout receives `true`
while a browser-local match to a different client route beneath it is presenting
optimistic loading or retaining the current branch until canonical partial Flight
settles. It clears on commit, error, redirect, cancellation, or supersession. It
is `false` during SSR and does not describe ordinary server-route navigation,
prefetch, generic Suspense, unrelated actions, or a params/search change that
keeps the same client route record. Use `useNavigation()`, `useLinkStatus()`, or
loader state for those scopes.
