"use client";

import { useHandle } from "@rangojs/router/client";
import { InterceptCrumbs } from "../urls/intercept-crumbs.handle.js";

// Client consumer that reads the InterceptCrumbs handle. In production the
// intercept artifact is baked at build time, so this value comes from the
// prerender store, not a live handler -- proving the handle data survived the
// artifact (the #567 gap-1 regression guard).
export function InterceptHandleDisplay() {
  const crumbs = useHandle(InterceptCrumbs);
  return <p data-testid="pri-modal-handle">{crumbs.join(",")}</p>;
}
