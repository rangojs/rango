import { Outlet } from "@rangojs/router/client";

// Live parent layout - runs at request time, NOT pre-rendered.
// Wraps all /prerender-complex/* routes.
export function PrerenderComplexLayout() {
  return (
    <div data-testid="prerender-complex-layout">
      <Outlet />
    </div>
  );
}
