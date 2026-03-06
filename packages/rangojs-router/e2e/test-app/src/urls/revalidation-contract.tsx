import { cookies, createVar, urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { revalidationContractAction } from "../actions.js";

const UpstreamLayoutData = createVar<string>();

/**
 * Revalidation contract fixture:
 * - Full render: child can read upstream layout ctx.set() data.
 * - Action follow-up: child reruns, layout does not.
 * - Result: child sees missing data (`none`), not a retained upstream snapshot.
 *
 * This codifies the contract for producer/consumer revalidation dependencies:
 * if a child depends on outer ctx.set() data, the producer must share the same
 * revalidation contract.
 */
export const revalidationContractPatterns = urls(({ layout, path, revalidate }) => [
  layout(
    (ctx) => {
      ctx.set(UpstreamLayoutData, "from-layout");
      return (
        <div data-testid="revalidation-contract-layout">
          <Outlet />
        </div>
      );
    },
    () => [
      path(
        "/",
        (ctx) => {
          const upstream = ctx.get(UpstreamLayoutData);
          const actionCookie =
            cookies().get("revalidation-contract-action")?.value ?? "none";

          return (
            <div data-testid="revalidation-contract-page">
              <span data-testid="revalidation-contract-upstream">
                {upstream ?? "none"}
              </span>
              <span data-testid="revalidation-contract-action-cookie">
                {actionCookie}
              </span>
              <form
                action={revalidationContractAction}
                data-testid="revalidation-contract-form"
              >
                <button
                  type="submit"
                  data-testid="revalidation-contract-action-btn"
                >
                  Revalidate Child Only
                </button>
              </form>
            </div>
          );
        },
        () => [
          // The child reruns after actions; the layout intentionally does not.
          revalidate(() => true),
        ],
      ),
    ],
  ),
]);
