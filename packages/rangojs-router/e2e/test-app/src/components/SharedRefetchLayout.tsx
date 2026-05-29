import { Outlet } from "@rangojs/router/client";
import { SharedRefetchLayoutWidget } from "./SharedRefetchLayoutWidget.js";

/**
 * Server-component layout shell. The interactive useLoader read +
 * refetch button live in the client widget below.
 */
export function SharedRefetchLayout() {
  return (
    <div data-testid="shared-refetch-layout">
      <SharedRefetchLayoutWidget />
      <Outlet />
    </div>
  );
}
