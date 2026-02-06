import { Outlet } from "@rangojs/router/client";

/**
 * Layout for cache intercept testing
 */
export function CacheInterceptLayout() {
  return (
    <div data-testid="cache-intercept-layout">
      <Outlet />
      <Outlet name="@cacheModal" />
    </div>
  );
}
