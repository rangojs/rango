"use client";

import { useLoader } from "@rangojs/router/client";
import { prerenderInterceptAction } from "./prerender-intercept.actions.js";
import { PrerenderInterceptHeldLoader } from "./prerender-intercept.defs.js";

export function PrerenderInterceptHeldPanel() {
  const { data } = useLoader(PrerenderInterceptHeldLoader);
  return (
    <div>
      <p data-testid="pri-held-runs">{data.runs}</p>
      <button
        data-testid="pri-modal-action"
        onClick={() => void prerenderInterceptAction()}
      >
        Call action
      </button>
    </div>
  );
}
