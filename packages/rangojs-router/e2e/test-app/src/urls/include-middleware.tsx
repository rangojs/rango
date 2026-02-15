import { urls } from "@rangojs/router";
import type { ReactNode } from "react";

/**
 * Routes included under a layout that has middleware.
 * Tests that middleware defined on a parent layout is applied
 * to routes inside an include() — even when include() is the
 * only child of the layout.
 */
export const includeMiddlewarePatterns = urls(({ path }) => [
  path(
    "/",
    (ctx): ReactNode => {
      const layoutMw = ctx.get("includeLayoutMw");
      return (
        <div data-testid="include-mw-index">
          <h1 data-testid="include-mw-title">Include Middleware Test</h1>
          <p data-testid="include-mw-layout-value">
            Layout middleware: {layoutMw ?? "not applied"}
          </p>
        </div>
      );
    },
    { name: "index" },
  ),
  path(
    "/:itemId",
    (ctx): ReactNode => {
      const layoutMw = ctx.get("includeLayoutMw");
      return (
        <div data-testid="include-mw-detail">
          <h1 data-testid="include-mw-detail-title">
            Detail: {ctx.params.itemId}
          </h1>
          <p data-testid="include-mw-detail-layout-value">
            Layout middleware: {layoutMw ?? "not applied"}
          </p>
        </div>
      );
    },
    { name: "detail" },
  ),
]);
