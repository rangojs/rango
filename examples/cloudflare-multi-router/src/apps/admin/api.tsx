import { urls } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";

function StatusPage(_ctx: HandlerContext) {
  return (
    <main data-testid="admin-api-status">
      <h1>Admin API Status</h1>
      <p data-testid="admin-api-status-text">admin-ok</p>
    </main>
  );
}

export const adminApiPatterns = urls(({ path }) => [
  path("/status", StatusPage, { name: "status" }),
]);

// Code-split this group so it loads on the first /api/* request into the admin
// app (which is itself a host-router-mounted sub-router) — exercises an async
// include() INSIDE a host-mounted router.
export default adminApiPatterns;
