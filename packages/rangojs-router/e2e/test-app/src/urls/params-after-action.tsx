import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { ParamsAfterActionClient } from "../components/ParamsAfterActionClient.js";
import {
  ParamsAfterActionBoundary,
  ParamsAfterActionErrorTrigger,
} from "../components/ParamsAfterActionErrorClient.js";

export const paramsAfterActionPatterns = urls(
  ({ path, errorBoundary, layout }) => [
    path(
      "/:postId/section/:section",
      (ctx) => (
        <div data-testid="params-after-action-page">
          <span data-testid="server-params-json">
            {JSON.stringify(ctx.params)}
          </span>
          <ParamsAfterActionClient />
        </div>
      ),
      { name: "show" },
    ),
    layout(
      () => <Outlet />,
      () => [
        errorBoundary(() => <ParamsAfterActionBoundary />),
        path(
          "/error/:postId/section/:section",
          () => (
            <div data-testid="params-after-action-error-page">
              <ParamsAfterActionErrorTrigger />
            </div>
          ),
          { name: "error" },
        ),
      ],
    ),
  ],
);
