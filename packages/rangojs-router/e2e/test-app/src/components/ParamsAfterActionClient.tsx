"use client";

import { useTransition } from "react";
import { useParams } from "@rangojs/router/client";
import {
  paramsAfterActionNoop,
  paramsAfterActionNoopForm,
} from "../actions.jsx";

export function ParamsAfterActionClient() {
  const params = useParams();
  const [isPending, startTransition] = useTransition();

  return (
    <div data-testid="params-after-action-client">
      <span data-testid="client-params-json">{JSON.stringify(params)}</span>
      <span data-testid="client-post-id">postId:{params.postId ?? "none"}</span>
      <span data-testid="client-section">
        section:{params.section ?? "none"}
      </span>
      <button
        data-testid="params-after-action-btn"
        disabled={isPending}
        onClick={() => startTransition(() => paramsAfterActionNoop())}
      >
        {isPending ? "Running..." : "Run Action"}
      </button>
      <form
        action={paramsAfterActionNoopForm}
        data-testid="params-after-action-form"
      >
        <button type="submit" data-testid="params-after-action-pe-submit">
          PE Run Action
        </button>
      </form>
    </div>
  );
}
