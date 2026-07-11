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

Access outlet content programmatically:

```tsx
"use client";
import { useOutlet } from "@rangojs/router/client";

function ConditionalLayout() {
  const outlet = useOutlet();
  // ReactNode | null

  return outlet ? (
    <div className="with-content">{outlet}</div>
  ) : (
    <div className="empty">No content</div>
  );
}
```
