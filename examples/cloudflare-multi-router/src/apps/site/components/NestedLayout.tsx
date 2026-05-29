"use client";

import { Outlet } from "@rangojs/router/client";

export function NestedLayout() {
  return (
    <section data-testid="ni-layout">
      <Outlet />
    </section>
  );
}
