import { Outlet } from "@rangojs/router/client";

export function PrerenderInterceptLayout() {
  return (
    <div data-testid="prerender-intercept-layout">
      <Outlet />
      <Outlet name="@modal" />
    </div>
  );
}
