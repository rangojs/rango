import { Outlet } from "@rangojs/router/client";

// Pre-rendered child layout - lives inside the prerender path's use() block,
// so it gets pre-rendered at build time alongside the route handler.
export function PrerenderInnerLayout() {
  return (
    <div data-testid="prerender-inner-layout">
      <Outlet />
    </div>
  );
}
