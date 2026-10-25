"use client";

import { useEffect } from "react";
import { useHandle, useLoader } from "@rangojs/router/client";
import { prerenderInterceptAction } from "./prerender-intercept.actions.js";
import {
  PrerenderInterceptHeldLoader,
  PrerenderInterceptLayoutStamp,
} from "./prerender-intercept.defs.js";

/**
 * Inside the layout: counts its mounts (window.__priLayoutMounts) and shows
 * the layout's render stamp as its crumbs.
 */
export function PrerenderInterceptLayoutProbe() {
  const stamps = useHandle(PrerenderInterceptLayoutStamp);
  useEffect(() => {
    const w = window as unknown as { __priLayoutMounts?: number };
    w.__priLayoutMounts = (w.__priLayoutMounts ?? 0) + 1;
  }, []);
  return <p data-testid="pri-layout-crumbs">{stamps.join(",")}</p>;
}

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
