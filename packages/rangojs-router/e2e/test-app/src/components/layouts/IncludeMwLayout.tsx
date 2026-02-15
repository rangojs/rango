import { Outlet } from "@rangojs/router/client";

export function IncludeMwLayout() {
  return (
    <div data-testid="include-mw-layout">
      <p data-testid="include-mw-layout-marker">Layout Active</p>
      <Outlet />
    </div>
  );
}
