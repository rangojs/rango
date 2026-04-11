import { urls, createVar } from "@rangojs/router";
import { ActionCtxSetButton } from "../components/ActionCtxSetButton.js";
import { actionSetCtxVarForm } from "../actions.js";

/** Typed context variable token for createVar-based ctx.set/get testing. */
export const ActionCtxTypedVar = createVar<string>();

export const actionCtxSetPatterns = urls(({ path }) => [
  path(
    "/",
    (ctx) => {
      const stringValue = ctx.get("actionCtxValue");
      const typedValue = ctx.get(ActionCtxTypedVar);
      return (
        <div data-testid="action-ctx-set-page">
          <span data-testid="action-ctx-string-value">
            {stringValue ?? "none"}
          </span>
          <span data-testid="action-ctx-typed-value">
            {typedValue ?? "none"}
          </span>
          <ActionCtxSetButton />
          <form action={actionSetCtxVarForm} data-testid="action-ctx-set-form">
            <button type="submit" data-testid="action-ctx-set-pe-submit">
              PE Set Ctx Var
            </button>
          </form>
        </div>
      );
    },
    { name: "index" },
  ),
]);
