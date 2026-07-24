# Outlet Components

### Outlet / ParallelOutlet

Render child content in layouts:

```tsx
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function DashboardLayout({ children }: { children?: React.ReactNode }) {
  return (
    <div className="dashboard">
      <aside>
        <ParallelOutlet name="@sidebar" />
      </aside>
      <main>{children ?? <Outlet />}</main>
      <ParallelOutlet name="@notifications" />
    </div>
  );
}
```

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

Migration from the old bare-node return is `const { content, pending } =
useOutlet()`, then render `content` where you previously rendered the hook result.
`<Outlet />` itself is unchanged.

`pending` is narrow. After hydration, a `clientUrls()` layout receives `true`
while a browser-local match to a different client route beneath it is presenting
optimistic loading or retaining the current branch until canonical partial Flight
settles. It clears on commit, error, redirect, cancellation, or supersession. It
is `false` during SSR and does not describe ordinary server-route navigation,
prefetch, generic Suspense, unrelated actions, or a params/search change that
keeps the same client route record. Use `useNavigation()`, `useLinkStatus()`, or
loader state for those scopes.
