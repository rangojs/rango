"use client";

import { useLoader } from "@rangojs/router/client";
import { RevalFormDataLoader } from "../loaders.js";
import { revalFormDataAction } from "../actions.js";

/**
 * shouldRevalidate({ formData }) e2e probe (C2). Renders the loader's run
 * counter and two native forms bound directly to the module-level
 * revalFormDataAction (so both work with AND without JS). One submits
 * `reload=yes`, the other `reload=no`. The loader's revalidate predicate reads
 * `formData.get("reload")`, so the counter increments only when the action's
 * FormData reaches the predicate with the clean key — proving formData parity
 * between the JS and PE transports.
 */
export function RevalFormDataProbe() {
  const { data } = useLoader(RevalFormDataLoader);

  return (
    <div>
      <span data-testid="reval-formdata-runs">{data.runs}</span>
      <form action={revalFormDataAction} data-testid="reval-formdata-yes-form">
        <input type="hidden" name="reload" value="yes" />
        <button type="submit" data-testid="reval-formdata-yes-btn">
          Reload Yes
        </button>
      </form>
      <form action={revalFormDataAction} data-testid="reval-formdata-no-form">
        <input type="hidden" name="reload" value="no" />
        <button type="submit" data-testid="reval-formdata-no-btn">
          Reload No
        </button>
      </form>
    </div>
  );
}
