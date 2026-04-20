"use client";

import { useTransition } from "react";
import { useParams } from "@rangojs/router/client";
import {
  paramsAfterActionThrow,
  paramsAfterActionThrowForm,
} from "../actions.jsx";

export function ParamsAfterActionErrorTrigger() {
  const params = useParams();
  const [isPending, startTransition] = useTransition();

  return (
    <div data-testid="params-after-action-error-trigger">
      <span data-testid="error-trigger-params-json">
        {JSON.stringify(params)}
      </span>
      <button
        data-testid="params-after-action-throw-btn"
        disabled={isPending}
        onClick={() =>
          startTransition(() => paramsAfterActionThrow().catch(() => {}))
        }
      >
        {isPending ? "Running..." : "Throw Action"}
      </button>
      <form
        action={paramsAfterActionThrowForm}
        data-testid="params-after-action-throw-form"
      >
        <button type="submit" data-testid="params-after-action-throw-pe-submit">
          PE Throw Action
        </button>
      </form>
    </div>
  );
}

export function ParamsAfterActionBoundary() {
  const params = useParams();
  return (
    <div data-testid="params-after-action-error-boundary">
      <span data-testid="error-boundary-params-json">
        {JSON.stringify(params)}
      </span>
      <span data-testid="error-boundary-post-id">
        postId:{params.postId ?? "none"}
      </span>
      <span data-testid="error-boundary-section">
        section:{params.section ?? "none"}
      </span>
    </div>
  );
}
