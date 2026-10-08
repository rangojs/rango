"use client";

import { Outlet, ParallelOutlet } from "@rangojs/router/client";

export function SlotAncestorLayout() {
  return (
    <section data-testid="slot-ancestor-layout">
      <aside>
        <ParallelOutlet name="@side" />
      </aside>
      <Outlet />
    </section>
  );
}
