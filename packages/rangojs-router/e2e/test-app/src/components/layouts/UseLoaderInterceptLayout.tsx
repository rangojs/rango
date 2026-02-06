import { Outlet } from "@rangojs/router/client";

/**
 * Layout for useLoader intercept testing
 */
export function UseLoaderInterceptLayout() {
  return (
    <div data-testid="useloader-intercept-layout">
      <Outlet />
      <Outlet name="@useLoaderModal" />
    </div>
  );
}
