import { urls } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";

function StatusPage(_ctx: HandlerContext) {
  return (
    <main data-testid="site-api-status">
      <h1>Site API Status</h1>
      <p data-testid="site-api-status-text">site-ok</p>
    </main>
  );
}

export const siteApiPatterns = urls(({ path }) => [
  path("/status", StatusPage, { name: "status" }),
]);
